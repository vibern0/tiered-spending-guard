// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

import {Enum} from "@gnosis.pm/safe-contracts/contracts/common/Enum.sol";
import {Guard} from "@gnosis.pm/safe-contracts/contracts/base/GuardManager.sol";
import {GnosisSafe} from "@gnosis.pm/safe-contracts/contracts/GnosisSafe.sol";
import {OwnerManager} from "@gnosis.pm/safe-contracts/contracts/base/OwnerManager.sol";
import "hardhat/console.sol";

contract RecentTransactionGuard is Guard {
    uint256 public blockValidationIntervalThreashold = 50;
    uint256 public blockValidationTimeout = 8;
    uint256 public txLastBlock = 0;
    uint256 public nextTxValidatedBlock = 0;
    address public safeValidatorAddress = address(0);

    modifier onlySafe() {
        // GnosisSafe safe = GnosisSafe(payable(msg.sender));
        // require(safe.isOwner(msg.sender), "Not an owner");
        _;
    }

    // solhint-disable-next-line payable-fallback
    fallback() external {
        // We don't revert on fallback to avoid issues in case of a Safe upgrade
        // E.g. The expected check method might change and then the Safe would be locked.
    }

    // guard management functions
    function setPublicSafeValidatorAddress(
        address _safeValidatorAddress
    ) external onlySafe {
        safeValidatorAddress = _safeValidatorAddress;
    }

    function updateBlockValidationIntervalThreshold(
        uint256 _blockValidationIntervalThreshold
    ) external onlySafe {
        blockValidationIntervalThreashold = _blockValidationIntervalThreshold;
    }

    function updateBlockValidationTimeoutThreshold(
        uint256 _blockValidationTimeoutThreshold
    ) external onlySafe {
        blockValidationTimeout = _blockValidationTimeoutThreshold;
    }

    // guard validation
    function validateNext() external {
        require(msg.sender == safeValidatorAddress, "Not a Safe Validator");
        nextTxValidatedBlock = block.number;
    }

    // guard functions
    function checkTransaction(
        address,
        uint256,
        bytes memory,
        Enum.Operation,
        uint256,
        uint256,
        uint256,
        address,
        // solhint-disable-next-line no-unused-vars
        address payable,
        bytes memory,
        address
    ) external override {
        // Check if the last transaction was too long ago
        bool isUnderFirstInterval = block.number - nextTxValidatedBlock <
            blockValidationTimeout &&
            nextTxValidatedBlock != 0;
        bool isUnderRecentUsage = block.number - txLastBlock <
            blockValidationIntervalThreashold &&
            txLastBlock != 0 &&
            nextTxValidatedBlock != 0;
        require(
            isUnderFirstInterval || isUnderRecentUsage,
            "Transaction validation interval not reached"
        );
        // Update the last block
        nextTxValidatedBlock = 0;
        txLastBlock = block.number;
    }

    function checkAfterExecution(
        bytes32 txHash,
        bool success
    ) external override {
        // not validation needed
    }
}
