// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IEscrow} from "./IEscrow.sol";

/// @title Escrow
/// @notice Holds ERC-20 tokens from a sender until the beneficiary confirms or rejects, the sender
///         cancels within the cancel window, or the sender recovers them after expiration. The party
///         the resolution assigns the funds to then withdraws them.
/// @dev No owner, no pause, no upgradeability: the only way funds leave the contract is `withdraw`, by
///      the holder of a resolved escrow and never for more than that escrow's balance.
contract Escrow is IEscrow, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @dev Packed into 4 slots: `sender`, `createdAt` and `status` share slot 0. Deadlines are not
    ///      stored; they are derived from `createdAt` and the immutable windows.
    struct EscrowData {
        address sender;
        uint64 createdAt;
        Status status;
        address beneficiary;
        address token;
        uint256 amount;
    }

    /// @inheritdoc IEscrow
    uint64 public immutable CANCEL_WINDOW;

    /// @inheritdoc IEscrow
    uint64 public immutable TTL;

    /// @inheritdoc IEscrow
    uint256 public escrowCount;

    mapping(uint256 id => EscrowData) private _escrows;

    /// @dev What withdrawals took out of the contract for each escrow. Outside `EscrowData`, so that
    ///      `createEscrow` does not write it: it stays zero, at no cost, until the first withdrawal.
    mapping(uint256 id => uint256) private _withdrawn;

    /// @param cancelWindow Seconds after creation during which the sender can cancel (2 hours in production).
    /// @param ttl Seconds after creation after which the escrow expires (7 days in production).
    constructor(uint64 cancelWindow, uint64 ttl) {
        if (cancelWindow == 0 || cancelWindow >= ttl) revert InvalidWindows(cancelWindow, ttl);
        CANCEL_WINDOW = cancelWindow;
        TTL = ttl;
    }

    // ---------------------------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IEscrow
    function createEscrow(address token, address beneficiary, uint256 amount)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (amount == 0) revert ZeroAmount();
        if (beneficiary == address(0) || beneficiary == msg.sender) revert InvalidBeneficiary(beneficiary);
        // Also rejects address(0). An address without code would revert anyway (when decoding the empty
        // `balanceOf` result), but with no reason; this check gives a clear error up front.
        if (token.code.length == 0) revert InvalidToken(token);

        // The transfer has to happen before the escrow is written, to record what was actually
        // received (fee-on-transfer tokens). Reentrancy is prevented by `nonReentrant`.
        IERC20 erc20 = IERC20(token);
        uint256 balanceBefore = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = erc20.balanceOf(address(this)) - balanceBefore;
        // Intended: zero is exactly the case to reject (see docs/slither.md).
        // slither-disable-next-line incorrect-equality
        if (received == 0) revert NothingReceived();

        id = ++escrowCount;
        // Casting to uint64 is safe: timestamps fit in 64 bits for the next ~584 billion years.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 createdAt = uint64(block.timestamp);
        _escrows[id] = EscrowData({
            sender: msg.sender,
            createdAt: createdAt,
            status: Status.Pending,
            beneficiary: beneficiary,
            token: token,
            amount: received
        });

        emit EscrowCreated(id, msg.sender, beneficiary, token, received, createdAt + CANCEL_WINDOW, createdAt + TTL);
    }

    /// @inheritdoc IEscrow
    function cancel(uint256 id) external nonReentrant {
        EscrowData storage escrow = _loadPending(id);
        if (msg.sender != escrow.sender) revert NotSender(id, msg.sender);
        uint64 cancelDeadline = escrow.createdAt + CANCEL_WINDOW;
        if (block.timestamp >= cancelDeadline) revert CancelWindowClosed(id, cancelDeadline);

        escrow.status = Status.CancelledBySender;
        emit EscrowCancelled(id);
    }

    /// @inheritdoc IEscrow
    function confirm(uint256 id) external nonReentrant {
        EscrowData storage escrow = _loadPending(id);
        if (msg.sender != escrow.beneficiary) revert NotBeneficiary(id, msg.sender);
        uint64 expiresAt = escrow.createdAt + TTL;
        if (block.timestamp >= expiresAt) revert EscrowHasExpired(id, expiresAt);

        escrow.status = Status.Released;
        emit EscrowReleased(id);
    }

    /// @inheritdoc IEscrow
    function reject(uint256 id) external nonReentrant {
        EscrowData storage escrow = _loadPending(id);
        if (msg.sender != escrow.beneficiary) revert NotBeneficiary(id, msg.sender);
        uint64 expiresAt = escrow.createdAt + TTL;
        if (block.timestamp >= expiresAt) revert EscrowHasExpired(id, expiresAt);

        escrow.status = Status.Rejected;
        emit EscrowRejected(id);
    }

    /// @inheritdoc IEscrow
    function recoverExpired(uint256 id) external nonReentrant {
        EscrowData storage escrow = _loadPending(id);
        if (msg.sender != escrow.sender) revert NotSender(id, msg.sender);
        uint64 expiresAt = escrow.createdAt + TTL;
        if (block.timestamp < expiresAt) revert NotExpiredYet(id, expiresAt);

        escrow.status = Status.Expired;
        emit EscrowExpired(id);
    }

    /// @inheritdoc IEscrow
    function withdraw(uint256 id, uint256 transferAmount, uint256 minReceived) external nonReentrant {
        EscrowData storage escrow = _escrows[id];
        Status status = escrow.status;
        if (status == Status.None) revert EscrowNotFound(id);
        if (status == Status.Pending) revert NotResolved(id);
        // Only `Released` pays the beneficiary; the other three final statuses return the funds.
        address holder = status == Status.Released ? escrow.beneficiary : escrow.sender;
        if (msg.sender != holder) revert NotHolder(id, msg.sender);
        if (transferAmount == 0) revert ZeroAmount();
        uint256 withdrawn = _withdrawn[id];
        uint256 balance = escrow.amount - withdrawn;
        if (transferAmount > balance) revert AmountExceedsBalance(id, balance, transferAmount);

        // Like `createEscrow`, the escrow is written after the transfer, because what is charged to it is
        // what the contract's balance actually dropped, not `transferAmount`. Reentrancy is prevented by
        // `nonReentrant`. Both subtractions revert if a balance moves the wrong way, which no token that
        // reports balances honestly does.
        IERC20 erc20 = IERC20(escrow.token);
        uint256 contractBefore = erc20.balanceOf(address(this));
        uint256 holderBefore = erc20.balanceOf(holder);
        erc20.safeTransfer(holder, transferAmount);
        uint256 debited = contractBefore - erc20.balanceOf(address(this));
        uint256 received = erc20.balanceOf(holder) - holderBefore;
        // The fee is checked against this escrow's balance, never against what the contract holds:
        // tokens that back other escrows, or that were donated, cannot pay it.
        if (debited > balance) revert ExcessiveDebit(id, balance, debited);
        if (received < minReceived) revert ReceivedBelowMinimum(id, received, minReceived);

        _withdrawn[id] = withdrawn + debited;
        emit EscrowWithdrawn(id, debited, received);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IEscrow
    function getEscrow(uint256 id) external view returns (EscrowView memory) {
        EscrowData storage escrow = _escrows[id];
        if (escrow.status == Status.None) revert EscrowNotFound(id);

        return EscrowView({
            sender: escrow.sender,
            beneficiary: escrow.beneficiary,
            token: escrow.token,
            amount: escrow.amount,
            withdrawn: _withdrawn[id],
            createdAt: escrow.createdAt,
            cancelDeadline: escrow.createdAt + CANCEL_WINDOW,
            expiresAt: escrow.createdAt + TTL,
            status: escrow.status
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    /// @dev Returns the escrow if it exists and is still pending.
    function _loadPending(uint256 id) private view returns (EscrowData storage escrow) {
        escrow = _escrows[id];
        Status status = escrow.status;
        if (status == Status.None) revert EscrowNotFound(id);
        if (status != Status.Pending) revert NotPending(id, status);
    }
}
