// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title IEscrow
/// @notice Escrow of ERC-20 tokens between a sender and a beneficiary.
/// @dev Time windows are measured from creation and are half-open: an action is allowed while
///      `block.timestamp < deadline` and rejected from `deadline` on. `cancelDeadline` and `expiresAt`
///      are therefore the first timestamp at which their window is closed.
///
///      - `cancel`:         sender,      `block.timestamp <  cancelDeadline` -> `CancelledBySender`
///      - `confirm`:        beneficiary, `block.timestamp <  expiresAt`      -> `Released`
///      - `reject`:         beneficiary, `block.timestamp <  expiresAt`      -> `Rejected`
///      - `recoverExpired`: sender,      `block.timestamp >= expiresAt`      -> `Expired`
///
///      Resolving moves no tokens: it assigns the escrow's balance to its holder, the beneficiary if
///      `Released` and the sender otherwise. The holder takes it out with `withdraw`, in one or more
///      calls, which is the only way tokens leave the contract. Each withdrawal measures how much the
///      contract's balance actually dropped and charges that to the escrow, so a token that takes more
///      than the amount transferred (a fee charged to the payer) can never consume what backs other
///      escrows: the holder asks for less, so that the amount plus the fee fits in the balance.
interface IEscrow {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice Lifecycle of an escrow. Every status other than `Pending` is final; withdrawals do not
    ///         change it.
    /// @dev `None` is the zero value, so an id that was never created reads as `None`.
    enum Status {
        None,
        Pending,
        Released,
        Rejected,
        CancelledBySender,
        Expired
    }

    /// @notice Read model returned by `getEscrow`, with both deadlines already computed.
    struct EscrowView {
        address sender;
        address beneficiary;
        address token;
        /// @dev Amount actually received by the contract (lower than requested for fee-on-transfer tokens).
        uint256 amount;
        /// @dev Amount taken out of the contract by withdrawals so far, fees charged to the contract
        ///      included. The holder can still withdraw `amount - withdrawn` once the escrow is resolved.
        uint256 withdrawn;
        uint64 createdAt;
        /// @dev First timestamp at which the sender can no longer cancel.
        uint64 cancelDeadline;
        /// @dev First timestamp at which the escrow is expired.
        uint64 expiresAt;
        Status status;
    }

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    /// @notice Emitted when an escrow is created and funded.
    /// @param amount Amount actually received by the contract: the most that withdrawals can take out
    ///        of the contract for this escrow.
    event EscrowCreated(
        uint256 indexed id,
        address indexed sender,
        address indexed beneficiary,
        address token,
        uint256 amount,
        uint64 cancelDeadline,
        uint64 expiresAt
    );

    /// @notice The sender cancelled within the cancel window; the funds can be withdrawn by the sender.
    event EscrowCancelled(uint256 indexed id);

    /// @notice The beneficiary confirmed; the funds can be withdrawn by the beneficiary.
    event EscrowReleased(uint256 indexed id);

    /// @notice The beneficiary rejected; the funds can be withdrawn by the sender.
    event EscrowRejected(uint256 indexed id);

    /// @notice The sender recovered the escrow after expiration; the funds can be withdrawn by the sender.
    event EscrowExpired(uint256 indexed id);

    /// @notice The holder withdrew from a resolved escrow.
    /// @param debited How much the contract's balance dropped, charged to the escrow's `withdrawn`.
    /// @param received How much the holder's balance rose.
    event EscrowWithdrawn(uint256 indexed id, uint256 debited, uint256 received);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    /// @notice Constructor parameters must satisfy `0 < cancelWindow < ttl`.
    error InvalidWindows(uint64 cancelWindow, uint64 ttl);

    /// @notice `amount` must be greater than zero.
    error ZeroAmount();

    /// @notice The beneficiary cannot be the zero address nor the sender.
    error InvalidBeneficiary(address beneficiary);

