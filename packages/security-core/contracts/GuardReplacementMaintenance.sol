// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

import {ITransactionGuard} from "@safe-global/safe-smart-account/contracts/base/GuardManager.sol";
import {IModuleGuard} from "@safe-global/safe-smart-account/contracts/base/ModuleManager.sol";

interface ISafeOwnerMaintenance {
    /// @notice Replaces the sole owner without temporarily violating threshold one.
    function swapOwner(address prevOwner, address oldOwner, address newOwner) external;
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

interface IGuardSignerRepair {
    /// @notice Returns the guard's configured Safe, signers, Delay, and period data.
    function config() external view returns (address safe, address passkey, address ecdsaSigner, address delay, uint64 periodSeconds, uint64 periodAnchor);

    /// @notice Replaces one signer role inside the guard configuration.
    function repairSigner(uint8 role, address expectedOld, address replacement) external;

    /// @notice Returns the configured Safe-contract secondary signer.
    function safeContractSecondary() external view returns (address signer, uint8 kind, bool enabled);

    /// @notice Returns the configured ECDSA secondary signer.
    function ecdsaSecondary() external view returns (address signer, uint8 kind, bool enabled);
}

interface IGuardMaintenance {
    /// @notice Returns the maintenance helper recorded by the guard.
    function maintenance() external view returns (address);
}

interface IERC1271Evidence {
    /// @notice ERC-1271 signature check used as passkey-contract evidence.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @notice The only delegatecall target permitted for dual-guard maintenance.
/// @dev This contract has one operation by design. It is executed by the Safe
///      through the verified Delay module; both setter calls are self-calls of
///      the Safe and therefore either both commit or both roll back.
contract GuardReplacementMaintenance {
    struct GuardRuntimeConfig {
        address configuredSafe;
        address passkey;
        address safeContractSecondary;
        bool safeContractSecondaryEnabled;
        address ecdsaSecondary;
        bool ecdsaSecondaryEnabled;
        address configuredDelay;
        uint64 periodSeconds;
        uint64 periodAnchor;
    }

    // Filled from the reviewed TieredSpendingGuard artifact during the Task 6
    // hardening build. Replacement is intentionally implementation-bound.
    bytes32 private constant APPROVED_GUARD_RUNTIME_CODE_HASH = 0x596a66022b0aa360ed7faa0ba2fa550480f6b750a3ccc44da125ff14eff38428;
    bytes4 private constant ERC1271_MAGICVALUE = 0x1626ba7e;
    bytes32 private constant LOCK_SLOT = 0x5c0a4f8b1c122f2b1c07f4f9d0f8cba2557d5f7d4a2a4c8a2e4a5c9fb19f0c11;
    bytes32 private constant GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 private constant MODULE_GUARD_SLOT = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;

    address public immutable safe;
    address public immutable delay;
    address private immutable self;

    error OnlyDelay();
    error WrongExecutionContext();
    error ReentrantCall();
    error InvalidReplacement();
    error SetterFailed();

    /// @param expectedSafe Safe that must execute this helper by delegatecall.
    /// @param verifiedDelay Delay module allowed to trigger the maintenance call.
    /// @param expectedSelf Precomputed CREATE address for reproducible reviewed deployment artifacts.
    constructor(address expectedSafe, address verifiedDelay, address expectedSelf) {
        require(expectedSafe != address(0) && verifiedDelay != address(0), "invalid setup");
        safe = expectedSafe;
        delay = verifiedDelay;
        self = expectedSelf == address(0) ? address(this) : expectedSelf;
    }

    function maintenanceAddress() external view returns (address) {
        return self;
    }

    /// @notice Atomically replaces both Safe guard slots with a reviewed guard.
    /// @dev Must be called by Delay while executing in the Safe's storage context.
    /// @param expectedGuard Current transaction and module guard address.
    /// @param replacement New guard whose runtime code hash and interfaces are checked.
    function replaceGuards(address expectedGuard, address replacement) external {
        if (msg.sender != delay) revert OnlyDelay();
        if (address(this) != safe) revert WrongExecutionContext();
        bool locked;
        assembly { locked := sload(LOCK_SLOT) }
        if (locked) revert ReentrantCall();
        assembly { sstore(LOCK_SLOT, 1) }

        address currentGuard;
        address currentModuleGuard;
        assembly {
            currentGuard := sload(GUARD_SLOT)
            currentModuleGuard := sload(MODULE_GUARD_SLOT)
        }
        if (expectedGuard == address(0) || replacement == address(0) || currentGuard != expectedGuard || currentModuleGuard != expectedGuard) revert InvalidReplacement();
        if (!_isApprovedGuardImplementation(replacement)) revert InvalidReplacement();
        if (!_supports(replacement, type(ITransactionGuard).interfaceId) || !_supports(replacement, type(IModuleGuard).interfaceId)) revert InvalidReplacement();
        if (!_configureReplacementSecondary(expectedGuard, replacement)) revert InvalidReplacement();
        if (!_matchesReplacementGuardConfiguration(expectedGuard, replacement)) revert InvalidReplacement();

        (bool first,) = address(this).call(abi.encodeWithSignature("setGuard(address)", replacement));
        (bool second,) = address(this).call(abi.encodeWithSignature("setModuleGuard(address)", replacement));
        (bool configured,) = replacement.call(abi.encodeWithSignature("setMaintenance(address)", self));
        if (!first || !second || !configured || !_hasMaintenance(replacement)) revert SetterFailed();
        assembly { sstore(LOCK_SLOT, 0) }
    }

    /// @notice Updates a guard signer; only primary rotation changes the sole Safe owner.
    /// @dev Used by delayed signer repair so Safe ownership and guard policy do
    ///      not diverge. Primary and Safe-contract secondary replacements must provide ERC-1271 evidence.
    /// @param guard Current guard installed in both Safe guard slots.
    /// @param role Signer role: 0 primary passkey, 1 secondary signer.
    /// @param expectedOld Current signer that must be present in guard config.
    /// @param replacement New signer for both guard config and Safe owners.
    /// @param previousOwner Previous Safe linked-list owner before expectedOld.
    /// @param threshold Safe owner threshold to preserve after owner changes.
    function replaceSigner(
        address guard,
        uint8 role,
        address expectedOld,
        address replacement,
        address previousOwner,
        uint256 threshold,
        bytes calldata replacementProof
    ) external {
        if (msg.sender != delay) revert OnlyDelay();
        if (address(this) != safe) revert WrongExecutionContext();
        if (guard == address(0) || expectedOld == address(0) || replacement == address(0) || replacement == expectedOld || role > 1 || threshold != 1) revert InvalidReplacement();
        if ((role == 0 && previousOwner != address(1)) || (role == 1 && previousOwner != address(0))) revert InvalidReplacement();
        address[] memory owners = ISafeOwnerMaintenance(address(this)).getOwners();
        (, address primary,,,,) = IGuardSignerRepair(guard).config();
        if (owners.length != 1 || owners[0] != primary || ISafeOwnerMaintenance(address(this)).getThreshold() != 1) revert InvalidReplacement();
        address currentGuard;
        address currentModuleGuard;
        assembly {
            currentGuard := sload(GUARD_SLOT)
            currentModuleGuard := sload(MODULE_GUARD_SLOT)
        }
        if (currentGuard != guard || currentModuleGuard != guard || !_matchesGuardConfiguration(guard, expectedOld, role)) revert InvalidReplacement();
        bool replacingSafeContractSigner = _isSafeContractSignerReplacement(guard, expectedOld, role);
        if (role == 0 || replacingSafeContractSigner) {
            if (!_hasContract1271Evidence(replacement, guard, expectedOld, replacementProof)) revert InvalidReplacement();
        } else if (replacementProof.length != 0) revert InvalidReplacement();
        (bool repaired,) = guard.call(abi.encodeWithSelector(IGuardSignerRepair.repairSigner.selector, role, expectedOld, replacement));
        if (!repaired) revert SetterFailed();
        if (role == 0) {
            (bool swapped,) = address(this).call(abi.encodeWithSelector(ISafeOwnerMaintenance.swapOwner.selector, previousOwner, expectedOld, replacement));
            if (!swapped) revert SetterFailed();
        }
    }

    /// @dev Checks ERC-165 support on a candidate replacement.
    function _supports(address candidate, bytes4 interfaceId) private view returns (bool supported) {
        (bool ok, bytes memory result) = candidate.staticcall(abi.encodeWithSelector(0x01ffc9a7, interfaceId));
        supported = ok && result.length == 32 && abi.decode(result, (bool));
    }

    /// @dev Requires nonempty code and the reviewed guard runtime code hash.
    function _isApprovedGuardImplementation(address candidate) private view returns (bool approved) {
        uint256 codeSize;
        bytes32 codeHash;
        assembly {
            codeSize := extcodesize(candidate)
            codeHash := extcodehash(candidate)
        }
        approved = codeSize != 0 && codeHash == APPROVED_GUARD_RUNTIME_CODE_HASH;
    }

    /// @dev Confirms a passkey replacement is a contract exposing ERC-1271.
    function _hasContract1271Evidence(address candidate, address guard, address expectedOld, bytes calldata replacementProof) private view returns (bool) {
        uint256 codeSize;
        assembly { codeSize := extcodesize(candidate) }
        if (codeSize == 0) return false;
        bytes32 proofHash = keccak256(abi.encode("RecentTxSafeGuard.passkeyReplacement.v1", block.chainid, safe, delay, guard, expectedOld, candidate));
        (bool ok, bytes memory result) = candidate.staticcall(
            abi.encodeWithSelector(IERC1271Evidence.isValidSignature.selector, proofHash, replacementProof)
        );
        return ok && result.length == 32 && abi.decode(result, (bytes4)) == ERC1271_MAGICVALUE;
    }

    /// @dev Confirms a replacement guard recorded this helper as maintenance.
    function _hasMaintenance(address candidate) private view returns (bool) {
        (bool ok, bytes memory result) = candidate.staticcall(abi.encodeWithSelector(IGuardMaintenance.maintenance.selector));
        return ok && result.length == 32 && abi.decode(result, (address)) == self;
    }

    /// @dev Binds a reviewed replacement guard to the current Safe-contract secondary before comparing configs.
    function _configureReplacementSecondary(address current, address replacement) private returns (bool) {
        (bool ok, GuardRuntimeConfig memory currentConfig) = _readGuardConfiguration(current);
        if (!ok) return false;
        (bool configured,) = replacement.call(abi.encodeWithSignature("configureSafeContractSecondary(address,bool)", currentConfig.safeContractSecondary, currentConfig.safeContractSecondaryEnabled));
        return configured;
    }

    /// @dev Checks the candidate guard still targets this Safe, Delay, and signer set.
    /// @param candidate Guard whose config is being checked.
    /// @param expectedOld Optional signer expected for the selected role.
    /// @param role Signer role to compare when expectedOld is provided.
    function _matchesGuardConfiguration(address candidate, address expectedOld, uint8 role) private view returns (bool) {
        (bool ok, GuardRuntimeConfig memory guardConfig) = _readGuardConfiguration(candidate);
        if (!ok) return false;
        if (
            guardConfig.configuredSafe != safe || guardConfig.configuredDelay != delay || guardConfig.periodSeconds != 86400 ||
            guardConfig.passkey == address(0) || guardConfig.safeContractSecondary == address(0) || guardConfig.ecdsaSecondary == address(0) ||
            !guardConfig.ecdsaSecondaryEnabled ||
            guardConfig.passkey == guardConfig.ecdsaSecondary || guardConfig.passkey == guardConfig.safeContractSecondary || guardConfig.safeContractSecondary == guardConfig.ecdsaSecondary
        ) return false;
        if (expectedOld == address(0)) return true;
        if (role == 0) return guardConfig.passkey == expectedOld;
        if (role == 1) return guardConfig.ecdsaSecondary == expectedOld || guardConfig.safeContractSecondary == expectedOld;
        return false;
    }

    /// @dev Confirms replacement guards preserve current Safe, Delay, signer, and period binding.
    function _matchesReplacementGuardConfiguration(address current, address replacement) private view returns (bool) {
        (bool currentOk, GuardRuntimeConfig memory currentConfig) = _readGuardConfiguration(current);
        (bool replacementOk, GuardRuntimeConfig memory replacementConfig) = _readGuardConfiguration(replacement);
        if (!currentOk || !replacementOk) return false;
        if (
            currentConfig.configuredSafe != safe || replacementConfig.configuredSafe != safe ||
            currentConfig.configuredDelay != delay || replacementConfig.configuredDelay != delay ||
            currentConfig.periodSeconds != 86400 || replacementConfig.periodSeconds != currentConfig.periodSeconds ||
            replacementConfig.periodAnchor != currentConfig.periodAnchor ||
            currentConfig.passkey == address(0) || currentConfig.safeContractSecondary == address(0) || currentConfig.ecdsaSecondary == address(0) ||
            !currentConfig.ecdsaSecondaryEnabled ||
            currentConfig.passkey == currentConfig.ecdsaSecondary || currentConfig.passkey == currentConfig.safeContractSecondary || currentConfig.safeContractSecondary == currentConfig.ecdsaSecondary
        ) return false;
        return replacementConfig.passkey == currentConfig.passkey && replacementConfig.safeContractSecondary == currentConfig.safeContractSecondary && replacementConfig.ecdsaSecondary == currentConfig.ecdsaSecondary && replacementConfig.safeContractSecondaryEnabled == currentConfig.safeContractSecondaryEnabled && replacementConfig.ecdsaSecondaryEnabled == currentConfig.ecdsaSecondaryEnabled;
    }

    /// @dev Reads the guard config ABI shared by approved guard implementations.
    function _readGuardConfiguration(address candidate) private view returns (bool ok, GuardRuntimeConfig memory guardConfig) {
        (bool callOk, bytes memory result) = candidate.staticcall(abi.encodeWithSelector(IGuardSignerRepair.config.selector));
        if (!callOk || result.length != 192) return (false, guardConfig);
        (
            guardConfig.configuredSafe,
            guardConfig.passkey,
            guardConfig.ecdsaSecondary,
            guardConfig.configuredDelay,
            guardConfig.periodSeconds,
            guardConfig.periodAnchor
        ) = abi.decode(result, (address, address, address, address, uint64, uint64));
        (bool safeContractOk, bytes memory safeContractResult) = candidate.staticcall(abi.encodeWithSelector(IGuardSignerRepair.safeContractSecondary.selector));
        if (!safeContractOk || safeContractResult.length != 96) return (false, guardConfig);
        (address configuredSafeContractSecondary, uint8 safeContractKind, bool safeContractEnabled) = abi.decode(safeContractResult, (address, uint8, bool));
        guardConfig.safeContractSecondary = configuredSafeContractSecondary;
        guardConfig.safeContractSecondaryEnabled = safeContractEnabled;
        if (safeContractKind != 0) return (false, guardConfig);
        (bool ecdsaSecondaryOk, bytes memory ecdsaSecondaryResult) = candidate.staticcall(abi.encodeWithSelector(IGuardSignerRepair.ecdsaSecondary.selector));
        if (!ecdsaSecondaryOk || ecdsaSecondaryResult.length != 96) return (false, guardConfig);
        (address configuredEcdsaSecondary, uint8 ecdsaSecondaryKind, bool ecdsaSecondaryEnabled) = abi.decode(ecdsaSecondaryResult, (address, uint8, bool));
        guardConfig.ecdsaSecondaryEnabled = ecdsaSecondaryEnabled;
        if (ecdsaSecondaryKind != 1 || configuredEcdsaSecondary != guardConfig.ecdsaSecondary) return (false, guardConfig);
        return (true, guardConfig);
    }

    function _isSafeContractSignerReplacement(address guard, address expectedOld, uint8 role) private view returns (bool) {
        if (role != 1) return false;
        (bool ok, GuardRuntimeConfig memory guardConfig) = _readGuardConfiguration(guard);
        return ok && guardConfig.safeContractSecondary == expectedOld;
    }
}
