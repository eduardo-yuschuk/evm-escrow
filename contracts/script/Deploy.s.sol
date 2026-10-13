// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Escrow} from "../src/Escrow.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/// @notice Deploys the Escrow and writes `deployments/<chainId>.json`, which the indexer reads.
/// @dev Usage:
///
///      forge script script/Deploy.s.sol --rpc-url <url> --broadcast --private-key <key>
///
///      Optional environment variables:
///      - ESCROW_CANCEL_WINDOW: seconds, 2 hours by default
///      - ESCROW_TTL: seconds, 7 days by default
///      - DEPLOY_MOCK_TOKEN: also deploy a MockERC20 and mint to the Anvil accounts; by default only
///        on the Anvil chain id
contract Deploy is Script {
    uint256 internal constant ANVIL_CHAIN_ID = 31337;
    /// @dev Anvil's default mnemonic: its keys are public and only meant for local development.
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    uint32 internal constant ANVIL_ACCOUNTS = 10;
    uint256 internal constant MINT_AMOUNT = 1_000_000e18;

    function run() external returns (Escrow escrow, MockERC20 token) {
        uint64 cancelWindow = SafeCast.toUint64(vm.envOr("ESCROW_CANCEL_WINDOW", uint256(2 hours)));
        uint64 ttl = SafeCast.toUint64(vm.envOr("ESCROW_TTL", uint256(7 days)));
        bool deployMockToken = vm.envOr("DEPLOY_MOCK_TOKEN", block.chainid == ANVIL_CHAIN_ID);

        // Last block before the deployment, which lands in a later block: the indexer starts here
        // without missing any event, and the block hash tells this chain apart from a restarted one.
        // `blockhash` returns zero for the current block, so the hash comes from the header.
        uint256 startBlock = block.number;
        bytes32 startBlockHash = keccak256(vm.getRawBlockHeader(startBlock));

        address[] memory holders = new address[](deployMockToken ? ANVIL_ACCOUNTS : 0);
        for (uint32 i; i < holders.length; ++i) {
            holders[i] = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, i));
        }

        vm.startBroadcast();
        escrow = new Escrow(cancelWindow, ttl);
        if (deployMockToken) {
            token = new MockERC20();
            for (uint256 i; i < holders.length; ++i) {
                token.mint(holders[i], MINT_AMOUNT);
            }
        }
        vm.stopBroadcast();

        console.log("Escrow:", address(escrow));
        console.log("Token: ", address(token));

        // A dry run (without --broadcast) deploys nothing, so it must not leave a deployment file.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console.log("Dry run: deployments file not written");
            return (escrow, token);
        }

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "escrow", address(escrow));
        vm.serializeAddress(key, "token", address(token));
        vm.serializeUint(key, "cancelWindow", cancelWindow);
        vm.serializeUint(key, "ttl", ttl);
        vm.serializeUint(key, "startBlock", startBlock);
        string memory json = vm.serializeBytes32(key, "startBlockHash", startBlockHash);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.createDir("deployments", true);
        vm.writeJson(json, path);
        console.log("Deployment written to", path);
    }
}
