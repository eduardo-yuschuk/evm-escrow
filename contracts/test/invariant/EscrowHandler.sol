// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CommonBase} from "forge-std/Base.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {Escrow} from "../../src/Escrow.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {IEscrow} from "../../src/IEscrow.sol";
import {FeeOnTopERC20} from "../mocks/FeeOnTopERC20.sol";
import {FeeOnTransferERC20} from "../mocks/FeeOnTransferERC20.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {NoReturnERC20} from "../mocks/NoReturnERC20.sol";
import {ITestToken} from "../utils/EscrowTestBase.sol";

/// @dev Drives the escrow with random calls from a small set of actors over four tokens (standard,
///      USDT style, a 1% fee taken from the amount and a 1% fee charged to the payer on top of it), and
///      keeps an independent model of every escrow written from the rules in `IEscrow`.
///
///      Before each resolution and withdrawal the handler predicts the outcome from the model (success or
///      the exact revert) and checks the contract against it, including how much each balance moves. The
///      handler itself only reverts on a mismatch, so the invariant suite runs with `fail_on_revert = true`.
contract EscrowHandler is CommonBase, StdAssertions, StdCheats, StdUtils {
    enum Action {
        Cancel,
        Confirm,
        Reject,
        RecoverExpired,
        Withdraw
    }

    /// @dev What the handler expects each escrow to be. `amount` is what the escrow actually received and
    ///      `withdrawn` what withdrawals took out of the escrow for it.
    struct Model {
        address sender;
        address beneficiary;
        address token;
        uint256 amount;
        uint256 withdrawn;
        uint64 createdAt;
        IEscrow.Status status;
    }

    uint256 internal constant FUNDS = 1e30;
    uint256 internal constant MAX_AMOUNT = 1e24;
    uint256 internal constant FEE_BPS = 100; // 1%

    Escrow public escrow;
    FeeOnTransferERC20 public feeToken;
    FeeOnTopERC20 public feeOnTopToken;

    address[] public tokens;
    address[] public actors;

    // ---------------------------------------------------------------------------------------------
    // Ghost state
    // ---------------------------------------------------------------------------------------------

    /// @dev Number of escrows created, and the model of each one by id.
    uint256 public created;
    mapping(uint256 id => Model) internal _models;

    /// @dev Per token: amount recorded at creation, amount taken out of the escrow by withdrawals (fees
    ///      charged to the escrow included), and tokens sent to the escrow outside `createEscrow` (minted
    ///      straight to it).
    mapping(address token => uint256) public deposited;
    mapping(address token => uint256) public paidOut;
    mapping(address token => uint256) public donated;

    /// @dev Call statistics, to check that the run actually exercised every path.
    uint256[5] public successes;
    uint256[5] public expectedReverts;

    constructor(Escrow escrow_) {
        escrow = escrow_;
        feeToken = new FeeOnTransferERC20(FEE_BPS);
        feeOnTopToken = new FeeOnTopERC20(FEE_BPS);
        tokens = [address(new MockERC20()), address(new NoReturnERC20()), address(feeToken), address(feeOnTopToken)];
        actors = [makeAddr("alice"), makeAddr("bob"), makeAddr("carol")];

        for (uint256 a; a < actors.length; ++a) {
            for (uint256 t; t < tokens.length; ++t) {
                ITestToken(tokens[t]).mint(actors[a], FUNDS);
                vm.prank(actors[a]);
                ITestToken(tokens[t]).approve(address(escrow), type(uint256).max);
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------------------------

    function createEscrow(uint256 senderSeed, uint256 beneficiarySeed, uint256 tokenSeed, uint256 amount) external {
        uint256 senderIndex = _bound(senderSeed, 0, actors.length - 1);
        // Any actor other than the sender.
        uint256 beneficiaryIndex = (senderIndex + _bound(beneficiarySeed, 1, actors.length - 1)) % actors.length;
        address sender = actors[senderIndex];
        address beneficiary = actors[beneficiaryIndex];
        address token = tokens[_bound(tokenSeed, 0, tokens.length - 1)];
        amount = _bound(amount, 1, MAX_AMOUNT);

        uint256 balanceBefore = _balanceOf(token, address(escrow));
        vm.prank(sender);
        uint256 id = escrow.createEscrow(token, beneficiary, amount);
        uint256 received = _balanceOf(token, address(escrow)) - balanceBefore;

        assertEq(id, ++created, "ids must be sequential");
        assertEq(received, _received(token, amount), "received");
        _models[id] = Model({
            sender: sender,
            beneficiary: beneficiary,
            token: token,
            amount: received,
            withdrawn: 0,
            createdAt: uint64(block.timestamp),
            status: IEscrow.Status.Pending
        });
        deposited[token] += received;
    }

    function cancel(uint256 idSeed, uint256 callerSeed) external {
        _resolve(Action.Cancel, idSeed, callerSeed);
    }

    function confirm(uint256 idSeed, uint256 callerSeed) external {
        _resolve(Action.Confirm, idSeed, callerSeed);
    }

    function reject(uint256 idSeed, uint256 callerSeed) external {
        _resolve(Action.Reject, idSeed, callerSeed);
    }

    function recoverExpired(uint256 idSeed, uint256 callerSeed) external {
        _resolve(Action.RecoverExpired, idSeed, callerSeed);
    }

    /// @dev The holder of a resolved escrow, most of the time, withdraws the whole balance, the most the
    ///      balance can pay for with the token's fee on top, or any amount up to one above the balance.
    ///      `minReceived` is zero, exactly what the holder should receive, one more than that, or any
    ///      amount up to the transfer.
    function withdraw(uint256 idSeed, uint256 callerSeed, uint256 amountSeed, uint256 minSeed) external {
        uint256 id = _pickWithdrawableId(idSeed);
        Model storage m = _models[id];
        address holder = m.status == IEscrow.Status.Released ? m.beneficiary : m.sender;
        address caller =
            callerSeed % 4 != 0 && m.status != IEscrow.Status.None ? holder : actors[(callerSeed / 4) % actors.length];
        uint256 balance = m.amount - m.withdrawn;

        uint256 transferAmount;
        if (amountSeed % 4 == 0) transferAmount = balance;
        else if (amountSeed % 4 == 1) transferAmount = _maxTransfer(m.token, balance);
        else transferAmount = _bound(amountSeed, 0, balance + 1);
        uint256 debited = _debited(m.token, transferAmount);
        uint256 received = _received(m.token, transferAmount);
        uint256 minReceived;
        if (minSeed % 4 == 1) minReceived = received;
        else if (minSeed % 4 == 2) minReceived = received + 1;
        else if (minSeed % 4 == 3) minReceived = _bound(minSeed, 0, transferAmount);

        bytes memory expectedError = _expectedWithdrawError(id, m, caller, holder, transferAmount, minReceived);
        uint256 escrowBefore = _balanceOf(m.token, address(escrow));
        uint256 holderBefore = _balanceOf(m.token, holder);

        vm.prank(caller);
        (bool ok, bytes memory returnData) =
            address(escrow).call(abi.encodeCall(IEscrow.withdraw, (id, transferAmount, minReceived)));

        assertEq(ok, expectedError.length == 0, "success");
        assertEq(returnData, expectedError, "revert reason");
        if (!ok) {
            ++expectedReverts[uint256(Action.Withdraw)];
            return;
        }

        ++successes[uint256(Action.Withdraw)];
        m.withdrawn += debited;
        paidOut[m.token] += debited;
        assertEq(escrowBefore - _balanceOf(m.token, address(escrow)), debited, "escrow debited");
        assertEq(_balanceOf(m.token, holder) - holderBefore, received, "holder received");
    }

    /// @dev Sends tokens to the escrow without creating an escrow. They must never be paid out.
    function donate(uint256 tokenSeed, uint256 amount) external {
        address token = tokens[_bound(tokenSeed, 0, tokens.length - 1)];
        amount = _bound(amount, 1, MAX_AMOUNT);
        ITestToken(token).mint(address(escrow), amount);
        donated[token] += amount;
    }

    /// @dev Up to 1 day per call: long enough to reach expiration within a run, short enough to leave
    ///      most escrows inside their windows for a while.
    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + _bound(secondsSeed, 1, 1 days));
    }

    /// @dev Random warps rarely land on a deadline, so this jumps to one second before, exactly at,
    ///      or one second after one of an escrow's deadlines (never backwards).
    function warpToDeadline(uint256 idSeed, bool expiration, uint256 offsetSeed) external {
        if (created == 0) return;
        Model storage m = _models[_bound(idSeed, 1, created)];
        uint256 deadline = m.createdAt + (expiration ? escrow.TTL() : escrow.CANCEL_WINDOW());
        uint256 target = deadline - 1 + _bound(offsetSeed, 0, 2);
        if (target > block.timestamp) vm.warp(target);
    }

    // ---------------------------------------------------------------------------------------------
    // Views for the invariants
    // ---------------------------------------------------------------------------------------------

    function model(uint256 id) external view returns (Model memory) {
        return _models[id];
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    /// @dev Calls `action` on an id and checks the outcome against the model.
    function _resolve(Action action, uint256 idSeed, uint256 callerSeed) private {
        uint256 id = _pickId(idSeed);
        Model storage m = _models[id];
        address caller = _pickCaller(action, m, callerSeed);
        bytes memory expectedError = _expectedError(action, id, m, caller);

        uint256 escrowBefore = _balanceOf(m.token, address(escrow));

        vm.prank(caller);
        (bool ok, bytes memory returnData) = address(escrow).call(abi.encodeWithSelector(_selector(action), id));

        // On success the call returns nothing; on failure, the revert data must be the expected error.
        assertEq(ok, expectedError.length == 0, "success");
        assertEq(returnData, expectedError, "revert reason");
        if (!ok) {
            ++expectedReverts[uint256(action)];
            return;
        }

        ++successes[uint256(action)];
        m.status = _finalStatus(action);
        assertEq(_balanceOf(m.token, address(escrow)), escrowBefore, "resolving moves no tokens");
    }

    /// @dev One call in four targets any id from 0 to the next unused one, so resolved and nonexistent
    ///      escrows are hit too. The rest target a pending escrow if there is one, so that most calls
    ///      can actually succeed.
    function _pickId(uint256 idSeed) private view returns (uint256) {
        uint256 id = _bound(idSeed, 0, created + 1);
        if (idSeed % 4 == 0) return id;
        for (uint256 i; i < created; ++i) {
            uint256 candidate = (id + i) % created + 1;
            if (_models[candidate].status == IEscrow.Status.Pending) return candidate;
        }
        return id;
    }

    /// @dev Like `_pickId`, but the rest target a resolved escrow with balance left.
    function _pickWithdrawableId(uint256 idSeed) private view returns (uint256) {
        uint256 id = _bound(idSeed, 0, created + 1);
        if (idSeed % 4 == 0) return id;
        for (uint256 i; i < created; ++i) {
            uint256 candidate = (id + i) % created + 1;
            Model storage m = _models[candidate];
            if (m.status != IEscrow.Status.Pending && m.withdrawn < m.amount) return candidate;
        }
        return id;
    }

    /// @dev Three out of four calls come from the party allowed to act; the rest from a random actor,
    ///      which may still be the right one.
    function _pickCaller(Action action, Model storage m, uint256 callerSeed) private view returns (address) {
        bool senderAction = action == Action.Cancel || action == Action.RecoverExpired;
        if (callerSeed % 4 != 0 && m.status != IEscrow.Status.None) return senderAction ? m.sender : m.beneficiary;
        return actors[(callerSeed / 4) % actors.length];
    }

    /// @dev The rules of `IEscrow`, applied to the model: existence and status, caller, time window.
    function _expectedError(Action action, uint256 id, Model storage m, address caller)
        private
        view
        returns (bytes memory)
    {
        if (m.status == IEscrow.Status.None) return abi.encodeWithSelector(IEscrow.EscrowNotFound.selector, id);
        if (m.status != IEscrow.Status.Pending) {
            return abi.encodeWithSelector(IEscrow.NotPending.selector, id, m.status);
        }

        bool senderAction = action == Action.Cancel || action == Action.RecoverExpired;
        if (senderAction && caller != m.sender) return abi.encodeWithSelector(IEscrow.NotSender.selector, id, caller);
        if (!senderAction && caller != m.beneficiary) {
            return abi.encodeWithSelector(IEscrow.NotBeneficiary.selector, id, caller);
        }

        uint64 cancelDeadline = m.createdAt + escrow.CANCEL_WINDOW();
        uint64 expiresAt = m.createdAt + escrow.TTL();
        if (action == Action.Cancel && block.timestamp >= cancelDeadline) {
            return abi.encodeWithSelector(IEscrow.CancelWindowClosed.selector, id, cancelDeadline);
        }
        if ((action == Action.Confirm || action == Action.Reject) && block.timestamp >= expiresAt) {
            return abi.encodeWithSelector(IEscrow.EscrowHasExpired.selector, id, expiresAt);
        }
        if (action == Action.RecoverExpired && block.timestamp < expiresAt) {
            return abi.encodeWithSelector(IEscrow.NotExpiredYet.selector, id, expiresAt);
        }
        return "";
    }

    /// @dev The rules of `withdraw`, applied to the model, in the contract's order: existence and status,
    ///      caller and amounts, then the token's own revert if the contract cannot pay the transfer and its
    ///      fee, and last what the transfer actually moved.
    function _expectedWithdrawError(
        uint256 id,
        Model storage m,
        address caller,
        address holder,
        uint256 transferAmount,
        uint256 minReceived
    ) private view returns (bytes memory) {
        if (m.status == IEscrow.Status.None) {
            return abi.encodeWithSelector(IEscrow.EscrowNotFound.selector, id);
        }
        if (m.status == IEscrow.Status.Pending) return abi.encodeWithSelector(IEscrow.NotResolved.selector, id);
        if (caller != holder) return abi.encodeWithSelector(IEscrow.NotHolder.selector, id, caller);
        if (transferAmount == 0) return abi.encodeWithSelector(IEscrow.ZeroAmount.selector);
        uint256 balance = m.amount - m.withdrawn;
        if (transferAmount > balance) {
            return abi.encodeWithSelector(IEscrow.AmountExceedsBalance.selector, id, balance, transferAmount);
        }

        // Only the fee on top can exceed what the contract holds: the other tokens take at most
        // `transferAmount`, and solvency guarantees the contract holds the escrow's balance.
        uint256 held = _balanceOf(m.token, address(escrow));
        if (m.token == address(feeOnTopToken)) {
            uint256 fee = transferAmount * FEE_BPS / 10_000;
            if (held < transferAmount) {
                return abi.encodeWithSelector(
                    IERC20Errors.ERC20InsufficientBalance.selector, address(escrow), held, transferAmount
                );
            }
            if (held - transferAmount < fee) {
                return abi.encodeWithSelector(
                    IERC20Errors.ERC20InsufficientBalance.selector, address(escrow), held - transferAmount, fee
                );
            }
        }

        uint256 debited = _debited(m.token, transferAmount);
        if (debited > balance) return abi.encodeWithSelector(IEscrow.ExcessiveDebit.selector, id, balance, debited);
        uint256 received = _received(m.token, transferAmount);
        if (received < minReceived) {
            return abi.encodeWithSelector(IEscrow.ReceivedBelowMinimum.selector, id, received, minReceived);
        }
        return "";
    }

    function _selector(Action action) private pure returns (bytes4) {
        if (action == Action.Cancel) return IEscrow.cancel.selector;
        if (action == Action.Confirm) return IEscrow.confirm.selector;
        if (action == Action.Reject) return IEscrow.reject.selector;
        return IEscrow.recoverExpired.selector;
    }

    function _finalStatus(Action action) private pure returns (IEscrow.Status) {
        if (action == Action.Cancel) return IEscrow.Status.CancelledBySender;
        if (action == Action.Confirm) return IEscrow.Status.Released;
        if (action == Action.Reject) return IEscrow.Status.Rejected;
        return IEscrow.Status.Expired;
    }

    /// @dev What a transfer of `amount` actually delivers.
    function _received(address token, uint256 amount) private view returns (uint256) {
        return token == address(feeToken) ? amount - amount * FEE_BPS / 10_000 : amount;
    }

    /// @dev What a transfer of `amount` actually takes from the payer.
    function _debited(address token, uint256 amount) private view returns (uint256) {
        return token == address(feeOnTopToken) ? amount + amount * FEE_BPS / 10_000 : amount;
    }

    /// @dev The largest transfer whose debit, fee included, fits in `balance`. Rounding down is safe: the
    ///      token rounds its fee down too.
    function _maxTransfer(address token, uint256 balance) private view returns (uint256) {
        return token == address(feeOnTopToken) ? balance * 10_000 / (10_000 + FEE_BPS) : balance;
    }

    /// @dev Returns 0 for `address(0)`, the token of an escrow that does not exist.
    function _balanceOf(address token, address account) private view returns (uint256) {
        return token == address(0) ? 0 : ITestToken(token).balanceOf(account);
    }
}
