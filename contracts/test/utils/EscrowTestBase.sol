// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {Escrow} from "../../src/Escrow.sol";
import {IEscrow} from "../../src/IEscrow.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @dev Minimal surface shared by all test tokens (some return nothing from `approve`).
interface ITestToken {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Common setup: an Escrow with the production windows, a standard token and three actors.
abstract contract EscrowTestBase is Test {
    uint64 internal constant CANCEL_WINDOW = 2 hours;
    uint64 internal constant TTL = 7 days;
    uint256 internal constant AMOUNT = 100e18;
    uint256 internal constant INITIAL_BALANCE = 1_000e18;

    /// @dev The four resolution actions, to iterate over them in matrix tests.
    enum Action {
        Cancel,
        Confirm,
        Reject,
        RecoverExpired
    }

    Escrow internal escrow;
    MockERC20 internal token;

    address internal sender = makeAddr("sender");
    address internal beneficiary = makeAddr("beneficiary");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        escrow = new Escrow(CANCEL_WINDOW, TTL);
        token = new MockERC20();
        _fund(address(token), sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    /// @dev Mints `INITIAL_BALANCE` to `account` and approves the escrow for all of it.
    function _fund(address testToken, address account) internal {
        ITestToken(testToken).mint(account, INITIAL_BALANCE);
        vm.prank(account);
        ITestToken(testToken).approve(address(escrow), type(uint256).max);
    }

    /// @dev Creates an escrow of `AMOUNT` standard tokens from `sender` to `beneficiary`.
    function _create() internal returns (uint256 id) {
        return _create(address(token), AMOUNT);
    }

    function _create(address testToken, uint256 amount) internal returns (uint256 id) {
        vm.prank(sender);
        id = escrow.createEscrow(testToken, beneficiary, amount);
    }

    /// @dev Calls `action` on `id` as the party allowed to perform it.
    function _act(Action action, uint256 id) internal {
        if (action == Action.Cancel) {
            vm.prank(sender);
            escrow.cancel(id);
        } else if (action == Action.Confirm) {
            vm.prank(beneficiary);
            escrow.confirm(id);
        } else if (action == Action.Reject) {
            vm.prank(beneficiary);
            escrow.reject(id);
        } else {
            vm.prank(sender);
            escrow.recoverExpired(id);
        }
    }

    /// @dev Calls `action` on `id` as `caller`.
    function _actAs(address caller, Action action, uint256 id) internal {
        vm.prank(caller);
        if (action == Action.Cancel) escrow.cancel(id);
        else if (action == Action.Confirm) escrow.confirm(id);
        else if (action == Action.Reject) escrow.reject(id);
        else escrow.recoverExpired(id);
    }

    /// @dev The holder of a resolved escrow withdraws its whole balance, with no minimum. Reads the escrow
    ///      first, so it cannot follow `vm.expectRevert`, which would apply to that read: use `_withdrawAs`.
    function _withdraw(uint256 id) internal {
        _withdraw(id, _balance(id), 0);
    }

    function _withdraw(uint256 id, uint256 transferAmount, uint256 minReceived) internal {
        _withdrawAs(_holder(id), id, transferAmount, minReceived);
    }

    function _withdrawAs(address caller, uint256 id, uint256 transferAmount, uint256 minReceived) internal {
        vm.prank(caller);
        escrow.withdraw(id, transferAmount, minReceived);
    }

    /// @dev Who can withdraw from a resolved escrow: the beneficiary if `Released`, the sender otherwise.
    function _holder(uint256 id) internal view returns (address) {
        IEscrow.EscrowView memory e = escrow.getEscrow(id);
        return e.status == IEscrow.Status.Released ? e.beneficiary : e.sender;
    }

    /// @dev What withdrawals can still take out of the contract for `id`.
    function _balance(uint256 id) internal view returns (uint256) {
        IEscrow.EscrowView memory e = escrow.getEscrow(id);
        return e.amount - e.withdrawn;
    }

    /// @dev Creates an escrow and drives it to the given final status, without withdrawing.
    function _createResolved(IEscrow.Status status) internal returns (uint256 id) {
        id = _create();
        _resolve(id, status);
    }

    /// @dev Drives a pending escrow to the given final status, moving time forward if it needs to expire.
    function _resolve(uint256 id, IEscrow.Status status) internal {
        if (status == IEscrow.Status.CancelledBySender) {
            _act(Action.Cancel, id);
        } else if (status == IEscrow.Status.Released) {
            _act(Action.Confirm, id);
        } else if (status == IEscrow.Status.Rejected) {
            _act(Action.Reject, id);
        } else if (status == IEscrow.Status.Expired) {
            vm.warp(_expiresAt(id));
            _act(Action.RecoverExpired, id);
        } else {
            revert("not a final status");
        }
    }

    function _createdAt(uint256 id) internal view returns (uint64) {
        return escrow.getEscrow(id).createdAt;
    }

    function _cancelDeadline(uint256 id) internal view returns (uint64) {
        return escrow.getEscrow(id).cancelDeadline;
    }

    function _expiresAt(uint256 id) internal view returns (uint64) {
        return escrow.getEscrow(id).expiresAt;
    }

    function _assertStatus(uint256 id, IEscrow.Status expected) internal view {
        assertEq(uint8(escrow.getEscrow(id).status), uint8(expected), "status");
    }

    function _finalStatuses() internal pure returns (IEscrow.Status[4] memory) {
        return
            [IEscrow.Status.CancelledBySender, IEscrow.Status.Released, IEscrow.Status.Rejected, IEscrow.Status.Expired];
    }

    function _actions() internal pure returns (Action[4] memory) {
        return [Action.Cancel, Action.Confirm, Action.Reject, Action.RecoverExpired];
    }
}
