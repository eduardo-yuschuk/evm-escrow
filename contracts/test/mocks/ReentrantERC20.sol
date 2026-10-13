// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MockERC20} from "./MockERC20.sol";

/// @dev Models a token with transfer hooks (ERC-777 style): before moving balances it calls
///      `target` with `payload` once, bubbling up any revert.
contract ReentrantERC20 is MockERC20 {
    address public target;
    bytes public payload;

    function setReentry(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 value) internal override {
        address reentryTarget = target;
        if (reentryTarget != address(0) && from != address(0) && to != address(0)) {
            target = address(0); // one-shot, so a successful reentry cannot recurse forever
            (bool success, bytes memory returnData) = reentryTarget.call(payload);
            if (!success) {
                assembly ("memory-safe") {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
        }
        super._update(from, to, value);
    }
}
