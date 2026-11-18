// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

import {ISafe} from "@safe-global/safe-smart-account/contracts/interfaces/ISafe.sol";
import {Enum} from "@safe-global/safe-smart-account/contracts/libraries/Enum.sol";

library PolicyDigest {
    /// @notice Returns the canonical Safe transaction hash for owner-path checks.
    /// @param safe Safe whose domain separator and nonce space are used.
    /// @param to Safe transaction destination.
    /// @param value Native value sent by the Safe transaction.
    /// @param data Safe transaction calldata.
    /// @param operation Safe operation type.
    /// @param safeTxGas Safe inner transaction gas field.
    /// @param baseGas Safe base gas reimbursement field.
    /// @param gasPrice Safe gas price reimbursement field.
    /// @param gasToken Safe gas token reimbursement field.
    /// @param refundReceiver Safe refund receiver field.
    /// @param nonce Safe nonce bound into the transaction hash.
    function safeTransactionHash(
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) internal view returns (bytes32) {
        return ISafe(payable(safe)).getTransactionHash(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce);
    }

    /// @notice Returns the guard-local digest for module-path checks.
    /// @dev Safe module guard hooks do not expose a Safe-native transaction hash,
    ///      so this digest binds the chain, Safe, module, target, value, calldata,
    ///      and operation for monitoring and post-check correlation.
    /// @param safe Safe whose module path is being checked.
    /// @param module Enabled module attempting execution.
    /// @param to Module transaction destination.
    /// @param value Native value sent by the module transaction.
    /// @param data Module transaction calldata.
    /// @param operation Module operation type.
    function moduleTransactionHash(
        address safe,
        address module,
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, safe, module, to, value, keccak256(data), operation));
    }
}
