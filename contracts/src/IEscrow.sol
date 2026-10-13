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
interface IEscrow {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice Lifecycle of an escrow. Every status other than `Pending` is final.
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
    /// @param amount Amount actually received by the contract, which is what the escrow will pay out.
    event EscrowCreated(
        uint256 indexed id,
        address indexed sender,
        address indexed beneficiary,
        address token,
        uint256 amount,
        uint64 cancelDeadline,
        uint64 expiresAt
    );

    /// @notice The sender cancelled within the cancel window; funds returned to the sender.
    event EscrowCancelled(uint256 indexed id);

    /// @notice The beneficiary confirmed; funds sent to the beneficiary.
    event EscrowReleased(uint256 indexed id);

    /// @notice The beneficiary rejected; funds returned to the sender.
    event EscrowRejected(uint256 indexed id);

    /// @notice The sender recovered the funds after expiration.
    event EscrowExpired(uint256 indexed id);

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

    // ---------------------------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------------------------

    /// @notice Locks `amount` of `token` for `beneficiary`. Requires a prior `approve`.
    /// @dev Records the amount actually received, so fee-on-transfer tokens are supported.
    /// @return id Sequential id of the new escrow, starting at 1.
    function createEscrow(address token, address beneficiary, uint256 amount) external returns (uint256 id);

    /// @notice Sender cancels before `cancelDeadline`; funds return to the sender.
    function cancel(uint256 id) external;

    /// @notice Beneficiary accepts before `expiresAt`; funds go to the beneficiary.
    function confirm(uint256 id) external;

    /// @notice Beneficiary refuses before `expiresAt`; funds return to the sender.
    function reject(uint256 id) external;

    /// @notice Sender recovers the funds from `expiresAt` on.
    function recoverExpired(uint256 id) external;

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
