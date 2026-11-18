// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

import {ITransactionGuard} from "@safe-global/safe-smart-account/contracts/base/GuardManager.sol";
import {IModuleGuard} from "@safe-global/safe-smart-account/contracts/base/ModuleManager.sol";
import {Enum} from "@safe-global/safe-smart-account/contracts/libraries/Enum.sol";

contract FakeReplacementGuard is ITransactionGuard, IModuleGuard {
    address public immutable safe;
    address public immutable passkey;
    address public immutable ecdsaSecondary;
    address public immutable delay;
    uint64 public immutable periodSeconds;
    uint64 public immutable periodAnchor;
    address public maintenance;

    constructor(address safe_, address passkey_, address ecdsaSecondary_, address delay_) {
        safe = safe_;
        passkey = passkey_;
        ecdsaSecondary = ecdsaSecondary_;
        delay = delay_;
        periodSeconds = 86400;
        periodAnchor = 0;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(ITransactionGuard).interfaceId || interfaceId == type(IModuleGuard).interfaceId;
    }

    function config() external view returns (address, address, address, address, uint64, uint64) {
        return (safe, passkey, ecdsaSecondary, delay, periodSeconds, periodAnchor);
    }

    function setMaintenance(address maintenance_) external {
        maintenance = maintenance_;
    }

    function checkTransaction(address, uint256, bytes memory, Enum.Operation, uint256, uint256, uint256, address, address payable, bytes memory, address) external pure override {}
    function checkAfterExecution(bytes32, bool) external pure override {}
    function checkModuleTransaction(address, uint256, bytes memory, Enum.Operation, address) external pure override returns (bytes32) { return bytes32(0); }
    function checkAfterModuleExecution(bytes32, bool) external pure override {}
}
