// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MockERC20} from "./MockERC20.sol";

/// @dev Token whose transfers return `false` instead of reverting, without moving any balance.
contract FalseReturnERC20 is MockERC20 {
    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}
