// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, console} from "forge-std/Test.sol";

import {Escrow} from "../../src/Escrow.sol";
import {IEscrow} from "../../src/IEscrow.sol";
import {ITestToken} from "../utils/EscrowTestBase.sol";
import {EscrowHandler} from "./EscrowHandler.sol";

/// @dev Properties that must hold after any sequence of handler calls. Sums over escrows are read
///      from the contract itself (`getEscrow`), not from the handler's model, except where the
///      invariant is precisely that both agree.
contract EscrowInvariantsTest is Test {
    Escrow internal escrow;
    EscrowHandler internal handler;

    function setUp() public {
        vm.warp(1_760_000_000);
        escrow = new Escrow(2 hours, 7 days);
        handler = new EscrowHandler(escrow);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = EscrowHandler.createEscrow.selector;
        selectors[1] = EscrowHandler.cancel.selector;
        selectors[2] = EscrowHandler.confirm.selector;
        selectors[3] = EscrowHandler.reject.selector;
        selectors[4] = EscrowHandler.recoverExpired.selector;
        selectors[5] = EscrowHandler.withdraw.selector;
        selectors[6] = EscrowHandler.donate.selector;
        selectors[7] = EscrowHandler.warp.selector;
        selectors[8] = EscrowHandler.warpToDeadline.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev Solvency: per token, the escrow holds at least what it owes, that is, the balance of every
    ///      escrow, pending or resolved and not fully withdrawn. Includes the token that charges its fee
    ///      on top of the amount, which a withdrawal could otherwise take from other escrows.
    function invariant_HoldsEnoughForEveryEscrowBalance() public view {
        for (uint256 t; t < handler.tokenCount(); ++t) {
            address token = handler.tokens(t);
            assertGe(ITestToken(token).balanceOf(address(escrow)), _owed(token), "insolvent");
        }
    }

    /// @dev Exact accounting: per token, the balance is what was received, minus what withdrawals took
    ///      out, plus donations. Nothing leaks in or out through any other path.
    function invariant_BalanceMatchesAccounting() public view {
        for (uint256 t; t < handler.tokenCount(); ++t) {
            address token = handler.tokens(t);
            uint256 expected = handler.deposited(token) - handler.paidOut(token) + handler.donated(token);
            assertEq(ITestToken(token).balanceOf(address(escrow)), expected, "balance");
            assertEq(_owed(token) + handler.donated(token), expected, "owed");
        }
    }

    /// @dev Per token, the escrow never pays out more than it received for escrows.
    function invariant_NeverPaysOutMoreThanDeposited() public view {
        for (uint256 t; t < handler.tokenCount(); ++t) {
            address token = handler.tokens(t);
            assertLe(handler.paidOut(token), handler.deposited(token), "paid out");
        }
    }

    /// @dev Every escrow matches the model: its data never changes after creation, and its status and
    ///      `withdrawn` only changed through calls the model expected to succeed. In particular, a final
    ///      status never changes, nothing is withdrawn while pending, and never more than the amount.
    function invariant_EveryEscrowMatchesModel() public view {
        for (uint256 id = 1; id <= handler.created(); ++id) {
            IEscrow.EscrowView memory e = escrow.getEscrow(id);
            EscrowHandler.Model memory m = handler.model(id);
            assertEq(uint8(e.status), uint8(m.status), "status");
            assertEq(e.sender, m.sender, "sender");
            assertEq(e.beneficiary, m.beneficiary, "beneficiary");
            assertEq(e.token, m.token, "token");
            assertEq(e.amount, m.amount, "amount");
            assertEq(e.withdrawn, m.withdrawn, "withdrawn");
            assertLe(e.withdrawn, e.amount, "withdrawn above amount");
            if (e.status == IEscrow.Status.Pending) assertEq(e.withdrawn, 0, "withdrawn while pending");
            assertEq(e.createdAt, m.createdAt, "createdAt");
            assertEq(e.cancelDeadline, m.createdAt + escrow.CANCEL_WINDOW(), "cancelDeadline");
            assertEq(e.expiresAt, m.createdAt + escrow.TTL(), "expiresAt");
        }
    }

    /// @dev Ids go from 1 to `escrowCount`, one per creation; 0 and any id above it do not exist.
    function invariant_EscrowCountMatchesCreations() public view {
        uint256 count = escrow.escrowCount();
        assertEq(count, handler.created(), "escrowCount");
        _assertNotFound(0);
        _assertNotFound(count + 1);
        _assertNotFound(type(uint256).max);
    }

    /// @dev Prints how many calls of each kind succeeded or reverted as expected (visible with `-vv`).
    function afterInvariant() external view {
        string[5] memory names = ["cancel", "confirm", "reject", "recoverExpired", "withdraw"];
        console.log("escrows created:", handler.created());
        for (uint256 a; a < names.length; ++a) {
            console.log(names[a], handler.successes(a), handler.expectedReverts(a));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    /// @dev Sum of the balances (`amount - withdrawn`) of every escrow of `token`, read from the contract.
    function _owed(address token) internal view returns (uint256 sum) {
        for (uint256 id = 1; id <= escrow.escrowCount(); ++id) {
            IEscrow.EscrowView memory e = escrow.getEscrow(id);
            if (e.token == token) sum += e.amount - e.withdrawn;
        }
    }

    function _assertNotFound(uint256 id) internal view {
        try escrow.getEscrow(id) {
            revert("escrow should not exist");
        } catch (bytes memory reason) {
            assertEq(reason, abi.encodeWithSelector(IEscrow.EscrowNotFound.selector, id), "not found");
        }
    }
}
