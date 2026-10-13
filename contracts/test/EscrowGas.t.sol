// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Escrow} from "../src/Escrow.sol";
import {EscrowTestBase} from "./utils/EscrowTestBase.sol";

/// @dev Gas benchmark: one scenario per test, each ending in the call it measures. The gas of that call
///      is written to `snapshots/EscrowGasTest.json` on every `forge test` run, so any change shows up
///      in the diff. The values match `gasUsed` of the same transactions sent to Anvil (see docs/gas.md).
///
///      Steady state: the escrow already holds other escrows of the token, and the recipient of each
///      payout already holds the token, so no balance goes from or to zero.
contract EscrowGasTest is EscrowTestBase {
    function setUp() public override {
        super.setUp();
        vm.warp(1_760_000_000);
        // Other escrows already in the contract, and a beneficiary that already holds the token.
        _create();
        _create();
        token.mint(beneficiary, 1);
    }

    function test_Gas_CreateEscrow_FirstEscrowOfContract() public {
        Escrow fresh = new Escrow(CANCEL_WINDOW, TTL);
        vm.prank(sender);
        token.approve(address(fresh), type(uint256).max);

        vm.prank(sender);
        fresh.createEscrow(address(token), beneficiary, AMOUNT);
        vm.snapshotGasLastFrame("createEscrow (first escrow of the contract)");
    }

    function test_Gas_CreateEscrow() public {
        _create();
        vm.snapshotGasLastFrame("createEscrow");
    }

    function test_Gas_Cancel() public {
        _act(Action.Cancel, 1);
        vm.snapshotGasLastFrame("cancel");
    }

    function test_Gas_Confirm() public {
        _act(Action.Confirm, 1);
        vm.snapshotGasLastFrame("confirm");
    }

    function test_Gas_Confirm_BeneficiaryWithoutBalance() public {
        address newBeneficiary = makeAddr("newBeneficiary");
        vm.prank(sender);
        uint256 id = escrow.createEscrow(address(token), newBeneficiary, AMOUNT);

        vm.prank(newBeneficiary);
        escrow.confirm(id);
        vm.snapshotGasLastFrame("confirm (beneficiary without balance)");
    }

    function test_Gas_Reject() public {
        _act(Action.Reject, 1);
        vm.snapshotGasLastFrame("reject");
    }

    function test_Gas_RecoverExpired() public {
        vm.warp(block.timestamp + TTL);
        _act(Action.RecoverExpired, 1);
        vm.snapshotGasLastFrame("recoverExpired");
    }
}
