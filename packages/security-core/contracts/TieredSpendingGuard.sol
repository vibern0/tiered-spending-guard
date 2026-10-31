// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

import {IERC165} from "@safe-global/safe-smart-account/contracts/interfaces/IERC165.sol";
import {ITransactionGuard} from "@safe-global/safe-smart-account/contracts/base/GuardManager.sol";
import {IModuleGuard} from "@safe-global/safe-smart-account/contracts/base/ModuleManager.sol";
import {ISafe} from "@safe-global/safe-smart-account/contracts/interfaces/ISafe.sol";
import {Enum} from "@safe-global/safe-smart-account/contracts/libraries/Enum.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {PolicyDigest} from "./libraries/PolicyDigest.sol";
import {SafeSignatureDecoder} from "./libraries/SafeSignatureDecoder.sol";

interface IDelayPolicy {
    /// @notice Returns the Delay cooldown, in seconds, for queued transactions.
    function txCooldown() external view returns (uint256);

    /// @notice Returns the Delay expiration, in seconds, after cooldown.
    function txExpiration() external view returns (uint256);
}

/// @notice Safe guard that enforces primary passkey, secondary signer, and Delay policy.
/// @dev Installed as both the Safe transaction guard and module guard. The Safe
///      still validates the threshold signature first; this guard then narrows
///      which signer and transaction shape are acceptable for each policy tier.
contract TieredSpendingGuard is ITransactionGuard, IModuleGuard {
    enum AuthorizationTier { Base, StepUp, DelayedProposal, Emergency }
    enum SignerRole { Primary, Secondary }
    enum SignerKind { SafeContractSignature, EcdsaExtension }

    struct GuardConfig {
        address safe;
        address passkey;
        address ecdsaSecondary;
        address delay;
        uint64 periodSeconds;
        uint64 periodAnchor;
    }

    struct SignerConfig {
        address signer;
        SignerRole role;
        SignerKind kind;
        bool enabled;
    }

    struct SecondarySignerConfig {
        address signer;
        SignerKind kind;
        bool enabled;
    }

    struct AssetPolicy {
        uint256 basePerTransaction;
        uint256 stepUpPerTransaction;
        uint256 baseDailyLimit;
        uint256 instantDailyLimit;
    }

    struct SpendState {
        uint256 window;
        uint256 baseSpent;
        uint256 instantSpent;
    }

    bytes32 public constant ECDSA_SECONDARY_SIGNATURE_TYPE_HASH = keccak256("TieredSpendingGuard.EcdsaSecondarySignature.v1");
    bytes4 private constant ERC1271_MAGICVALUE = 0x1626ba7e;
    bytes4 private constant DELAY_QUEUE_SELECTOR = 0x468721a7; // execTransactionFromModule(address,uint256,bytes,uint8)
    bytes4 private constant DELAY_SET_NONCE_SELECTOR = 0x46ba2307; // setTxNonce(uint256)
    bytes4 private constant FREEZE_SELECTOR = bytes4(keccak256("freeze()"));
    bytes4 private constant REPLACE_GUARDS_SELECTOR = 0x7ec60d4f;
    bytes4 private constant REPLACE_SIGNER_SELECTOR = bytes4(keccak256("replaceSigner(address,uint8,address,address,address,uint256,bytes)"));
    bytes4 private constant CONFIGURE_SAFE_CONTRACT_SECONDARY_SELECTOR = bytes4(keccak256("configureSafeContractSecondary(address,bool)"));
    bytes4 private constant SAFE_REMOVE_OWNER_SELECTOR = bytes4(keccak256("removeOwner(address,address,uint256)"));
    bytes4 private constant REPAIR_POLICY_SELECTOR = bytes4(keccak256("repairPolicy(address,uint256,uint256,uint256,uint256,address[])"));
    bytes4 private constant SET_ASSET_POLICY_SELECTOR = bytes4(keccak256("setAssetPolicy(address,uint256,uint256,uint256,uint256,address[])"));

    GuardConfig public config;
    mapping(address => AssetPolicy) public assetPolicy;
    mapping(address => SpendState) public spendState;
    mapping(address => mapping(address => bool)) public allowedRecipient;
    mapping(address => address[]) private policyRecipients;
    address[] private configuredTokens;
    mapping(address => bool) private configuredToken;
    mapping(bytes32 => bool) public ecdsaSecondaryAuthorizationUsed;
    bool private checking;
    address private pendingToken;
    address private pendingRecipient;
    uint256 private pendingAmount;
    uint256 private pendingSafeBalance;
    uint256 private pendingRecipientBalance;
    bool private pendingTokenProof;
    address public maintenance;
    bool public frozen;

    error OnlySafe();
    error ReentrantCheck();
    error NonZeroSafeTxGas();
    error NonZeroGasPrice();
    error InvalidConfig();
    error InvalidPasskeySignature();
    error MissingEcdsaSecondaryExtension();
    error MalformedEcdsaSecondaryExtension();
    error WrongEcdsaSecondaryExtensionType();
    error InvalidEcdsaSecondaryExtensionLength();
    error InvalidEcdsaSecondarySignature();
    error ExecutionFailed();
    error NoPendingCheck();
    error UnsupportedTransfer();
    error InvalidAssetPolicy();
    error TransferExceedsLimit();
    error RecipientNotAllowed();
    error InvalidDelayedAction();
    error Frozen();
    error MaintenanceAlreadySet();
    error InvalidRepair();
    error InvalidSecondarySigner();
    error InvalidSecondarySignature();
    error DuplicateSecondarySignature();

    event TransferAuthorized(
        AuthorizationTier tier,
        address token,
        address recipient,
        uint256 amount,
        uint256 baseSpent,
        uint256 instantSpent,
        uint256 window
    );

    SignerConfig public primarySigner;
    SecondarySignerConfig public safeContractSecondary;
    SecondarySignerConfig public ecdsaSecondary;

    /// @param initialConfig Core Safe, signer, Delay, and spending-window settings.
    constructor(GuardConfig memory initialConfig) {
        if (
            initialConfig.safe == address(0) || initialConfig.passkey == address(0) || initialConfig.delay == address(0) ||
            (initialConfig.ecdsaSecondary != address(0) && initialConfig.passkey == initialConfig.ecdsaSecondary) ||
            initialConfig.periodSeconds != 86400
        ) revert InvalidConfig();
        config = initialConfig;
        primarySigner = SignerConfig(initialConfig.passkey, SignerRole.Primary, SignerKind.SafeContractSignature, true);
        ecdsaSecondary = SecondarySignerConfig(
            initialConfig.ecdsaSecondary,
            SignerKind.EcdsaExtension,
            initialConfig.ecdsaSecondary != address(0)
        );
    }

    /// @notice Sets or tightens the spending policy for one token.
    /// @dev A configured policy may only be tightened on the immediate Safe path.
    ///      Broader policy repair must go through the delayed repair path.
    /// @param token Asset being configured. Use address(0) for native currency.
    /// @param basePerTransaction Maximum passkey-only amount for one transfer.
    /// @param stepUpPerTransaction Maximum secondary-approved amount for one transfer.
    /// @param baseDailyLimit Cumulative passkey-only amount per policy window.
    /// @param instantDailyLimit Cumulative base plus step-up amount per window.
    /// @param recipients Exact recipient allowlist for this asset.
    function setAssetPolicy(
        address token,
        uint256 basePerTransaction,
        uint256 stepUpPerTransaction,
        uint256 baseDailyLimit,
        uint256 instantDailyLimit,
        address[] calldata recipients
    ) external onlySafe {
        if (
            basePerTransaction == 0 || stepUpPerTransaction == 0 || baseDailyLimit == 0 ||
            instantDailyLimit <= baseDailyLimit || basePerTransaction > baseDailyLimit ||
            stepUpPerTransaction > instantDailyLimit || recipients.length == 0
        ) revert InvalidAssetPolicy();
        AssetPolicy memory previous = assetPolicy[token];
        if (previous.instantDailyLimit != 0) {
            if (basePerTransaction > previous.basePerTransaction || stepUpPerTransaction > previous.stepUpPerTransaction || baseDailyLimit > previous.baseDailyLimit || instantDailyLimit > previous.instantDailyLimit) revert InvalidAssetPolicy();
            for (uint256 i; i < recipients.length; ++i) {
                if (!allowedRecipient[token][recipients[i]]) revert InvalidAssetPolicy();
            }
        }
        assetPolicy[token] = AssetPolicy(basePerTransaction, stepUpPerTransaction, baseDailyLimit, instantDailyLimit);
        if (!configuredToken[token]) { configuredToken[token] = true; configuredTokens.push(token); }
        address[] storage previousRecipients = policyRecipients[token];
        for (uint256 i; i < previousRecipients.length; ++i) {
            allowedRecipient[token][previousRecipients[i]] = false;
        }
        delete policyRecipients[token];
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0)) revert InvalidAssetPolicy();
            allowedRecipient[token][recipients[i]] = true;
            policyRecipients[token].push(recipients[i]);
        }
    }

    /// @notice Records the delegatecall helper used for delayed guard/signature repairs.
    /// @param replacementMaintenance Maintenance contract reviewed for delayed repairs.
    function setMaintenance(address replacementMaintenance) external onlySafe {
        if (maintenance != address(0) || replacementMaintenance == address(0)) revert MaintenanceAlreadySet();
        maintenance = replacementMaintenance;
    }

    /// @notice Configures the Safe-contract secondary signer used for step-up approvals.
    /// @dev Intended for atomic setup before the guard is installed, or future delayed maintenance.
    /// @param signer Guard-only contract signer that validates exact Safe transaction digests.
    /// @param enabled Whether this secondary approval path may satisfy step-up and delayed authorization.
    function configureSafeContractSecondary(address signer, bool enabled) external onlySafe {
        if (signer != address(0) && (signer == config.passkey || signer == config.ecdsaSecondary)) revert InvalidSecondarySigner();
        if (enabled && signer == address(0)) revert InvalidSecondarySigner();
        safeContractSecondary = SecondarySignerConfig(signer, SignerKind.SafeContractSignature, enabled);
    }

    /// @notice Freezes immediate transfer execution.
    /// @dev Primary plus an enabled configured secondary can invoke this as an emergency action. The delayed repair
    ///      paths remain available so the Safe is not permanently bricked.
    function freeze() external onlySafe {
        frozen = true;
    }

    /// @notice Repairs one configured signer after the delayed path approves it.
    /// @param role Signer role: 0 primary passkey, 1 secondary signer.
    /// @param expectedOld Current signer that must still match guard config.
    /// @param replacement New signer address for the role.
    function repairSigner(uint8 role, address expectedOld, address replacement) external onlySafe {
        if (replacement == address(0) || expectedOld == address(0) || role > 1 || replacement == expectedOld) revert InvalidRepair();
        if (role == 0) {
            if (config.passkey != expectedOld || replacement == config.ecdsaSecondary || replacement == safeContractSecondary.signer) revert InvalidRepair();
            config.passkey = replacement;
            primarySigner = SignerConfig(replacement, SignerRole.Primary, SignerKind.SafeContractSignature, true);
        } else if (config.ecdsaSecondary == expectedOld) {
            if (replacement == config.passkey || replacement == safeContractSecondary.signer) revert InvalidRepair();
            config.ecdsaSecondary = replacement;
            ecdsaSecondary = SecondarySignerConfig(replacement, SignerKind.EcdsaExtension, true);
        } else if (safeContractSecondary.signer == expectedOld && safeContractSecondary.kind == SignerKind.SafeContractSignature) {
            if (replacement == config.passkey || replacement == config.ecdsaSecondary) revert InvalidRepair();
            safeContractSecondary = SecondarySignerConfig(replacement, SignerKind.SafeContractSignature, true);
        } else {
            revert InvalidRepair();
        }
    }

    /// @notice Replaces one asset policy through the delayed repair path.
    /// @param token Asset being repaired. Use address(0) for native currency.
    /// @param basePerTx New passkey-only per-transfer cap.
    /// @param stepUpPerTx New secondary-approved per-transfer cap.
    /// @param baseDaily New passkey-only daily cap.
    /// @param instantDaily New shared immediate daily cap.
    /// @param recipients New exact recipient allowlist for the asset.
    function repairPolicy(address token, uint256 basePerTx, uint256 stepUpPerTx, uint256 baseDaily, uint256 instantDaily, address[] calldata recipients) external onlySafe {
        if (recipients.length == 0) revert InvalidRepair();
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0)) revert InvalidRepair();
            for (uint256 j; j < i; ++j) if (recipients[i] == recipients[j]) revert InvalidRepair();
        }
        _setAssetPolicy(token, basePerTx, stepUpPerTx, baseDaily, instantDaily, recipients);
    }

    modifier onlySafe() {
        if (msg.sender != config.safe) revert OnlySafe();
        _;
    }

    /// @notice Reports guard and ERC-165 interface support.
    /// @param interfaceId Interface identifier being queried.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(ITransactionGuard).interfaceId || interfaceId == type(IModuleGuard).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @notice Returns the recipient allowlist for one configured asset.
    /// @param token Asset whose recipients should be returned.
    function getPolicyRecipients(address token) external view returns (address[] memory) { return policyRecipients[token]; }

    /// @notice Returns every asset address that has a configured policy.
    function getConfiguredTokens() external view returns (address[] memory) { return configuredTokens; }

    /// @notice Computes a hash of the policy and Delay timing currently enforced.
    /// @dev Used by offchain verification to bind a deployment snapshot to the
    ///      guard's actual Safe, signer, Delay, asset, and recipient settings.
    function policyHash() external view returns (bytes32) {
        bytes32[] memory assets = new bytes32[](configuredTokens.length);
        for (uint256 i; i < configuredTokens.length; ++i) {
            address token = configuredTokens[i];
            AssetPolicy memory p = assetPolicy[token];
            assets[i] = keccak256(abi.encode(token, p.basePerTransaction, p.stepUpPerTransaction, p.baseDailyLimit, p.instantDailyLimit, policyRecipients[token]));
        }
        return keccak256(abi.encode(
            block.chainid,
            config.safe,
            primarySigner,
            safeContractSecondary,
            ecdsaSecondary,
            config.delay,
            config.periodSeconds,
            config.periodAnchor,
            IDelayPolicy(config.delay).txCooldown(),
            IDelayPolicy(config.delay).txExpiration(),
            assets
        ));
    }

    /// @notice Reconstructs the Safe transaction hash this guard binds signatures to.
    /// @param to Safe transaction destination.
    /// @param value Native value sent by the Safe transaction.
    /// @param data Safe transaction calldata.
    /// @param operation Safe operation type: CALL or DELEGATECALL.
    /// @param safeTxGas Safe inner transaction gas field.
    /// @param baseGas Safe base gas reimbursement field.
    /// @param gasPrice Safe gas price reimbursement field.
    /// @param gasToken Safe gas token reimbursement field.
    /// @param refundReceiver Safe refund receiver field.
    /// @param nonce Safe nonce used in the transaction hash.
    function computeSafeTransactionHash(
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
    ) external view returns (bytes32) {
        return PolicyDigest.safeTransactionHash(config.safe, to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce);
    }

    /// @notice Decodes the canonical Safe owner signature slot.
    /// @param signatures Safe signatures bytes, without an ECDSA secondary extension.
    /// @return signer Owner address encoded in the Safe signature slot.
    /// @return ownerEnd Offset immediately after the Safe owner signature data.
    function decodePasskeySignature(bytes calldata signatures) external view returns (address signer, uint256 ownerEnd) {
        (signer, ownerEnd,) = SafeSignatureDecoder.decode(signatures, bytes32(0), false);
        SafeSignatureDecoder.requireNoTrailingData(signatures, ownerEnd);
    }

    /// @notice Decodes the terminal ECDSA secondary extension appended after the Safe signature.
    /// @param signatures Safe signatures bytes followed by the typed ECDSA secondary envelope.
    /// @return ecdsaSecondarySignature Raw ECDSA secondary signature payload from the envelope.
    function decodeEcdsaSecondaryExtension(bytes calldata signatures) external view returns (bytes calldata ecdsaSecondarySignature) {
        (, uint256 ownerEnd,) = SafeSignatureDecoder.decode(signatures, bytes32(0), false);
        return _ecdsaSecondaryExtension(signatures, ownerEnd);
    }

    /// @notice Safe transaction-guard hook for owner-path transactions.
    /// @dev Safe calls this after incrementing its nonce and before execution.
    ///      The guard recomputes the previous nonce hash, verifies the required
    ///      signer shape, consumes applicable limits, and rejects unsupported calls.
    /// @param to Safe transaction destination.
    /// @param value Native value sent by the Safe transaction.
    /// @param data Safe transaction calldata.
    /// @param operation Safe operation type.
    /// @param safeTxGas Safe inner gas field. This MVP requires zero.
    /// @param baseGas Safe base gas reimbursement field, bound into the hash.
    /// @param gasPrice Safe gas price reimbursement field. This MVP requires zero.
    /// @param gasToken Safe gas token reimbursement field, bound into the hash.
    /// @param refundReceiver Safe refund receiver field, bound into the hash.
    /// @param signatures Safe signature bytes plus optional ECDSA secondary extension.
    /// @param executor Safe executor address passed into signature validation.
    function checkTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures,
        address executor
    ) external override onlySafe {
        if (checking) revert ReentrantCheck();
        if (safeTxGas != 0) revert NonZeroSafeTxGas();
        if (gasPrice != 0) revert NonZeroGasPrice();
        checking = true;

        uint256 currentNonce = ISafe(payable(config.safe)).nonce();
        if (currentNonce == 0) revert InvalidPasskeySignature();
        bytes32 txHash = PolicyDigest.safeTransactionHash(config.safe, to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, currentNonce - 1);
        bool emergencyAction = _isEmergencyAction(to, value, data, operation);
        bool secondaryApproved = _validateConfiguredSignatures(signatures, txHash, executor);

        if (emergencyAction) {
            if (!secondaryApproved) revert MissingEcdsaSecondaryExtension();
        } else if (_isImmediateSecondaryTightening(to, value, data, operation)) {
            if (!secondaryApproved) revert MissingEcdsaSecondaryExtension();
        } else if (_isImmediateDelayTightening(to, value, data, operation)) {
            if (secondaryApproved) revert InvalidDelayedAction();
        } else if (_isExactSetAssetPolicy(data) && to == address(this) && value == 0 && operation == Enum.Operation.Call) {
            if (secondaryApproved) revert InvalidDelayedAction();
        } else if (_isQueueProposal(to, value, data, operation)) {
            _authorizeQueueProposal(data, secondaryApproved);
        } else {
            _authorizeTransfer(to, value, data, operation, secondaryApproved);
        }
    }

    /// @notice Safe transaction-guard hook after owner-path execution.
    /// @param success Whether the Safe reports the inner transaction succeeded.
    function checkAfterExecution(bytes32, bool success) external override onlySafe {
        if (!checking) revert NoPendingCheck();
        if (!success) revert ExecutionFailed();
        if (pendingTokenProof) {
            uint256 safeBalance = _readBalance(pendingToken, config.safe);
            uint256 recipientBalance = _readBalance(pendingToken, pendingRecipient);
            if (
                safeBalance + pendingAmount != pendingSafeBalance ||
                recipientBalance != pendingRecipientBalance + pendingAmount
            ) revert ExecutionFailed();
        }
        _clearPendingTransfer();
        checking = false;
    }

    /// @notice Safe module-guard hook for Delay-module execution.
    /// @param to Module transaction destination.
    /// @param value Native value sent by the module transaction.
    /// @param data Module transaction calldata.
    /// @param operation Module operation type.
    /// @param module Enabled Safe module attempting execution; must be Delay.
    /// @return moduleTxHash Digest identifying the checked module transaction.
    function checkModuleTransaction(address to, uint256 value, bytes calldata data, Enum.Operation operation, address module)
        external override onlySafe returns (bytes32 moduleTxHash)
    {
        if (checking) revert ReentrantCheck();
        if (module != config.delay || module == address(0)) revert InvalidConfig();
        checking = true;
        if (operation == Enum.Operation.DelegateCall) {
            if (!_isMaintenanceAction(to, data)) revert InvalidDelayedAction();
        } else {
            _authorizeDelayedExecution(to, value, data, operation);
        }
        return PolicyDigest.moduleTransactionHash(config.safe, module, to, value, data, operation);
    }

    /// @notice Safe module-guard hook after Delay-module execution.
    /// @param success Whether the module transaction succeeded.
    function checkAfterModuleExecution(bytes32, bool success) external override onlySafe {
        if (!checking) revert NoPendingCheck();
        if (!success) revert ExecutionFailed();
        checking = false;
    }

    /// @dev Validates the primary Safe contract signature and at most one configured secondary.
    /// @param signatures Safe signatures bytes with an optional typed ECDSA secondary extension.
    /// @param txHash Exact Safe transaction hash reconstructed by the guard.
    /// @param executor Safe executor forwarded to Safe signature validation.
    /// @return secondaryApproved True when one enabled configured secondary approved the exact transaction.
    function _validateConfiguredSignatures(bytes calldata signatures, bytes32 txHash, address executor) internal returns (bool secondaryApproved) {
        uint256 firstPayloadOffset = _contractSignaturePayloadOffset(signatures, 0);
        if (firstPayloadOffset == 65) {
            (address primary, uint256 ownerEnd, bool isContractSignature) = SafeSignatureDecoder.decode(signatures, txHash, false);
            if (primary != config.passkey || !isContractSignature) revert InvalidPasskeySignature();
            bytes memory primaryOnly = signatures[:ownerEnd];
            try ISafe(payable(config.safe)).checkNSignatures(executor, txHash, primaryOnly, 1) {} catch { revert InvalidPasskeySignature(); }
            if (signatures.length == ownerEnd) return false;
            return _validateEcdsaSecondaryExtension(signatures, ownerEnd, txHash);
        }

        if (firstPayloadOffset != 130) revert InvalidPasskeySignature();
        (address firstSigner, uint256 firstOffset, uint256 firstEnd) = SafeSignatureDecoder.decodeContractSignatureAt(signatures, 0, 2);
        (address secondSigner, uint256 secondOffset, uint256 secondEnd) = SafeSignatureDecoder.decodeContractSignatureAt(signatures, 1, 2);
        if (firstSigner == secondSigner) revert DuplicateSecondarySignature();
        bool firstIsPrimary = firstSigner == config.passkey;
        bool secondIsPrimary = secondSigner == config.passkey;
        if (!firstIsPrimary || secondIsPrimary) revert InvalidPasskeySignature();
        address secondarySigner = firstIsPrimary ? secondSigner : firstSigner;
        if (secondarySigner != safeContractSecondary.signer || !safeContractSecondary.enabled || safeContractSecondary.kind != SignerKind.SafeContractSignature) revert InvalidSecondarySignature();
        if (secondarySigner == config.ecdsaSecondary) revert DuplicateSecondarySignature();
        (uint256 lowerOffset, uint256 lowerEnd, uint256 upperOffset, uint256 upperEnd) =
            firstOffset < secondOffset ? (firstOffset, firstEnd, secondOffset, secondEnd) : (secondOffset, secondEnd, firstOffset, firstEnd);
        if (lowerOffset != 130 || upperOffset != lowerEnd) revert InvalidSecondarySignature();
        SafeSignatureDecoder.requireNoTrailingData(signatures, upperEnd);

        bytes memory primaryPayload = firstIsPrimary ? _contractSignaturePayload(signatures, firstOffset, firstEnd) : _contractSignaturePayload(signatures, secondOffset, secondEnd);
        bytes memory secondaryPayload = firstIsPrimary ? _contractSignaturePayload(signatures, secondOffset, secondEnd) : _contractSignaturePayload(signatures, firstOffset, firstEnd);
        bytes memory primarySignature = abi.encodePacked(
            bytes32(uint256(uint160(config.passkey))), bytes32(uint256(65)), bytes1(0), bytes32(primaryPayload.length), primaryPayload
        );
        try ISafe(payable(config.safe)).checkNSignatures(executor, txHash, primarySignature, 1) {} catch { revert InvalidPasskeySignature(); }
        if (safeContractSecondary.signer.code.length == 0 || !SignatureChecker.isValidSignatureNow(safeContractSecondary.signer, txHash, secondaryPayload)) revert InvalidSecondarySignature();
        return true;
    }

    /// @dev Validates the existing terminal ECDSA secondary extension.
    function _validateEcdsaSecondaryExtension(bytes calldata signatures, uint256 ownerEnd, bytes32 txHash) internal returns (bool) {
        if (!ecdsaSecondary.enabled || ecdsaSecondary.kind != SignerKind.EcdsaExtension || ecdsaSecondary.signer != config.ecdsaSecondary) revert InvalidSecondarySigner();
        bytes calldata ecdsaSecondarySignature = _ecdsaSecondaryExtension(signatures, ownerEnd);
        if (!SignatureChecker.isValidSignatureNow(config.ecdsaSecondary, txHash, ecdsaSecondarySignature)) revert InvalidEcdsaSecondarySignature();
        bytes32 authorization = keccak256(abi.encode(txHash, keccak256(ecdsaSecondarySignature)));
        if (ecdsaSecondaryAuthorizationUsed[authorization]) revert InvalidEcdsaSecondarySignature();
        ecdsaSecondaryAuthorizationUsed[authorization] = true;
        return true;
    }

    /// @dev Reads the dynamic payload offset from one Safe signature slot.
    function _contractSignaturePayloadOffset(bytes calldata signatures, uint256 slotIndex) internal pure returns (uint256) {
        uint256 slotOffset = slotIndex * 65;
        if (signatures.length < slotOffset + 65 || uint8(signatures[slotOffset + 64]) != 0) revert InvalidPasskeySignature();
        return uint256(bytes32(signatures[slotOffset + 32:slotOffset + 64]));
    }

    /// @dev Copies one Safe contract signature payload from calldata.
    function _contractSignaturePayload(bytes calldata signatures, uint256 payloadOffset, uint256 payloadEnd) internal pure returns (bytes memory) {
        return signatures[payloadOffset + 32:payloadEnd];
    }

    /// @dev Extracts the typed ECDSA secondary signature envelope after the Safe owner slot.
    /// @param signatures Complete signature bytes supplied to the Safe transaction.
    /// @param ownerEnd Offset immediately after the Safe owner signature data.
    /// @return ecdsaSecondarySignature Raw ECDSA secondary signature payload.
    function _ecdsaSecondaryExtension(bytes calldata signatures, uint256 ownerEnd) internal pure returns (bytes calldata ecdsaSecondarySignature) {
        if (signatures.length == ownerEnd) revert MissingEcdsaSecondaryExtension();
        if (signatures.length < ownerEnd + 64) revert MalformedEcdsaSecondaryExtension();
        uint256 typeOffset = signatures.length - 32;
        if (bytes32(signatures[typeOffset:typeOffset + 32]) != ECDSA_SECONDARY_SIGNATURE_TYPE_HASH) revert WrongEcdsaSecondaryExtensionType();
        uint256 lengthOffset = signatures.length - 64;
        uint256 payloadLength = uint256(bytes32(signatures[lengthOffset:lengthOffset + 32]));
        if (payloadLength == 0 || payloadLength + 64 > signatures.length - ownerEnd) revert InvalidEcdsaSecondaryExtensionLength();
        if (ownerEnd + payloadLength + 64 != signatures.length) revert InvalidEcdsaSecondaryExtensionLength();
        return signatures[ownerEnd:ownerEnd + payloadLength];
    }

    /// @dev Authorizes a native or ERC-20 transfer and updates X/Y counters.
    /// @param to Native recipient, or token contract for ERC-20 transfers.
    /// @param value Native amount. Must be zero for ERC-20 transfers.
    /// @param data Empty for native transfers, or ERC-20 transfer calldata.
    /// @param operation Safe operation, which must be CALL.
    /// @param secondaryApproved True when one enabled configured secondary verified.
    function _authorizeTransfer(address to, uint256 value, bytes calldata data, Enum.Operation operation, bool secondaryApproved) internal {
        if (frozen) revert Frozen();
        if (operation != Enum.Operation.Call) revert UnsupportedTransfer();

        address token;
        address recipient;
        uint256 amount;
        if (data.length == 0) {
            token = address(0);
            recipient = to;
            amount = value;
        } else {
            if (value != 0 || data.length != 68 || bytes4(data[:4]) != bytes4(0xa9059cbb)) revert UnsupportedTransfer();
            token = to;
            (recipient, amount) = abi.decode(data[4:], (address, uint256));
        }

        AssetPolicy memory policy = assetPolicy[token];
        if (policy.instantDailyLimit == 0) revert UnsupportedTransfer();
        if (!allowedRecipient[token][recipient]) revert RecipientNotAllowed();
        if (amount == 0) revert UnsupportedTransfer();

        uint256 window = _currentWindow();
        SpendState memory state = spendState[token];
        if (state.window != window) state = SpendState(window, 0, 0);

        AuthorizationTier tier;
        if (!secondaryApproved) {
            if (
                amount > policy.basePerTransaction || amount > policy.baseDailyLimit - state.baseSpent ||
                amount > policy.instantDailyLimit - state.instantSpent
            ) revert TransferExceedsLimit();
            tier = AuthorizationTier.Base;
            state.baseSpent += amount;
        } else {
            if (amount > policy.stepUpPerTransaction || amount > policy.instantDailyLimit - state.instantSpent) revert TransferExceedsLimit();
            tier = AuthorizationTier.StepUp;
        }
        state.instantSpent += amount;
        spendState[token] = state;
        if (token != address(0)) {
            pendingToken = token;
            pendingRecipient = recipient;
            pendingAmount = amount;
            pendingSafeBalance = _readBalance(token, config.safe);
            pendingRecipientBalance = _readBalance(token, recipient);
            pendingTokenProof = true;
        }
        emit TransferAuthorized(tier, token, recipient, amount, state.baseSpent, state.instantSpent, window);
    }

    /// @dev Returns true when the owner-path call queues work through Delay.
    function _isQueueProposal(address to, uint256 value, bytes calldata data, Enum.Operation operation) internal view returns (bool) {
        return to == config.delay && value == 0 && operation == Enum.Operation.Call && data.length >= 4 && bytes4(data[:4]) == DELAY_QUEUE_SELECTOR;
    }

    /// @dev Validates the exact Delay queue tuple before it enters the queue.
    /// @param data Delay execTransactionFromModule calldata.
    /// @param secondaryApproved Whether an enabled configured secondary approved the outer Safe transaction.
    function _authorizeQueueProposal(bytes calldata data, bool secondaryApproved) internal view {
        if (data.length < 4 + 32 * 4) revert InvalidDelayedAction();
        (address target, uint256 value, bytes memory innerData, uint8 operation) = abi.decode(data[4:], (address, uint256, bytes, uint8));
        if (keccak256(data) != keccak256(abi.encodeWithSelector(DELAY_QUEUE_SELECTOR, target, value, innerData, operation))) revert InvalidDelayedAction();
        if (!secondaryApproved) revert MissingEcdsaSecondaryExtension();
        if (operation == uint8(Enum.Operation.DelegateCall)) {
            if (!_isMaintenanceAction(target, innerData)) revert InvalidDelayedAction();
            return;
        }
        if (operation != uint8(Enum.Operation.Call)) revert InvalidDelayedAction();
        if (target == address(this)) {
            if (!_isExactPolicyRepair(innerData)) revert InvalidRepair();
            return;
        }
        (address token, address recipient, uint256 amount) = _decodeTransfer(target, value, innerData);
        AssetPolicy memory policy = assetPolicy[token];
        SpendState memory state = spendState[token];
        uint256 window = _currentWindow();
        uint256 spent = state.window == window ? state.instantSpent : 0;
        if (policy.instantDailyLimit == 0 || amount <= policy.instantDailyLimit - spent || !allowedRecipient[token][recipient]) revert InvalidDelayedAction();
    }

    /// @dev Validates a transaction that the configured Delay module is executing.
    /// @param to Delayed transaction destination.
    /// @param value Native value sent by the delayed transaction.
    /// @param data Delayed transaction calldata.
    /// @param operation Delayed operation type.
    function _authorizeDelayedExecution(address to, uint256 value, bytes calldata data, Enum.Operation operation) internal view {
        if (operation == Enum.Operation.DelegateCall) {
            if (!_isMaintenanceAction(to, data)) revert InvalidDelayedAction();
            return;
        }
        if (frozen || operation != Enum.Operation.Call) revert InvalidDelayedAction();
        if (to == address(this)) {
            if (!_isExactPolicyRepair(data)) revert InvalidRepair();
            return;
        }
        (address token, address recipient, uint256 amount) = _decodeTransfer(to, value, data);
        if (assetPolicy[token].instantDailyLimit == 0 || !allowedRecipient[token][recipient] || amount == 0) revert InvalidDelayedAction();
    }

    /// @dev Decodes the two transfer shapes allowed by the MVP.
    /// @param to Native recipient, or token contract for ERC-20 transfers.
    /// @param value Native amount. Must be zero for ERC-20 transfers.
    /// @param data Empty for native transfers, or ERC-20 transfer calldata.
    /// @return token address(0) for native currency, otherwise ERC-20 token.
    /// @return recipient Transfer recipient.
    /// @return amount Transfer amount in token-native units.
    function _decodeTransfer(address to, uint256 value, bytes memory data) internal pure returns (address token, address recipient, uint256 amount) {
        if (data.length == 0) return (address(0), to, value);
        if (value != 0 || data.length != 68 || bytes4(data) != bytes4(0xa9059cbb)) revert InvalidDelayedAction();
        bytes memory args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) args[i] = data[i + 4];
        (recipient, amount) = abi.decode(args, (address, uint256));
        return (to, recipient, amount);
    }

    /// @dev Identifies immediate emergency actions available to primary plus secondary.
    function _isEmergencyAction(address to, uint256 value, bytes calldata data, Enum.Operation operation) internal view returns (bool) {
        if (value != 0 || operation != Enum.Operation.Call) return false;
        return (to == address(this) && data.length == 4 && bytes4(data[:4]) == FREEZE_SELECTOR) ||
            (to == config.delay && data.length == 36 && bytes4(data[:4]) == DELAY_SET_NONCE_SELECTOR);
    }

    /// @dev Accepts only canonical ABI encoding for direct delayed policy repair.
    function _isExactPolicyRepair(bytes memory data) internal pure returns (bool) {
        if (data.length < 4 + 32 * 6 || bytes4(data) != REPAIR_POLICY_SELECTOR) return false;
        (address token, uint256 a, uint256 b, uint256 c, uint256 d, address[] memory recipients) = abi.decode(_copy(data, 4), (address, uint256, uint256, uint256, uint256, address[]));
        return keccak256(data) == keccak256(abi.encodeWithSelector(REPAIR_POLICY_SELECTOR, token, a, b, c, d, recipients));
    }

    /// @dev Accepts only canonical ABI encoding for immediate policy tightening.
    function _isExactSetAssetPolicy(bytes calldata data) internal pure returns (bool) {
        if (data.length < 4 + 32 * 6 || bytes4(data[:4]) != SET_ASSET_POLICY_SELECTOR) return false;
        (address token, uint256 a, uint256 b, uint256 c, uint256 d, address[] memory recipients) = abi.decode(data[4:], (address, uint256, uint256, uint256, uint256, address[]));
        return keccak256(data) == keccak256(abi.encodeWithSelector(SET_ASSET_POLICY_SELECTOR, token, a, b, c, d, recipients));
    }

    /// @dev Recognizes delayed delegatecall maintenance actions and exact lengths.
    /// @param target Delegatecall target; must be the configured maintenance helper.
    /// @param data Maintenance calldata.
    function _isMaintenanceAction(address target, bytes memory data) internal view returns (bool) {
        if (maintenance == address(0) || target != maintenance || data.length < 4) return false;
        bytes4 selector = bytes4(data);
        if (selector == REPLACE_GUARDS_SELECTOR) return data.length == 68;
        if (selector == REPLACE_SIGNER_SELECTOR) return _isExactReplaceSignerMaintenance(data);
        return false;
    }

    /// @dev Accepts only canonical ABI encoding for delayed signer maintenance.
    function _isExactReplaceSignerMaintenance(bytes memory data) internal pure returns (bool) {
        if (data.length < 4 + 32 * 8 || bytes4(data) != REPLACE_SIGNER_SELECTOR) return false;
        (address guard, uint8 role, address expectedOld, address replacement, address previousOwner, uint256 threshold, bytes memory proof) = abi.decode(_copy(data, 4), (address, uint8, address, address, address, uint256, bytes));
        return keccak256(data) == keccak256(abi.encodeWithSelector(REPLACE_SIGNER_SELECTOR, guard, role, expectedOld, replacement, previousOwner, threshold, proof));
    }

    /// @dev Allows immediate disabling of the guard-only contract secondary.
    function _isImmediateSecondaryTightening(address to, uint256 value, bytes calldata data, Enum.Operation operation) internal view returns (bool) {
        if (value != 0 || operation != Enum.Operation.Call || data.length < 4) return false;
        bytes4 selector = bytes4(data[:4]);
        if (to == address(this) && selector == CONFIGURE_SAFE_CONTRACT_SECONDARY_SELECTOR && data.length == 68) {
            (address signer, bool enabled) = abi.decode(data[4:], (address, bool));
            return !enabled && safeContractSecondary.signer != address(0) && (signer == safeContractSecondary.signer || signer == address(0));
        }
        return false;
    }

    /// @dev Allows immediate Delay changes only when cooldown/expiration tighten.
    function _isImmediateDelayTightening(address to, uint256 value, bytes calldata data, Enum.Operation operation) internal view returns (bool) {
        if (to != config.delay || value != 0 || operation != Enum.Operation.Call || data.length != 36) return false;
        bytes4 selector = bytes4(data[:4]);
        uint256 next = uint256(bytes32(data[4:36]));
        if (selector == bytes4(keccak256("setTxCooldown(uint256)"))) return next >= IDelayPolicy(config.delay).txCooldown();
        if (selector == bytes4(keccak256("setTxExpiration(uint256)"))) {
            uint256 current = IDelayPolicy(config.delay).txExpiration();
            return current == 0 || (next != 0 && next <= current);
        }
        return false;
    }

    /// @dev Copies a suffix of a memory byte array for ABI decoding.
    /// @param input Source bytes.
    /// @param start First byte index to copy.
    function _copy(bytes memory input, uint256 start) internal pure returns (bytes memory output) {
        output = new bytes(input.length - start);
        for (uint256 i; i < output.length; ++i) output[i] = input[i + start];
    }

    /// @dev Internal policy replacement used by delayed repair.
    function _setAssetPolicy(address token, uint256 basePerTransaction, uint256 stepUpPerTransaction, uint256 baseDailyLimit, uint256 instantDailyLimit, address[] calldata recipients) internal {
        if (basePerTransaction == 0 || stepUpPerTransaction == 0 || baseDailyLimit == 0 || instantDailyLimit <= baseDailyLimit || basePerTransaction > baseDailyLimit || stepUpPerTransaction > instantDailyLimit) revert InvalidAssetPolicy();
        assetPolicy[token] = AssetPolicy(basePerTransaction, stepUpPerTransaction, baseDailyLimit, instantDailyLimit);
        if (!configuredToken[token]) { configuredToken[token] = true; configuredTokens.push(token); }
        address[] storage previousRecipients = policyRecipients[token];
        for (uint256 i; i < previousRecipients.length; ++i) allowedRecipient[token][previousRecipients[i]] = false;
        delete policyRecipients[token];
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0)) revert InvalidAssetPolicy();
            allowedRecipient[token][recipients[i]] = true;
            policyRecipients[token].push(recipients[i]);
        }
    }

    /// @dev Reads an ERC-20 balance and rejects non-standard return shapes.
    /// @param token ERC-20 token contract.
    /// @param account Account whose balance is read.
    function _readBalance(address token, address account) internal view returns (uint256 balance) {
        (bool success, bytes memory returndata) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!success || returndata.length != 32) revert UnsupportedTransfer();
        balance = abi.decode(returndata, (uint256));
    }

    /// @dev Clears the ERC-20 transfer proof state after post-execution checks.
    function _clearPendingTransfer() internal {
        pendingToken = address(0);
        pendingRecipient = address(0);
        pendingAmount = 0;
        pendingSafeBalance = 0;
        pendingRecipientBalance = 0;
        pendingTokenProof = false;
    }

    /// @dev Computes the current policy window start from the fixed anchor.
    function _currentWindow() internal view returns (uint256) {
        if (block.timestamp < config.periodAnchor) revert InvalidConfig();
        return uint256(config.periodAnchor) + ((block.timestamp - uint256(config.periodAnchor)) / uint256(config.periodSeconds)) * uint256(config.periodSeconds);
    }
}
