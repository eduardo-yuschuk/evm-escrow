// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {VmSafe} from "forge-std/Vm.sol";

import {Escrow} from "../src/Escrow.sol";
import {EscrowTestBase} from "./utils/EscrowTestBase.sol";

/// @dev Gas benchmark: one scenario per test, each ending in the call it measures. The gas of that call
///      is written to `snapshots/EscrowGasTest.json` on every `forge test` run, so any change shows up
///      in the diff. The values match `gasUsed` of the same transactions sent to Anvil (see docs/gas.md).
///      `forge coverage` runs these tests too but does not write the snapshot (see `_snapshotGas`).
///
///      Steady state: the escrow already holds other escrows of the token, and the recipient of each
///      withdrawal already holds the token, so no balance goes from or to zero.
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
        _snapshotGas("createEscrow (first escrow of the contract)");
    }

    function test_Gas_CreateEscrow() public {
        _create();
        _snapshotGas("createEscrow");
    }

    function test_Gas_Cancel() public {
        _act(Action.Cancel, 1);
        _snapshotGas("cancel");
    }

    function test_Gas_Confirm() public {
        _act(Action.Confirm, 1);
        _snapshotGas("confirm");
    }

    function test_Gas_Reject() public {
        _act(Action.Reject, 1);
        _snapshotGas("reject");
    }

    function test_Gas_RecoverExpired() public {
        vm.warp(block.timestamp + TTL);
        _act(Action.RecoverExpired, 1);
        _snapshotGas("recoverExpired");
    }

    function test_Gas_Withdraw() public {
        _act(Action.Confirm, 1);
        _withdraw(1, AMOUNT, AMOUNT);
        _snapshotGas("withdraw");
    }

    function test_Gas_Withdraw_BeneficiaryWithoutBalance() public {
        address newBeneficiary = makeAddr("newBeneficiary");
        vm.prank(sender);
        uint256 id = escrow.createEscrow(address(token), newBeneficiary, AMOUNT);
        vm.prank(newBeneficiary);
        escrow.confirm(id);

        _withdraw(id, AMOUNT, AMOUNT);
        _snapshotGas("withdraw (beneficiary without balance)");
    }

    function test_Gas_Withdraw_SecondPart() public {
        _act(Action.Confirm, 1);
        _withdraw(1, AMOUNT / 2, AMOUNT / 2);
        _withdraw(1, AMOUNT / 2, AMOUNT / 2);
        _snapshotGas("withdraw (second part)");
    }

    /// @dev `forge coverage` builds without the optimizer, so its gas would overwrite the snapshot with
    ///      values that no deployment pays.
    function _snapshotGas(string memory name) internal {
        if (vm.isContext(VmSafe.ForgeContext.Coverage)) return;
        vm.snapshotGasLastFrame(name);
    }
}
