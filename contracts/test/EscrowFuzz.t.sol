// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Escrow} from "../src/Escrow.sol";
import {IEscrow} from "../src/IEscrow.sol";
import {FeeOnTransferERC20} from "./mocks/FeeOnTransferERC20.sol";
import {EscrowTestBase} from "./utils/EscrowTestBase.sol";

/// @dev Property-based versions of the unit tests: random amounts, fees, creation timestamps and
///      elapsed times. Every time window is checked against the rule in `IEscrow`, not against
///      hand-picked boundaries.
contract EscrowFuzzTest is EscrowTestBase {
    /// @dev Upper bound for random creation timestamps (year ~36,800), far from the uint64 limit.
    uint256 internal constant MAX_START = 2 ** 40;

    // ---------------------------------------------------------------------------------------------
    // Constructor and creation
    // ---------------------------------------------------------------------------------------------

    function testFuzz_Constructor_AcceptsOnlyValidWindows(uint64 cancelWindow, uint64 ttl) public {
        if (cancelWindow == 0 || cancelWindow >= ttl) {
            vm.expectRevert(abi.encodeWithSelector(IEscrow.InvalidWindows.selector, cancelWindow, ttl));
            new Escrow(cancelWindow, ttl);
        } else {
            Escrow custom = new Escrow(cancelWindow, ttl);
            assertEq(custom.CANCEL_WINDOW(), cancelWindow);
            assertEq(custom.TTL(), ttl);
        }
    }

    function testFuzz_Create_RecordsAmountAndDeadlines(uint256 amount, uint256 start) public {
        amount = bound(amount, 1, INITIAL_BALANCE);
        uint256 id = _createAt(start, amount);

        IEscrow.EscrowView memory e = escrow.getEscrow(id);
        assertEq(e.amount, amount);
        assertEq(e.createdAt, block.timestamp);
        assertEq(e.cancelDeadline, block.timestamp + CANCEL_WINDOW);
        assertEq(e.expiresAt, block.timestamp + TTL);
        assertEq(token.balanceOf(sender), INITIAL_BALANCE - amount);
        assertEq(token.balanceOf(address(escrow)), amount);
    }

    function testFuzz_FeeToken_RecordsAndPaysOutAmountReceived(uint256 feeBps, uint256 amount) public {
        feeBps = bound(feeBps, 0, 10_000);
        amount = bound(amount, 1, INITIAL_BALANCE);
        FeeOnTransferERC20 feeToken = new FeeOnTransferERC20(feeBps);
        _fund(address(feeToken), sender);
        uint256 received = amount - amount * feeBps / 10_000;

        if (received == 0) {
            vm.expectRevert(IEscrow.NothingReceived.selector);
            _create(address(feeToken), amount);
            return;
        }

        uint256 id = _create(address(feeToken), amount);
        assertEq(escrow.getEscrow(id).amount, received);
        assertEq(feeToken.balanceOf(address(escrow)), received);

        // The payout takes exactly the recorded amount out of the escrow; the fee is paid by the recipient.
        _act(Action.Confirm, id);
        assertEq(feeToken.balanceOf(address(escrow)), 0);
        assertEq(feeToken.balanceOf(beneficiary), received - received * feeBps / 10_000);
    }

    // ---------------------------------------------------------------------------------------------
    // Time windows: each action succeeds if and only if its window is open
    // ---------------------------------------------------------------------------------------------

    function testFuzz_Cancel_OnlyBeforeCancelDeadline(uint256 start, uint256 elapsed) public {
        uint256 id = _createAt(start, AMOUNT);
        elapsed = bound(elapsed, 0, 2 * TTL);
        vm.warp(_createdAt(id) + elapsed);

        if (elapsed < CANCEL_WINDOW) {
            _act(Action.Cancel, id);
            _assertStatus(id, IEscrow.Status.CancelledBySender);
            assertEq(token.balanceOf(sender), INITIAL_BALANCE);
        } else {
            vm.expectRevert(abi.encodeWithSelector(IEscrow.CancelWindowClosed.selector, id, _cancelDeadline(id)));
            _act(Action.Cancel, id);
        }
    }

    function testFuzz_Confirm_OnlyBeforeExpiration(uint256 start, uint256 elapsed) public {
        uint256 id = _createAt(start, AMOUNT);
        elapsed = bound(elapsed, 0, 2 * TTL);
        vm.warp(_createdAt(id) + elapsed);

        if (elapsed < TTL) {
            _act(Action.Confirm, id);
            _assertStatus(id, IEscrow.Status.Released);
            assertEq(token.balanceOf(beneficiary), AMOUNT);
        } else {
            vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowHasExpired.selector, id, _expiresAt(id)));
            _act(Action.Confirm, id);
        }
    }

    function testFuzz_Reject_OnlyBeforeExpiration(uint256 start, uint256 elapsed) public {
        uint256 id = _createAt(start, AMOUNT);
        elapsed = bound(elapsed, 0, 2 * TTL);
        vm.warp(_createdAt(id) + elapsed);

        if (elapsed < TTL) {
            _act(Action.Reject, id);
            _assertStatus(id, IEscrow.Status.Rejected);
            assertEq(token.balanceOf(sender), INITIAL_BALANCE);
        } else {
            vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowHasExpired.selector, id, _expiresAt(id)));
            _act(Action.Reject, id);
        }
    }

    function testFuzz_RecoverExpired_OnlyFromExpiration(uint256 start, uint256 elapsed) public {
        uint256 id = _createAt(start, AMOUNT);
        elapsed = bound(elapsed, 0, 2 * TTL);
        vm.warp(_createdAt(id) + elapsed);

        if (elapsed >= TTL) {
            _act(Action.RecoverExpired, id);
            _assertStatus(id, IEscrow.Status.Expired);
            assertEq(token.balanceOf(sender), INITIAL_BALANCE);
        } else {
            vm.expectRevert(abi.encodeWithSelector(IEscrow.NotExpiredYet.selector, id, _expiresAt(id)));
            _act(Action.RecoverExpired, id);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Payouts and access control
    // ---------------------------------------------------------------------------------------------

    function testFuzz_Resolution_PaysRecordedAmountToTheRightParty(uint256 amount, uint256 actionSeed) public {
        amount = bound(amount, 1, INITIAL_BALANCE);
        Action action = Action(bound(actionSeed, 0, 3));
        uint256 id = _create(address(token), amount);
        if (action == Action.RecoverExpired) vm.warp(_expiresAt(id));

        _act(action, id);

        uint256 toBeneficiary = action == Action.Confirm ? amount : 0;
        assertEq(token.balanceOf(beneficiary), toBeneficiary);
        assertEq(token.balanceOf(sender), INITIAL_BALANCE - toBeneficiary);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testFuzz_RevertWhen_CallerIsNotTheParty(address caller, uint256 actionSeed, uint256 elapsed) public {
        Action action = Action(bound(actionSeed, 0, 3));
        bool senderAction = action == Action.Cancel || action == Action.RecoverExpired;
        vm.assume(caller != (senderAction ? sender : beneficiary));
        uint256 id = _create();
        vm.warp(block.timestamp + bound(elapsed, 0, 2 * TTL));

        // The caller is checked before the time window, so the error does not depend on `elapsed`.
        vm.expectRevert(
            senderAction
                ? abi.encodeWithSelector(IEscrow.NotSender.selector, id, caller)
                : abi.encodeWithSelector(IEscrow.NotBeneficiary.selector, id, caller)
        );
        _actAs(caller, action, id);
    }

    function testFuzz_RevertWhen_EscrowDoesNotExist(uint256 id, uint256 actionSeed) public {
        _create();
        vm.assume(id != 1);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowNotFound.selector, id));
        escrow.getEscrow(id);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowNotFound.selector, id));
        _act(Action(bound(actionSeed, 0, 3)), id);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    /// @dev Creates an escrow of `amount` at a random timestamp.
    function _createAt(uint256 start, uint256 amount) internal returns (uint256 id) {
        vm.warp(bound(start, 1, MAX_START));
        return _create(address(token), amount);
    }
}
