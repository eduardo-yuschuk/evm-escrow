// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MockERC20} from "./MockERC20.sol";

/// @dev Charges `FEE_BPS` basis points of every transfer to the payer, on top of `value` (mints and
///      burns are not charged): the recipient gets `value`, and the payer loses `value` plus the fee.
contract FeeOnTopERC20 is MockERC20 {
    uint256 public immutable FEE_BPS;

    constructor(uint256 feeBps) {
        FEE_BPS = feeBps;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);

        super._update(from, to, value);
        super._update(from, address(0), value * FEE_BPS / 10_000);
    }
}
