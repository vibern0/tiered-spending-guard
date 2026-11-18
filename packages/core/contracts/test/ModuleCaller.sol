// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

import {Enum} from "@safe-global/safe-smart-account/contracts/libraries/Enum.sol";

interface ISafeModuleExecutor {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, Enum.Operation operation) external returns (bool success);
}

contract ModuleCaller {
    function execute(address safe, address to, uint256 value, bytes calldata data, Enum.Operation operation) external returns (bool) {
        return ISafeModuleExecutor(safe).execTransactionFromModule(to, value, data, operation);
    }
}
