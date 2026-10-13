// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IEscrow} from "../src/IEscrow.sol";
import {EscrowTestBase} from "./utils/EscrowTestBase.sol";

/// @dev Windows are half-open: an action is allowed while `block.timestamp < deadline`. Every
///      boundary is tested one second before, exactly at, and one second after the deadline.
contract EscrowTimeWindowsTest is EscrowTestBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        // Start from a realistic timestamp rather than Foundry's default of 1.
        vm.warp(1_760_000_000);
        id = _create();
    }

    function test_Deadlines_AreDerivedFromCreation() public view {
        assertEq(_createdAt(id), 1_760_000_000);
        assertEq(_cancelDeadline(id), 1_760_000_000 + 2 hours);
        assertEq(_expiresAt(id), 1_760_000_000 + 7 days);
    }

    // ---------------------------------------------------------------------------------------------
    // Cancel: sender, before creation + 2 hours
    // ---------------------------------------------------------------------------------------------

    function test_Cancel_SucceedsInCreationBlock() public {
        _act(Action.Cancel, id);
        _assertStatus(id, IEscrow.Status.CancelledBySender);
    }

    function test_Cancel_SucceedsOneSecondBeforeCancelDeadline() public {
        vm.warp(_cancelDeadline(id) - 1);
        _act(Action.Cancel, id);
        _assertStatus(id, IEscrow.Status.CancelledBySender);
    }

    function test_RevertWhen_CancelAtCancelDeadline() public {
        uint64 deadline = _cancelDeadline(id);
        vm.warp(deadline);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.CancelWindowClosed.selector, id, deadline));
        _act(Action.Cancel, id);
    }

    function test_RevertWhen_CancelOneSecondAfterCancelDeadline() public {
        uint64 deadline = _cancelDeadline(id);
        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.CancelWindowClosed.selector, id, deadline));
        _act(Action.Cancel, id);
    }

    function test_RevertWhen_CancelAfterExpiration() public {
        uint64 deadline = _cancelDeadline(id);
        vm.warp(_expiresAt(id));

        vm.expectRevert(abi.encodeWithSelector(IEscrow.CancelWindowClosed.selector, id, deadline));
        _act(Action.Cancel, id);
    }

    // ---------------------------------------------------------------------------------------------
    // Confirm: beneficiary, before creation + 7 days (also within the cancel window)
    // ---------------------------------------------------------------------------------------------

    function test_Confirm_SucceedsInCreationBlock() public {
        _act(Action.Confirm, id);
        _assertStatus(id, IEscrow.Status.Released);
    }

    function test_Confirm_SucceedsAfterCancelWindow() public {
        vm.warp(_cancelDeadline(id));
        _act(Action.Confirm, id);
        _assertStatus(id, IEscrow.Status.Released);
    }

    function test_Confirm_SucceedsOneSecondBeforeExpiration() public {
        vm.warp(_expiresAt(id) - 1);
        _act(Action.Confirm, id);
        _assertStatus(id, IEscrow.Status.Released);
    }

    function test_RevertWhen_ConfirmAtExpiration() public {
        uint64 expiresAt = _expiresAt(id);
        vm.warp(expiresAt);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowHasExpired.selector, id, expiresAt));
        _act(Action.Confirm, id);
    }

    function test_RevertWhen_ConfirmOneSecondAfterExpiration() public {
        uint64 expiresAt = _expiresAt(id);
        vm.warp(expiresAt + 1);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowHasExpired.selector, id, expiresAt));
        _act(Action.Confirm, id);
    }

    // ---------------------------------------------------------------------------------------------
    // Reject: beneficiary, before creation + 7 days (also within the cancel window)
    // ---------------------------------------------------------------------------------------------

    function test_Reject_SucceedsInCreationBlock() public {
        _act(Action.Reject, id);
        _assertStatus(id, IEscrow.Status.Rejected);
    }

    function test_Reject_SucceedsAfterCancelWindow() public {
        vm.warp(_cancelDeadline(id));
        _act(Action.Reject, id);
        _assertStatus(id, IEscrow.Status.Rejected);
    }

    function test_Reject_SucceedsOneSecondBeforeExpiration() public {
        vm.warp(_expiresAt(id) - 1);
        _act(Action.Reject, id);
        _assertStatus(id, IEscrow.Status.Rejected);
    }

    function test_RevertWhen_RejectAtExpiration() public {
        uint64 expiresAt = _expiresAt(id);
        vm.warp(expiresAt);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowHasExpired.selector, id, expiresAt));
        _act(Action.Reject, id);
    }

    function test_RevertWhen_RejectOneSecondAfterExpiration() public {
        uint64 expiresAt = _expiresAt(id);
        vm.warp(expiresAt + 1);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowHasExpired.selector, id, expiresAt));
        _act(Action.Reject, id);
    }

    // ---------------------------------------------------------------------------------------------
    // Recover: sender, from creation + 7 days on
    // ---------------------------------------------------------------------------------------------

    function test_RevertWhen_RecoverInCreationBlock() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.NotExpiredYet.selector, id, _expiresAt(id)));
        _act(Action.RecoverExpired, id);
    }

    function test_RevertWhen_RecoverOneSecondBeforeExpiration() public {
        uint64 expiresAt = _expiresAt(id);
        vm.warp(expiresAt - 1);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.NotExpiredYet.selector, id, expiresAt));
        _act(Action.RecoverExpired, id);
    }

    function test_RecoverExpired_SucceedsAtExpiration() public {
        vm.warp(_expiresAt(id));
        _act(Action.RecoverExpired, id);
        _assertStatus(id, IEscrow.Status.Expired);
    }

    function test_RecoverExpired_SucceedsOneSecondAfterExpiration() public {
        vm.warp(_expiresAt(id) + 1);
        _act(Action.RecoverExpired, id);
        _assertStatus(id, IEscrow.Status.Expired);
    }

    function test_RecoverExpired_SucceedsLongAfterExpiration() public {
        vm.warp(_expiresAt(id) + 365 days);
        _act(Action.RecoverExpired, id);
        _assertStatus(id, IEscrow.Status.Expired);
    }
}
