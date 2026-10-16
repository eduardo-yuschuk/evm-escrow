// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IEscrow} from "../src/IEscrow.sol";
import {EscrowTestBase} from "./utils/EscrowTestBase.sol";

/// @dev `withdraw` with a standard token. Tokens that charge fees are in EscrowTokens.t.sol.
contract EscrowWithdrawTest is EscrowTestBase {
    // ---------------------------------------------------------------------------------------------
    // Happy paths: the holder of each final status gets the funds
    // ---------------------------------------------------------------------------------------------

    function test_Withdraw_PaysTheHolderOfEachFinalStatus() public {
        IEscrow.Status[4] memory statuses = _finalStatuses();

        for (uint256 s; s < statuses.length; ++s) {
            uint256 id = _createResolved(statuses[s]);
            address holder = _holder(id);
            uint256 senderBefore = token.balanceOf(sender);
            uint256 beneficiaryBefore = token.balanceOf(beneficiary);

            vm.expectEmit(address(escrow));
            emit IEscrow.EscrowWithdrawn(id, AMOUNT, AMOUNT);
            _withdraw(id, AMOUNT, AMOUNT);

            // Only `Released` pays the beneficiary.
            bool toBeneficiary = statuses[s] == IEscrow.Status.Released;
            assertEq(holder, toBeneficiary ? beneficiary : sender, "holder");
            assertEq(token.balanceOf(beneficiary) - beneficiaryBefore, toBeneficiary ? AMOUNT : 0, "beneficiary");
            assertEq(token.balanceOf(sender) - senderBefore, toBeneficiary ? 0 : AMOUNT, "sender");
            assertEq(token.balanceOf(address(escrow)), 0, "escrow balance");
            assertEq(escrow.getEscrow(id).withdrawn, AMOUNT, "withdrawn");
            _assertStatus(id, statuses[s]);
        }
    }

    function test_Withdraw_InSeveralParts() public {
        uint256 id = _createResolved(IEscrow.Status.Released);

        _withdraw(id, 30e18, 30e18);
        assertEq(escrow.getEscrow(id).withdrawn, 30e18);
        assertEq(_balance(id), 70e18);
        assertEq(token.balanceOf(beneficiary), 30e18);

        _withdraw(id, 70e18, 70e18);
        assertEq(escrow.getEscrow(id).withdrawn, AMOUNT);
        assertEq(_balance(id), 0);
        assertEq(token.balanceOf(beneficiary), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountExceedsBalance.selector, id, 0, 1));
        _withdrawAs(beneficiary, id, 1, 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Reverts
    // ---------------------------------------------------------------------------------------------

    function test_RevertWhen_WithdrawingFromPendingEscrow() public {
        uint256 id = _create();
        address[2] memory parties = [sender, beneficiary];

        // Not even once it expired: the sender has to call `recoverExpired` first.
        for (uint256 expired; expired < 2; ++expired) {
            if (expired == 1) vm.warp(_expiresAt(id));
            for (uint256 p; p < parties.length; ++p) {
                vm.expectRevert(abi.encodeWithSelector(IEscrow.NotResolved.selector, id));
                vm.prank(parties[p]);
                escrow.withdraw(id, AMOUNT, 0);
            }
        }
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_RevertWhen_WithdrawingFromNonexistentEscrow() public {
        _createResolved(IEscrow.Status.Released);
        uint256[2] memory ids = [uint256(0), 2];

        for (uint256 i; i < ids.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowNotFound.selector, ids[i]));
            vm.prank(beneficiary);
            escrow.withdraw(ids[i], AMOUNT, 0);
        }
    }

    function test_RevertWhen_WithdrawIsNotCalledByHolder() public {
        IEscrow.Status[4] memory statuses = _finalStatuses();

        for (uint256 s; s < statuses.length; ++s) {
            uint256 id = _createResolved(statuses[s]);
            address otherParty = _holder(id) == sender ? beneficiary : sender;
            address[3] memory callers = [otherParty, stranger, address(this)];

            for (uint256 i; i < callers.length; ++i) {
                vm.expectRevert(abi.encodeWithSelector(IEscrow.NotHolder.selector, id, callers[i]));
                vm.prank(callers[i]);
                escrow.withdraw(id, AMOUNT, 0);
            }
            assertEq(_balance(id), AMOUNT);
        }
    }

    function test_RevertWhen_WithdrawingZero() public {
        uint256 id = _createResolved(IEscrow.Status.Rejected);

        vm.expectRevert(IEscrow.ZeroAmount.selector);
        _withdrawAs(sender, id, 0, 0);
    }

    function test_RevertWhen_WithdrawingMoreThanBalance() public {
        uint256 id = _createResolved(IEscrow.Status.CancelledBySender);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountExceedsBalance.selector, id, AMOUNT, AMOUNT + 1));
        _withdrawAs(sender, id, AMOUNT + 1, 0);

        _withdraw(id, 40e18, 0);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountExceedsBalance.selector, id, 60e18, 60e18 + 1));
        _withdrawAs(sender, id, 60e18 + 1, 0);
    }

    /// @dev Tokens donated to the contract, or held for other escrows, do not raise the limit.
    function test_RevertWhen_WithdrawingMoreThanBalance_WithOtherFundsInContract() public {
        uint256 id = _createResolved(IEscrow.Status.Released);
        _create();
        token.mint(address(escrow), AMOUNT);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountExceedsBalance.selector, id, AMOUNT, AMOUNT + 1));
        _withdrawAs(beneficiary, id, AMOUNT + 1, 0);
    }

    function test_RevertWhen_ReceivedBelowMinimum() public {
        uint256 id = _createResolved(IEscrow.Status.Released);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.ReceivedBelowMinimum.selector, id, AMOUNT, AMOUNT + 1));
        _withdrawAs(beneficiary, id, AMOUNT, AMOUNT + 1);

        assertEq(_balance(id), AMOUNT);
        assertEq(token.balanceOf(beneficiary), 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Order of checks: existence, resolution, caller, then amounts
    // ---------------------------------------------------------------------------------------------

    function test_RevertWhen_StrangerWithdrawsFromPendingEscrow_ReportsNotResolved() public {
        uint256 id = _create();

        vm.expectRevert(abi.encodeWithSelector(IEscrow.NotResolved.selector, id));
        vm.prank(stranger);
        escrow.withdraw(id, 0, 0);
    }

    function test_RevertWhen_StrangerWithdrawsInvalidAmount_ReportsCaller() public {
        uint256 id = _createResolved(IEscrow.Status.Released);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.NotHolder.selector, id, stranger));
        vm.prank(stranger);
        escrow.withdraw(id, 0, 0);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.NotHolder.selector, id, stranger));
        vm.prank(stranger);
        escrow.withdraw(id, AMOUNT + 1, 0);
    }
}
