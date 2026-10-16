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
        _withdraw(released);
        _withdraw(cancelled);

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
    // Fee-on-transfer tokens: the escrow records what it actually received and pays out at most that
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

        // Each withdrawal takes exactly what was recorded; the escrow ends empty, never short.
        _act(Action.Confirm, first);
        _withdraw(first);
        assertEq(feeToken.balanceOf(address(escrow)), escrow.getEscrow(second).amount);
        _act(Action.Confirm, second);
        _withdraw(second);
        assertEq(feeToken.balanceOf(address(escrow)), 0);

        // The outgoing transfer is charged too: the beneficiary gets 99% of each recorded 99%.
        assertEq(feeToken.balanceOf(beneficiary), 2 * (AMOUNT * 99 / 100) * 99 / 100);
    }

    /// @dev The fee on the way out is the token's, and can change after the escrow is created: the
    ///      holder sets the least they accept.
    function test_FeeToken_MinReceivedProtectsTheHolder() public {
        FeeOnTransferERC20 feeToken = new FeeOnTransferERC20(100); // 1%
        _fund(address(feeToken), sender);
        uint256 id = _create(address(feeToken), AMOUNT);
        _act(Action.Confirm, id);
        uint256 balance = _balance(id);
        uint256 net = balance * 99 / 100;

        vm.expectRevert(abi.encodeWithSelector(IEscrow.ReceivedBelowMinimum.selector, id, net, balance));
        _withdrawAs(beneficiary, id, balance, balance);
        assertEq(feeToken.balanceOf(beneficiary), 0);

        vm.expectEmit(address(escrow));
        emit IEscrow.EscrowWithdrawn(id, balance, net);
        _withdraw(id, balance, net);
        assertEq(feeToken.balanceOf(beneficiary), net);
        assertEq(feeToken.balanceOf(address(escrow)), 0);
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

    /// @dev During the transfer of a withdrawal the token tries to withdraw again from the same escrow,
    ///      or to resolve another one. The guard stops both: no code of the escrow runs while a token
    ///      call is in progress.
    function test_RevertWhen_TokenReentersDuringWithdraw() public {
        ReentrantERC20 hookToken = new ReentrantERC20();
        _fund(address(hookToken), sender);
        uint256 pending = _create(address(hookToken), AMOUNT);
        IEscrow.Status[4] memory statuses = _finalStatuses();

        for (uint256 s; s < statuses.length; ++s) {
            uint256 id = _create(address(hookToken), AMOUNT);
            _resolve(id, statuses[s]);
            address holder = _holder(id);

            bytes[2] memory payloads =
                [abi.encodeCall(escrow.withdraw, (id, AMOUNT, 0)), abi.encodeCall(escrow.reject, (pending))];
            for (uint256 p; p < payloads.length; ++p) {
                hookToken.setReentry(address(escrow), payloads[p]);

                vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
                _withdrawAs(holder, id, AMOUNT, 0);

                assertEq(escrow.getEscrow(id).withdrawn, 0);
                _assertStatus(pending, IEscrow.Status.Pending);
            }
            hookToken.setReentry(address(0), "");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Known limitation: tokens with a blacklist (USDC style)
    // ---------------------------------------------------------------------------------------------

    /// @dev Documents the accepted limitation: resolving moves no tokens, so the escrow is resolved as
    ///      usual, but while the token blocks the sender, the funds assigned to them cannot leave the
    ///      contract. See docs/ai/DESIGN.md, "Limitaciones conocidas".
    function test_KnownLimitation_BlacklistedSenderLocksFunds() public {
        BlacklistERC20 usdc = new BlacklistERC20();
        _fund(address(usdc), sender);
        uint256 id = _create(address(usdc), AMOUNT);
        usdc.setBlocked(sender, true);

        _act(Action.Reject, id);
        _assertStatus(id, IEscrow.Status.Rejected);

        vm.expectRevert(abi.encodeWithSelector(BlacklistERC20.Blocked.selector, sender));
        _withdrawAs(sender, id, AMOUNT, 0);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);

        // Once the token unblocks the sender, the funds can be withdrawn.
        usdc.setBlocked(sender, false);
        _withdraw(id);
        assertEq(usdc.balanceOf(sender), INITIAL_BALANCE);
    }

    /// @dev A blocked beneficiary can still confirm, but cannot withdraw until unblocked; rejecting
    ///      sends the funds back to the sender as usual.
    function test_KnownLimitation_BlacklistedBeneficiaryCannotWithdraw() public {
        BlacklistERC20 usdc = new BlacklistERC20();
        _fund(address(usdc), sender);
        uint256 confirmed = _create(address(usdc), AMOUNT);
        uint256 rejected = _create(address(usdc), AMOUNT);
        usdc.setBlocked(beneficiary, true);

        _act(Action.Confirm, confirmed);
        vm.expectRevert(abi.encodeWithSelector(BlacklistERC20.Blocked.selector, beneficiary));
        _withdrawAs(beneficiary, confirmed, AMOUNT, 0);

        _act(Action.Reject, rejected);
        _withdraw(rejected);
        assertEq(usdc.balanceOf(sender), INITIAL_BALANCE - AMOUNT);

        usdc.setBlocked(beneficiary, false);
        _withdraw(confirmed);
        assertEq(usdc.balanceOf(beneficiary), AMOUNT);
    }

    /// @dev If the token blocks the escrow contract itself, no escrow of that token can be created or
    ///      withdrawn from, though they can still be resolved. Escrows of other tokens are unaffected.
    function test_KnownLimitation_BlacklistedEscrowFreezesItsTokenEscrows() public {
        BlacklistERC20 usdc = new BlacklistERC20();
        _fund(address(usdc), sender);
        uint256 id = _create(address(usdc), AMOUNT);
        uint256 other = _create();
        usdc.setBlocked(address(escrow), true);
        bytes memory blocked = abi.encodeWithSelector(BlacklistERC20.Blocked.selector, address(escrow));

        vm.expectRevert(blocked);
        _create(address(usdc), AMOUNT);

        _act(Action.Cancel, id);
        vm.expectRevert(blocked);
        _withdrawAs(sender, id, AMOUNT, 0);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);

        // The escrow of the standard token is not affected.
        _act(Action.Cancel, other);
        _withdraw(other);
        assertEq(token.balanceOf(sender), INITIAL_BALANCE);

        // Once the token unblocks the escrow, the funds can be withdrawn.
        usdc.setBlocked(address(escrow), false);
        _withdraw(id);
        assertEq(usdc.balanceOf(sender), INITIAL_BALANCE);
    }

    // ---------------------------------------------------------------------------------------------
    // Tokens that take more from the payer than the amount transferred: each escrow pays the fee from
    // its own balance, never from what backs other escrows
    // ---------------------------------------------------------------------------------------------

    function test_FeeOnTopToken_CannotConsumeOtherEscrowsBacking() public {
        FeeOnTopERC20 feeToken = new FeeOnTopERC20(100); // 1%
        address otherSender = makeAddr("otherSender");
        _fund(address(feeToken), sender);
        _fund(address(feeToken), otherSender);

        // Deposits are recorded correctly: the senders pay the fee.
        uint256 first = _create(address(feeToken), AMOUNT);
        vm.prank(otherSender);
        uint256 second = escrow.createEscrow(address(feeToken), beneficiary, AMOUNT);
        assertEq(feeToken.balanceOf(address(escrow)), 2 * AMOUNT);
        _act(Action.Confirm, first);
        _act(Action.Confirm, second);

        // Withdrawing the whole amount would take the amount plus 1% out of the contract, the 1% from
        // the second escrow's backing: it reverts, and nothing moves.
        vm.expectRevert(abi.encodeWithSelector(IEscrow.ExcessiveDebit.selector, first, AMOUNT, AMOUNT + AMOUNT / 100));
        _withdrawAs(beneficiary, first, AMOUNT, 0);
        assertEq(feeToken.balanceOf(address(escrow)), 2 * AMOUNT);
        assertEq(feeToken.balanceOf(beneficiary), 0);

        // Asking for less leaves room for the fee: what can be withdrawn is what the balance can pay
        // for, fee included. The dust left over (1 wei) is not enough for another transfer plus its fee.
        uint256 transferAmount = AMOUNT * 10_000 / 10_100;
        uint256 debited = transferAmount + transferAmount / 100;
        assertLe(debited, AMOUNT);
        vm.expectEmit(address(escrow));
        emit IEscrow.EscrowWithdrawn(first, debited, transferAmount);
        _withdraw(first, transferAmount, transferAmount);
        assertEq(escrow.getEscrow(first).withdrawn, debited);

        // The second escrow is still fully backed, and pays out the same way.
        assertEq(feeToken.balanceOf(address(escrow)), 2 * AMOUNT - debited);
        assertGe(feeToken.balanceOf(address(escrow)), _balance(second));
        _withdraw(second, transferAmount, transferAmount);
        assertEq(feeToken.balanceOf(beneficiary), 2 * transferAmount);
        assertEq(feeToken.balanceOf(address(escrow)), _balance(first) + _balance(second));
    }

    /// @dev Tokens donated to the contract are not anyone's: they cannot pay a withdrawal's fee either.
    function test_FeeOnTopToken_DonationsDoNotPayTheFee() public {
        FeeOnTopERC20 feeToken = new FeeOnTopERC20(100); // 1%
        _fund(address(feeToken), sender);
        uint256 id = _create(address(feeToken), AMOUNT);
        _act(Action.Cancel, id);
        feeToken.mint(address(escrow), AMOUNT / 2);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.ExcessiveDebit.selector, id, AMOUNT, AMOUNT + AMOUNT / 100));
        _withdrawAs(sender, id, AMOUNT, 0);
        assertEq(feeToken.balanceOf(address(escrow)), AMOUNT + AMOUNT / 2);
    }

    /// @dev With nothing else of the token in the contract, the fee cannot be paid at all and the token
    ///      itself reverts. Either way, asking for less is what works.
    function test_FeeOnTopToken_OnlyEscrowOfTokenRevertsInToken() public {
        FeeOnTopERC20 feeToken = new FeeOnTopERC20(100); // 1%
        _fund(address(feeToken), sender);
        uint256 id = _create(address(feeToken), AMOUNT);
        _act(Action.Cancel, id);

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(escrow), 0, AMOUNT / 100)
        );
        _withdrawAs(sender, id, AMOUNT, 0);

        _withdraw(id, AMOUNT * 10_000 / 10_100, 0);
        assertEq(feeToken.balanceOf(address(escrow)), _balance(id));
    }
}
