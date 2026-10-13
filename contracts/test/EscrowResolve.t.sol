// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IEscrow} from "../src/IEscrow.sol";
import {EscrowTestBase} from "./utils/EscrowTestBase.sol";

contract EscrowResolveTest is EscrowTestBase {
    // ---------------------------------------------------------------------------------------------
    // Happy paths: each transition moves the funds to the right party
    // ---------------------------------------------------------------------------------------------

    function test_Cancel_ReturnsFundsToSender() public {
        uint256 id = _create();

        vm.expectEmit(address(escrow));
        emit IEscrow.EscrowCancelled(id);
        _act(Action.Cancel, id);

        _assertStatus(id, IEscrow.Status.CancelledBySender);
        assertEq(token.balanceOf(sender), INITIAL_BALANCE);
        assertEq(token.balanceOf(beneficiary), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_Confirm_SendsFundsToBeneficiary() public {
        uint256 id = _create();

        vm.expectEmit(address(escrow));
        emit IEscrow.EscrowReleased(id);
        _act(Action.Confirm, id);

        _assertStatus(id, IEscrow.Status.Released);
        assertEq(token.balanceOf(sender), INITIAL_BALANCE - AMOUNT);
        assertEq(token.balanceOf(beneficiary), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_Reject_ReturnsFundsToSender() public {
        uint256 id = _create();

        vm.expectEmit(address(escrow));
        emit IEscrow.EscrowRejected(id);
        _act(Action.Reject, id);

        _assertStatus(id, IEscrow.Status.Rejected);
        assertEq(token.balanceOf(sender), INITIAL_BALANCE);
        assertEq(token.balanceOf(beneficiary), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_RecoverExpired_ReturnsFundsToSender() public {
        uint256 id = _create();
        vm.warp(_expiresAt(id));

        vm.expectEmit(address(escrow));
        emit IEscrow.EscrowExpired(id);
        _act(Action.RecoverExpired, id);

        _assertStatus(id, IEscrow.Status.Expired);
        assertEq(token.balanceOf(sender), INITIAL_BALANCE);
        assertEq(token.balanceOf(beneficiary), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_Resolve_KeepsEscrowDataReadable() public {
        uint256 id = _create();
        IEscrow.EscrowView memory before = escrow.getEscrow(id);

        _act(Action.Confirm, id);

        IEscrow.EscrowView memory afterwards = escrow.getEscrow(id);
        assertEq(afterwards.sender, before.sender);
        assertEq(afterwards.beneficiary, before.beneficiary);
        assertEq(afterwards.token, before.token);
        assertEq(afterwards.amount, before.amount);
        assertEq(afterwards.createdAt, before.createdAt);
        assertEq(afterwards.cancelDeadline, before.cancelDeadline);
        assertEq(afterwards.expiresAt, before.expiresAt);
    }

    // ---------------------------------------------------------------------------------------------
    // Access control: only the right party can act, not even the deployer
    // ---------------------------------------------------------------------------------------------

    function test_RevertWhen_CancelIsNotCalledBySender() public {
        uint256 id = _create();
        address[3] memory callers = [beneficiary, stranger, address(this)];

        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IEscrow.NotSender.selector, id, callers[i]));
            _actAs(callers[i], Action.Cancel, id);
        }
    }

    function test_RevertWhen_ConfirmIsNotCalledByBeneficiary() public {
        uint256 id = _create();
        address[3] memory callers = [sender, stranger, address(this)];

        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IEscrow.NotBeneficiary.selector, id, callers[i]));
            _actAs(callers[i], Action.Confirm, id);
        }
    }

    function test_RevertWhen_RejectIsNotCalledByBeneficiary() public {
        uint256 id = _create();
        address[3] memory callers = [sender, stranger, address(this)];

        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IEscrow.NotBeneficiary.selector, id, callers[i]));
            _actAs(callers[i], Action.Reject, id);
        }
    }

    function test_RevertWhen_RecoverExpiredIsNotCalledBySender() public {
        uint256 id = _create();
        vm.warp(_expiresAt(id));
        address[3] memory callers = [beneficiary, stranger, address(this)];

        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IEscrow.NotSender.selector, id, callers[i]));
            _actAs(callers[i], Action.RecoverExpired, id);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // A resolved escrow can never be touched again: 4 final statuses x 4 actions
    // ---------------------------------------------------------------------------------------------

    function test_RevertWhen_ActingOnResolvedEscrow() public {
        IEscrow.Status[4] memory statuses = _finalStatuses();
        Action[4] memory actions = _actions();

        for (uint256 s; s < statuses.length; ++s) {
            uint256 id = _createResolved(statuses[s]);
            uint256 escrowBalance = token.balanceOf(address(escrow));

            for (uint256 a; a < actions.length; ++a) {
                vm.expectRevert(abi.encodeWithSelector(IEscrow.NotPending.selector, id, statuses[s]));
                _act(actions[a], id);
            }

            _assertStatus(id, statuses[s]);
            assertEq(token.balanceOf(address(escrow)), escrowBalance);
        }
    }

    function test_RevertWhen_ActingOnNonexistentEscrow() public {
        _create();
        uint256[2] memory ids = [uint256(0), 2];
        Action[4] memory actions = _actions();

        for (uint256 i; i < ids.length; ++i) {
            for (uint256 a; a < actions.length; ++a) {
                vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowNotFound.selector, ids[i]));
                _act(actions[a], ids[i]);
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Order of checks: existence and status, then caller, then time window
    // ---------------------------------------------------------------------------------------------

    function test_RevertWhen_WrongCallerOnResolvedEscrow_ReportsNotPending() public {
        uint256 id = _createResolved(IEscrow.Status.Released);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.NotPending.selector, id, IEscrow.Status.Released));
        _actAs(stranger, Action.Cancel, id);
    }

    function test_RevertWhen_WrongCallerOutsideWindow_ReportsCaller() public {
        uint256 id = _create();
        vm.warp(_expiresAt(id));

        vm.expectRevert(abi.encodeWithSelector(IEscrow.NotSender.selector, id, stranger));
        _actAs(stranger, Action.Cancel, id);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.NotBeneficiary.selector, id, stranger));
        _actAs(stranger, Action.Confirm, id);
    }

    // ---------------------------------------------------------------------------------------------
    // Isolation: resolving one escrow does not affect the others
    // ---------------------------------------------------------------------------------------------

    function test_Resolve_DoesNotAffectOtherEscrows() public {
        address otherSender = makeAddr("otherSender");
        _fund(address(token), otherSender);

        uint256 confirmed = _create();
        uint256 cancelled = _create();
        vm.prank(otherSender);
        uint256 untouched = escrow.createEscrow(address(token), beneficiary, 2 * AMOUNT);

        _act(Action.Confirm, confirmed);
        _act(Action.Cancel, cancelled);

        _assertStatus(untouched, IEscrow.Status.Pending);
        assertEq(escrow.getEscrow(untouched).amount, 2 * AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 2 * AMOUNT);

        vm.prank(beneficiary);
        escrow.confirm(untouched);
        assertEq(token.balanceOf(beneficiary), 3 * AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
    }
}
