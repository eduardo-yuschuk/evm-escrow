// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IEscrow} from "../../src/IEscrow.sol";

/// @dev Sender that exploits a token hook (ERC-777 `tokensToSend` style) to reenter `createEscrow`
///      while its own deposit is in flight. Without a reentrancy guard, the outer call measures both
///      deposits as its own: the attacker deposits 2 x amount but escrows record 3 x amount.
contract ReentrancyAttacker {
    IEscrow private immutable ESCROW;
    address private immutable TOKEN;
    address private immutable BENEFICIARY;
    uint256 private immutable AMOUNT;

    constructor(IEscrow escrow, address token, address beneficiary, uint256 amount) {
        ESCROW = escrow;
        TOKEN = token;
        BENEFICIARY = beneficiary;
        AMOUNT = amount;
        IERC20(token).approve(address(escrow), type(uint256).max);
    }

    function attack() external returns (uint256) {
        return ESCROW.createEscrow(TOKEN, BENEFICIARY, AMOUNT);
    }

    /// @dev Called by the token hook during the outer deposit.
    function reenter() external returns (uint256) {
        return ESCROW.createEscrow(TOKEN, BENEFICIARY, AMOUNT);
    }
}
