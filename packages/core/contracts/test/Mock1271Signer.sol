// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

import "@safe-global/safe-smart-account/contracts/Safe.sol";
import "@safe-global/safe-smart-account/contracts/proxies/SafeProxy.sol";

contract Mock1271Signer {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return MAGICVALUE;
    }

    function revertCall() external pure {
        revert("intentional failure");
    }
}