    /// @notice The token cannot be the zero address and must be a contract.
    error InvalidToken(address token);

    /// @notice The token transfer left the contract with no balance increase (e.g. a 100% fee).
    error NothingReceived();

    /// @notice No escrow exists with this id.
    error EscrowNotFound(uint256 id);

    /// @notice The escrow was already resolved.
    error NotPending(uint256 id, Status status);

    /// @notice Only the sender of the escrow can perform this action.
    error NotSender(uint256 id, address caller);

    /// @notice Only the beneficiary of the escrow can perform this action.
    error NotBeneficiary(uint256 id, address caller);

    /// @notice The cancel window is closed (`block.timestamp >= cancelDeadline`).
    error CancelWindowClosed(uint256 id, uint64 cancelDeadline);

    /// @notice The escrow is expired (`block.timestamp >= expiresAt`); only `recoverExpired` is allowed.
    error EscrowHasExpired(uint256 id, uint64 expiresAt);

    /// @notice The escrow is not expired yet (`block.timestamp < expiresAt`).
    error NotExpiredYet(uint256 id, uint64 expiresAt);

    /// @notice The escrow is still pending: there is nothing to withdraw until it is resolved.
    error NotResolved(uint256 id);

    /// @notice Only the holder can withdraw: the beneficiary if `Released`, the sender otherwise.
    error NotHolder(uint256 id, address caller);

    /// @notice The transfer asked for more than the escrow's balance (`amount - withdrawn`).
    error AmountExceedsBalance(uint256 id, uint256 balance, uint256 transferAmount);

    /// @notice The token took more out of the contract than the escrow's balance (a fee charged to the
    ///         payer). Asking for less leaves room for the fee.
    error ExcessiveDebit(uint256 id, uint256 balance, uint256 debited);

    /// @notice The holder received less than `minReceived` (a fee taken from the amount transferred).
    error ReceivedBelowMinimum(uint256 id, uint256 received, uint256 minReceived);

    // ---------------------------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------------------------

    /// @notice Locks `amount` of `token` for `beneficiary`. Requires a prior `approve`.
    /// @dev Records the amount actually received, so fee-on-transfer tokens are supported.
    /// @return id Sequential id of the new escrow, starting at 1.
    function createEscrow(address token, address beneficiary, uint256 amount) external returns (uint256 id);

    /// @notice Sender cancels before `cancelDeadline`; the funds are assigned to the sender.
    function cancel(uint256 id) external;

    /// @notice Beneficiary accepts before `expiresAt`; the funds are assigned to the beneficiary.
    function confirm(uint256 id) external;

    /// @notice Beneficiary refuses before `expiresAt`; the funds are assigned to the sender.
    function reject(uint256 id) external;

    /// @notice Sender recovers the escrow from `expiresAt` on; the funds are assigned to the sender.
    function recoverExpired(uint256 id) external;

    /// @notice Withdraws from a resolved escrow to its holder. Only the holder can call it, as many times
    ///         as needed while the escrow has balance left.
    /// @dev Reverts unless the contract's balance drops by at most the escrow's balance, and the holder's
    ///      balance rises by at least `minReceived`.
    /// @param transferAmount Amount requested to the token, not including a fee the token charges on top.
    /// @param minReceived Least the holder must actually receive.
    function withdraw(uint256 id, uint256 transferAmount, uint256 minReceived) external;

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Returns an escrow with its computed deadlines. Reverts with `EscrowNotFound` if it does not exist.
    function getEscrow(uint256 id) external view returns (EscrowView memory);

    /// @notice Number of escrows created so far; valid ids are `1..escrowCount()`.
    function escrowCount() external view returns (uint256);

    /// @notice Time, in seconds since creation, during which the sender can cancel.
    function CANCEL_WINDOW() external view returns (uint64);

    /// @notice Time, in seconds since creation, after which the escrow expires.
    function TTL() external view returns (uint64);
}
