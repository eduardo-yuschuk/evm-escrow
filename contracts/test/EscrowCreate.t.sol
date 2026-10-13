// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {Escrow} from "../src/Escrow.sol";
import {IEscrow} from "../src/IEscrow.sol";
import {EscrowTestBase} from "./utils/EscrowTestBase.sol";

contract EscrowConstructorTest is Test {
    function test_Constructor_SetsWindows() public {
        Escrow escrow = new Escrow(2 hours, 7 days);

        assertEq(escrow.CANCEL_WINDOW(), 2 hours);
        assertEq(escrow.TTL(), 7 days);
        assertEq(escrow.escrowCount(), 0);
    }

    function test_RevertWhen_CancelWindowIsZero() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.InvalidWindows.selector, 0, 7 days));
        new Escrow(0, 7 days);
    }

    function test_RevertWhen_CancelWindowEqualsTtl() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.InvalidWindows.selector, 7 days, 7 days));
        new Escrow(7 days, 7 days);
    }

    function test_RevertWhen_CancelWindowExceedsTtl() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.InvalidWindows.selector, 8 days, 7 days));
        new Escrow(8 days, 7 days);
    }
}

contract EscrowCreateTest is EscrowTestBase {
    // ---------------------------------------------------------------------------------------------
    // Happy path
    // ---------------------------------------------------------------------------------------------

    function test_Create_StoresPendingEscrow() public {
        uint256 id = _create();

        IEscrow.EscrowView memory e = escrow.getEscrow(id);
        assertEq(e.sender, sender);
        assertEq(e.beneficiary, beneficiary);
        assertEq(e.token, address(token));
        assertEq(e.amount, AMOUNT);
        assertEq(e.createdAt, block.timestamp);
        assertEq(e.cancelDeadline, block.timestamp + CANCEL_WINDOW);
        assertEq(e.expiresAt, block.timestamp + TTL);
        assertEq(uint8(e.status), uint8(IEscrow.Status.Pending));
    }

    function test_Create_LocksTokensInEscrow() public {
        _create();

        assertEq(token.balanceOf(sender), INITIAL_BALANCE - AMOUNT);
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_Create_EmitsEscrowCreated() public {
        uint64 createdAt = uint64(block.timestamp);

        vm.expectEmit(address(escrow));
        emit IEscrow.EscrowCreated(
            1, sender, beneficiary, address(token), AMOUNT, createdAt + CANCEL_WINDOW, createdAt + TTL
        );
        _create();
    }

    function test_Create_AssignsSequentialIdsStartingAtOne() public {
        assertEq(_create(), 1);
        assertEq(_create(), 2);
        assertEq(_create(), 3);
        assertEq(escrow.escrowCount(), 3);
    }

    // ---------------------------------------------------------------------------------------------
    // Input validation
    // ---------------------------------------------------------------------------------------------

    function test_RevertWhen_AmountIsZero() public {
        vm.expectRevert(IEscrow.ZeroAmount.selector);
        _create(address(token), 0);
    }

    function test_RevertWhen_BeneficiaryIsZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.InvalidBeneficiary.selector, address(0)));
        vm.prank(sender);
        escrow.createEscrow(address(token), address(0), AMOUNT);
    }

    function test_RevertWhen_BeneficiaryIsSender() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.InvalidBeneficiary.selector, sender));
        vm.prank(sender);
        escrow.createEscrow(address(token), sender, AMOUNT);
    }

    function test_RevertWhen_TokenIsZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.InvalidToken.selector, address(0)));
        _create(address(0), AMOUNT);
    }

    function test_RevertWhen_TokenHasNoCode() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(IEscrow.InvalidToken.selector, eoa));
        _create(eoa, AMOUNT);
    }

    function test_RevertWhen_AllowanceIsInsufficient() public {
        token.mint(stranger, AMOUNT);

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(escrow), 0, AMOUNT)
        );
        vm.prank(stranger);
        escrow.createEscrow(address(token), beneficiary, AMOUNT);
    }

    function test_RevertWhen_BalanceIsInsufficient() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, sender, INITIAL_BALANCE, INITIAL_BALANCE + 1
            )
        );
        _create(address(token), INITIAL_BALANCE + 1);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function test_RevertWhen_GettingEscrowIdZero() public {
        _create();

        vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowNotFound.selector, 0));
        escrow.getEscrow(0);
    }

    function test_RevertWhen_GettingEscrowNotCreatedYet() public {
        _create();

        vm.expectRevert(abi.encodeWithSelector(IEscrow.EscrowNotFound.selector, 2));
        escrow.getEscrow(2);
    }
}
