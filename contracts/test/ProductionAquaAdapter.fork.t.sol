// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketRebalancer, PoolKey} from "../src/MarketRebalancer.sol";
import {ISwapVMVenue, IFleetAquaMaker} from "../src/SwapVMVenue.sol";

interface IProductionRegistry {
    function vaultForAsset(address token) external view returns (address);
}

interface IProductionMaker {
    function registry() external view returns (address);
}

interface IProductionVMQuote {
    function quote(ISwapVMVenue.Order calldata, address, address, uint256, bytes calldata)
        external
        view
        returns (uint256, uint256, bytes32);
}

interface IProductionV3 {
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

interface IProductionQuoter {
    struct Input {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }
    function quoteExactInputSingle(Input calldata) external returns (uint256, uint160, uint32, uint256);
}

interface IProductionAqua {
    function safeBalances(address, address, bytes32, address, address) external view returns (uint256, uint256);
}

/// Uses the ACTUAL deployed Aqua0 maker and vaults. Only local bot/test-trader balances are seeded.
/// Profitable cycles additionally displace the real external pool through a local test swap.
contract ProductionAquaAdapterForkTest is Test {
    address router;
    address aqua;
    address maker;
    address token0;
    address token1;
    address externalPool;
    address vault0;
    address vault1;
    bytes32 strategyId;
    bytes32 orderHash;
    uint256 classId;
    uint24 fee;
    MarketRebalancer bot;
    IProductionQuoter quoter;
    ISwapVMVenue.Order order;
    bool private displacing;
    uint256 private callbackBudget;
    address private callbackToken;
    uint256 constant INPUT = 1e6;
    bytes32 constant SOLD = keccak256("StrategyPrincipalSold(address,uint256,address,uint256)");
    bytes32 constant SETTLED = keccak256("ClassVenueSettled(address,uint256,address,int256)");

    function setUp() public {
        string memory cfg = vm.readFile("config/production-maker-fork.json");
        vm.createSelectFork(
            vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")), vm.parseJsonUint(cfg, ".block")
        );
        assertEq(block.chainid, 8453);
        router = vm.parseJsonAddress(cfg, ".router");
        aqua = vm.parseJsonAddress(cfg, ".aqua");
        maker = vm.parseJsonAddress(cfg, ".maker");
        token0 = vm.parseJsonAddress(cfg, ".token0");
        token1 = vm.parseJsonAddress(cfg, ".token1");
        externalPool = vm.parseJsonAddress(cfg, ".externalPool");
        strategyId = vm.parseJsonBytes32(cfg, ".strategyId");
        orderHash = vm.parseJsonBytes32(cfg, ".orderHash");
        classId = vm.parseJsonUint(cfg, ".classId");
        fee = uint24(vm.parseJsonUint(cfg, ".externalFee"));
        quoter = IProductionQuoter(vm.parseJsonAddress(cfg, ".quoter"));
        order = ISwapVMVenue.Order(
            maker, vm.parseUint(vm.parseJsonString(cfg, ".traits")), vm.parseJsonBytes(cfg, ".program")
        );
        assertEq(maker.codehash, vm.parseJsonBytes32(cfg, ".makerCodeHash"));
        assertEq(IFleetAquaMaker(maker).currentAquaHash(strategyId), orderHash);
        assertEq(ISwapVMVenue(router).hash(order), orderHash);
        assertEq(IFleetAquaMaker(maker).strategyClassId(strategyId), classId);
        assertEq(IFleetAquaMaker(maker).aquaSwapVMRouter(), router);
        address registry = IProductionMaker(maker).registry();
        vault0 = IProductionRegistry(registry).vaultForAsset(token0);
        vault1 = IProductionRegistry(registry).vaultForAsset(token1);
        assertGt(vault0.code.length, 0);
        assertGt(vault1.code.length, 0);
        emit log_named_address("Production maker", maker);
        emit log_named_address("Input vault", vault0);
        emit log_named_address("Output vault", vault1);
        bot = new MarketRebalancer(
            address(this),
            vm.parseJsonAddress(cfg, ".universalRouter"),
            vm.parseJsonAddress(cfg, ".permit2"),
            vm.parseJsonAddress(cfg, ".hook"),
            false
        );
        bot.setOperator(address(this), true);
        bot.setLimits(token0, 5e6, 1);
        bot.setLimits(token1, 5e6, 1);
        bot.setGasPriceLimit(100 gwei);
        bot.setV3Pool(externalPool, true);
        bot.setSwapVMRouter(router, aqua, 10, true);
        bot.setSwapVMStrategy(router, maker, strategyId, true);
        bot.setPaused(false);
        deal(token0, address(bot), 5e6);
        deal(token1, address(bot), 5e6);
    }

    function taker(uint256 floor) internal pure returns (bytes memory data) {
        data = new bytes(20);
        for (uint256 i; i < 10; i++) {
            data[2 * i + 1] = bytes1(uint8(32));
        }
        data = bytes.concat(data, hex"0041", abi.encode(floor));
    }

    function quoteVM(address input, address output, uint256 amount) internal view returns (uint256 out) {
        (uint256 used, uint256 result, bytes32 hash) = IProductionVMQuote(router)
            .quote(order, input, output, amount, abi.encodePacked(new bytes(20), uint16(0x0041)));
        assertEq(used, amount);
        assertEq(hash, orderHash);
        assertGt(result, 0);
        return result;
    }

    function checkVaultEvents(Vm.Log[] memory logs, address outputVault, address inputVault, uint256 out, uint256 input)
        internal
        pure
    {
        uint256 sold;
        uint256 outSettlements;
        uint256 inSettlements;
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.topics.length != 4) continue;
            if (l.emitter == outputVault && l.topics[0] == SOLD) sold += abi.decode(l.data, (uint256));
            if (l.topics[0] == SETTLED) {
                int256 delta = abi.decode(l.data, (int256));
                if (l.emitter == outputVault && delta < 0) outSettlements += uint256(-delta);
                if (l.emitter == inputVault && delta > 0) inSettlements += uint256(delta);
            }
        }
        assertEq(sold, out, "Actual per-LP principal sales must equal delivered output");
        assertEq(outSettlements, out);
        assertEq(inSettlements, input);
    }

    function direct(bool zeroForOne) internal {
        address input = zeroForOne ? token0 : token1;
        address output = zeroForOne ? token1 : token0;
        address iv = zeroForOne ? vault0 : vault1;
        address ov = zeroForOne ? vault1 : vault0;
        uint256 expected = quoteVM(input, output, INPUT);
        uint256 beforeOut = IERC20(output).balanceOf(address(bot));
        uint256 beforeIn = IERC20(input).balanceOf(address(bot));
        uint256 inVault = IERC20(input).balanceOf(iv);
        uint256 outVault = IERC20(output).balanceOf(ov);
        vm.prank(address(bot));
        IERC20(input).approve(router, INPUT);
        vm.recordLogs();
        vm.prank(address(bot));
        (uint256 used, uint256 out, bytes32 hash) =
            ISwapVMVenue(router).swap(order, input, output, INPUT, taker(expected));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(used, INPUT);
        assertEq(out, expected);
        assertEq(hash, orderHash);
        assertEq(IERC20(input).balanceOf(address(bot)), beforeIn - INPUT);
        assertEq(IERC20(output).balanceOf(address(bot)), beforeOut + out);
        assertEq(IERC20(input).balanceOf(iv), inVault + INPUT);
        assertEq(IERC20(output).balanceOf(ov), outVault - out);
        assertEq(IERC20(input).allowance(address(bot), router), 0);
        assertEq(IERC20(output).allowance(maker, aqua), 0);
        assertEq(IERC20(input).allowance(maker, iv), 0);
        checkVaultEvents(logs, ov, iv, out, INPUT);
        emit log_named_uint("Actual input", INPUT);
        emit log_named_uint("Actual output", out);
    }

    function testFork_ActualProductionVaults_USDCToUSDT() public {
        direct(true);
    }

    function testFork_ActualProductionVaults_USDTToUSDC() public {
        direct(false);
    }

    function displace(bool zeroForOne) internal {
        callbackToken = zeroForOne ? token0 : token1;
        callbackBudget = 100_000e6;
        deal(callbackToken, address(this), callbackBudget);
        displacing = true;
        IProductionV3(externalPool)
            .swap(
                address(this),
                zeroForOne,
                int256(callbackBudget),
                zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341),
                bytes("")
            );
        displacing = false;
        callbackBudget = 0;
        callbackToken = address(0);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(displacing && msg.sender == externalPool);
        uint256 amount = uint256(d0 > 0 ? d0 : d1);
        require(amount <= callbackBudget);
        callbackBudget -= amount;
        IERC20(callbackToken).transfer(msg.sender, amount);
    }

    function cycle(bool aquaFirst) internal returns (MarketRebalancer.Trade memory t) {
        // Synthetic price movement is ONLY on the external venue. Production strategy and vault state are not fabricated.
        displace(aquaFirst);
        uint256 firstOut;
        uint256 finalOut;
        if (aquaFirst) {
            firstOut = quoteVM(token0, token1, INPUT);
            (finalOut,,,) = quoter.quoteExactInputSingle(IProductionQuoter.Input(token1, token0, firstOut, fee, 0));
        } else {
            (firstOut,,,) = quoter.quoteExactInputSingle(IProductionQuoter.Input(token0, token1, INPUT, fee, 0));
            finalOut = quoteVM(token1, token0, firstOut);
        }
        emit log_named_uint("Round trip quoted output", finalOut);
        require(finalOut > INPUT, "Displaced route must actually quote a profit");
        PoolKey memory empty;
        t.id = keccak256(abi.encode("production-maker-local-test", aquaFirst));
        t.deadline = block.timestamp + 60;
        t.validUntilBlock = block.number + 2;
        t.minProfit = 1;
        t.first = MarketRebalancer.Leg(
            aquaFirst ? MarketRebalancer.Venue.AquaSwapVM : MarketRebalancer.Venue.V3,
            aquaFirst ? router : externalPool,
            token0,
            token1,
            INPUT,
            firstOut,
            empty,
            aquaFirst ? abi.encode(strategyId, order) : bytes("")
        );
        t.second = MarketRebalancer.Leg(
            aquaFirst ? MarketRebalancer.Venue.V3 : MarketRebalancer.Venue.AquaSwapVM,
            aquaFirst ? externalPool : router,
            token1,
            token0,
            firstOut,
            finalOut,
            empty,
            aquaFirst ? bytes("") : abi.encode(strategyId, order)
        );
    }

    function profitable(bool aquaFirst) internal {
        MarketRebalancer.Trade memory t = cycle(aquaFirst);
        uint256 beforeBalance = IERC20(token0).balanceOf(address(bot));
        vm.recordLogs();
        uint256 profit = bot.execute(t);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(profit, 0);
        assertEq(IERC20(token0).balanceOf(address(bot)), beforeBalance + profit);
        assertTrue(bot.used(t.id));
        checkVaultEvents(
            logs,
            aquaFirst ? vault1 : vault0,
            aquaFirst ? vault0 : vault1,
            aquaFirst ? t.second.amountIn : t.second.minOut,
            aquaFirst ? INPUT : t.second.amountIn
        );
        assertEq(IERC20(token0).allowance(address(bot), router), 0);
        assertEq(IERC20(token1).allowance(address(bot), router), 0);
        emit log_named_uint("Actual guarded profit", profit);
    }

    function testFork_ProductionMakerThenExternalV3_AtomicProfit() public {
        profitable(true);
    }

    function testFork_ExternalV3ThenProductionMaker_AtomicProfit() public {
        profitable(false);
    }

    function testFork_ProductionMaker_LosingCycleRestoresVaultsAndVirtualBalances() public {
        MarketRebalancer.Trade memory t = cycle(true);
        uint256 b0 = IERC20(token0).balanceOf(vault0);
        uint256 b1 = IERC20(token1).balanceOf(vault1);
        (uint256 v0, uint256 v1) = IProductionAqua(aqua).safeBalances(maker, router, orderHash, token0, token1);
        t.minProfit = type(uint128).max;
        vm.expectRevert(MarketRebalancer.Unprofitable.selector);
        bot.execute(t);
        assertEq(IERC20(token0).balanceOf(vault0), b0);
        assertEq(IERC20(token1).balanceOf(vault1), b1);
        assertEq(IERC20(token0).balanceOf(address(bot)), 5e6);
        (uint256 a0, uint256 a1) = IProductionAqua(aqua).safeBalances(maker, router, orderHash, token0, token1);
        assertEq(a0, v0);
        assertEq(a1, v1);
        assertFalse(bot.used(t.id));
    }
}
