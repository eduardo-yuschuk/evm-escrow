// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MockERC20} from "./MockERC20.sol";

/// @dev Burns `FEE_BPS` basis points of every transfer (mints and burns are not charged), so the
///      recipient gets less than `value`.
contract FeeOnTransferERC20 is MockERC20 {
    uint256 public immutable FEE_BPS;

    constructor(uint256 feeBps) {
        FEE_BPS = feeBps;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);

        uint256 fee = value * FEE_BPS / 10_000;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}
