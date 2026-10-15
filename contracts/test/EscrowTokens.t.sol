// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IEscrow} from "../src/IEscrow.sol";
import {BlacklistERC20} from "./mocks/BlacklistERC20.sol";
import {FalseReturnERC20} from "./mocks/FalseReturnERC20.sol";
import {FeeOnTopERC20} from "./mocks/FeeOnTopERC20.sol";
import {FeeOnTransferERC20} from "./mocks/FeeOnTransferERC20.sol";
import {NoReturnERC20} from "./mocks/NoReturnERC20.sol";
import {ReentrantERC20} from "./mocks/ReentrantERC20.sol";
import {ReentrancyAttacker} from "./mocks/ReentrancyAttacker.sol";
import {EscrowTestBase} from "./utils/EscrowTestBase.sol";

contract EscrowTokensTest is EscrowTestBase {
    // ---------------------------------------------------------------------------------------------
    // Tokens that do not return a bool (USDT style)
    // ---------------------------------------------------------------------------------------------

    function test_NoReturnToken_SupportsFullLifecycle() public {
        NoReturnERC20 usdt = new NoReturnERC20();
        _fund(address(usdt), sender);

        uint256 released = _create(address(usdt), AMOUNT);
        uint256 cancelled = _create(address(usdt), AMOUNT);
        assertEq(usdt.balanceOf(address(escrow)), 2 * AMOUNT);

        _act(Action.Confirm, released);
        _act(Action.Cancel, cancelled);

        assertEq(usdt.balanceOf(beneficiary), AMOUNT);
        assertEq(usdt.balanceOf(sender), INITIAL_BALANCE - AMOUNT);
        assertEq(usdt.balanceOf(address(escrow)), 0);
    }

    function test_RevertWhen_TokenReturnsFalse() public {
        FalseReturnERC20 falseToken = new FalseReturnERC20();
        _fund(address(falseToken), sender);

        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(falseToken)));
        _create(address(falseToken), AMOUNT);
    }

    // ---------------------------------------------------------------------------------------------
    // Fee-on-transfer tokens: the escrow records and pays out what it actually received
    // ---------------------------------------------------------------------------------------------

    function test_FeeToken_RecordsAmountReceived() public {
        FeeOnTransferERC20 feeToken = new FeeOnTransferERC20(100); // 1%
        _fund(address(feeToken), sender);
        uint256 received = AMOUNT * 99 / 100;
        uint64 createdAt = uint64(block.timestamp);

        vm.expectEmit(address(escrow));
        emit IEscrow.EscrowCreated(
            1, sender, beneficiary, address(feeToken), received, createdAt + CANCEL_WINDOW, createdAt + TTL
        );
        uint256 id = _create(address(feeToken), AMOUNT);

        assertEq(escrow.getEscrow(id).amount, received);
        assertEq(feeToken.balanceOf(address(escrow)), received);
    }

    function test_FeeToken_DoesNotDrainOtherEscrows() public {
        FeeOnTransferERC20 feeToken = new FeeOnTransferERC20(100); // 1%
        address otherSender = makeAddr("otherSender");
        _fund(address(feeToken), sender);
        _fund(address(feeToken), otherSender);

        uint256 first = _create(address(feeToken), AMOUNT);
        vm.prank(otherSender);
        uint256 second = escrow.createEscrow(address(feeToken), beneficiary, AMOUNT);

        // Each payout sends exactly what was recorded; the escrow ends empty, never short.
        _act(Action.Confirm, first);
        assertEq(feeToken.balanceOf(address(escrow)), escrow.getEscrow(second).amount);
        _act(Action.Confirm, second);
        assertEq(feeToken.balanceOf(address(escrow)), 0);

        // The outgoing transfer is charged too: the beneficiary gets 99% of each recorded 99%.
        assertEq(feeToken.balanceOf(beneficiary), 2 * (AMOUNT * 99 / 100) * 99 / 100);
    }

    function test_RevertWhen_FeeTokenDeliversNothing() public {
        FeeOnTransferERC20 feeToken = new FeeOnTransferERC20(10_000); // 100%
        _fund(address(feeToken), sender);

        vm.expectRevert(IEscrow.NothingReceived.selector);
        _create(address(feeToken), AMOUNT);
    }

    // ---------------------------------------------------------------------------------------------
    // Tokens with transfer hooks cannot reenter the escrow
    // ---------------------------------------------------------------------------------------------

    /// @dev The ERC-777 balance-diff attack: the sender's hook reenters `createEscrow` during its own
    ///      deposit, so without a guard the outer call would count the inner deposit twice (3 x AMOUNT
    ///      recorded for 2 x AMOUNT deposited, stolen from other escrows of the same token).
    ///      The guard reverts the whole transaction.
    function test_RevertWhen_SenderHookReentersCreateDuringDeposit() public {
        ReentrantERC20 hookToken = new ReentrantERC20();
        ReentrancyAttacker attacker = new ReentrancyAttacker(escrow, address(hookToken), beneficiary, AMOUNT);
        hookToken.mint(address(attacker), 2 * AMOUNT);
        hookToken.setReentry(address(attacker), abi.encodeCall(attacker.reenter, ()));

        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        attacker.attack();

        assertEq(escrow.escrowCount(), 0);
        assertEq(hookToken.balanceOf(address(attacker)), 2 * AMOUNT);
    }

    function test_RevertWhen_TokenReentersDuringPayout() public {
        ReentrantERC20 hookToken = new ReentrantERC20();
        _fund(address(hookToken), sender);
        Action[4] memory actions = _actions();

        for (uint256 a; a < actions.length; ++a) {
            uint256 id = _create(address(hookToken), AMOUNT);
            if (actions[a] == Action.RecoverExpired) vm.warp(_expiresAt(id));

            // During the payout, try to resolve the same escrow again. The guard stops it first; even
            // without the guard it would fail with `NotPending`, since the status is already final (CEI).
            hookToken.setReentry(address(escrow), abi.encodeCall(escrow.reject, (id)));

            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            _act(actions[a], id);

            _assertStatus(id, IEscrow.Status.Pending);
            hookToken.setReentry(address(0), "");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Known limitation: tokens with a blacklist (USDC style) and push payments
    // ---------------------------------------------------------------------------------------------

    /// @dev Documents the accepted limitation: while the sender is blacklisted, every path that
    ///      returns funds to them reverts, and after expiration the beneficiary cannot confirm.
    ///      Funds stay locked until the token unblocks the sender. See docs/ai/DESIGN.md, "Limitaciones conocidas".
    function test_KnownLimitation_BlacklistedSenderLocksFunds() public {
        BlacklistERC20 usdc = new BlacklistERC20();
        _fund(address(usdc), sender);
        uint256 id = _create(address(usdc), AMOUNT);
        usdc.setBlocked(sender, true);

        vm.expectRevert(abi.encodeWithSelector(BlacklistERC20.Blocked.selector, sender));
        _act(Action.Cancel, id);
        vm.expectRevert(abi.encodeWithSelector(BlacklistERC20.Blocked.selector, sender));
        _act(Action.Reject, id);

        vm.warp(_expiresAt(id));
        vm.expectRevert(abi.encodeWithSelector(BlacklistERC20.Blocked.selector, sender));
        _act(Action.RecoverExpired, id);

        _assertStatus(id, IEscrow.Status.Pending);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);

        // Once the token unblocks the sender, the funds can be recovered.
        usdc.setBlocked(sender, false);
        _act(Action.RecoverExpired, id);
        assertEq(usdc.balanceOf(sender), INITIAL_BALANCE);
    }

    function test_KnownLimitation_BlacklistedBeneficiaryCanStillReject() public {
        BlacklistERC20 usdc = new BlacklistERC20();
        _fund(address(usdc), sender);
        uint256 id = _create(address(usdc), AMOUNT);
        usdc.setBlocked(beneficiary, true);

        vm.expectRevert(abi.encodeWithSelector(BlacklistERC20.Blocked.selector, beneficiary));
        _act(Action.Confirm, id);

        _act(Action.Reject, id);
        _assertStatus(id, IEscrow.Status.Rejected);
        assertEq(usdc.balanceOf(sender), INITIAL_BALANCE);
    }

    /// @dev If the token blocks the escrow contract itself, every escrow of that token is frozen, in
    ///      every direction, and no new one can be created. Escrows of other tokens are unaffected.
    function test_KnownLimitation_BlacklistedEscrowFreezesItsTokenEscrows() public {
        BlacklistERC20 usdc = new BlacklistERC20();
        _fund(address(usdc), sender);
        uint256 id = _create(address(usdc), AMOUNT);
        uint256 other = _create();
        usdc.setBlocked(address(escrow), true);
        bytes memory blocked = abi.encodeWithSelector(BlacklistERC20.Blocked.selector, address(escrow));

        Action[3] memory beforeExpiry = [Action.Cancel, Action.Confirm, Action.Reject];
        for (uint256 a; a < beforeExpiry.length; ++a) {
            vm.expectRevert(blocked);
            _act(beforeExpiry[a], id);
        }
        vm.expectRevert(blocked);
        _create(address(usdc), AMOUNT);

        vm.warp(_expiresAt(id));
        vm.expectRevert(blocked);
        _act(Action.RecoverExpired, id);
        _assertStatus(id, IEscrow.Status.Pending);

        // The escrow of the standard token is not affected.
        _act(Action.RecoverExpired, other);
        _assertStatus(other, IEscrow.Status.Expired);

        // Once the token unblocks the escrow, the funds can be recovered.
        usdc.setBlocked(address(escrow), false);
        _act(Action.RecoverExpired, id);
        assertEq(usdc.balanceOf(sender), INITIAL_BALANCE);
    }

    // ---------------------------------------------------------------------------------------------
    // Known limitation: tokens that take more from the payer than the amount transferred
    // ---------------------------------------------------------------------------------------------

    /// @dev Documents the accepted limitation: the escrow measures what it receives, but each payout
    ///      assumes that sending `amount` takes exactly `amount` out of the escrow. A token that charges
    ///      its fee to the payer, on top of the amount, takes more, and the last escrows of that token
    ///      are left short. Only that token's escrows are affected. See docs/seguridad.md.
    function test_KnownLimitation_FeeOnTopTokenUnderfundsLaterEscrows() public {
        FeeOnTopERC20 feeToken = new FeeOnTopERC20(100); // 1%
        address otherSender = makeAddr("otherSender");
        _fund(address(feeToken), sender);
        _fund(address(feeToken), otherSender);

        // Deposits are recorded correctly: the senders pay the fee.
        uint256 first = _create(address(feeToken), AMOUNT);
        vm.prank(otherSender);
        uint256 second = escrow.createEscrow(address(feeToken), beneficiary, AMOUNT);
        assertEq(escrow.getEscrow(first).amount, AMOUNT);
        assertEq(escrow.getEscrow(second).amount, AMOUNT);
        assertEq(feeToken.balanceOf(address(escrow)), 2 * AMOUNT);

        // The first payout takes the amount plus 1% from the escrow, so the second one is short.
        _act(Action.Confirm, first);
        uint256 left = AMOUNT - AMOUNT / 100;
        assertEq(feeToken.balanceOf(address(escrow)), left);

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(escrow), left, AMOUNT)
        );
        _act(Action.Confirm, second);
    }
}
