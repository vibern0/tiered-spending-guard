// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

library SafeSignatureDecoder {
    error MalformedSafeSignature();
    error ApprovedHashSignature();
    error UnsupportedSignatureType();
    error TrailingSafeSignatureData();
    error NonCanonicalOwnerWord();

    /// @notice Decodes the first Safe owner signature slot used by this guard.
    /// @dev Supports the configured contract-signature path and, only when
    ///      explicitly allowed by callers, a raw ECDSA signer. Approved
    ///      hashes are rejected because they do not bind the signer interaction.
    /// @param signatures Safe signatures bytes, optionally followed by extension data.
    /// @param safeTxHash Safe transaction hash used to recover ECDSA signers.
    /// @param allowEcdsa Whether ECDSA owner signatures are acceptable here.
    /// @return signer Owner address represented by the first signature slot.
    /// @return ownerEnd Offset immediately after the owner signature payload.
    /// @return isContractSignature True for Safe v == 0 contract signatures.
    function decode(bytes calldata signatures, bytes32 safeTxHash, bool allowEcdsa) internal pure returns (address signer, uint256 ownerEnd, bool isContractSignature) {
        if (signatures.length < 65) revert MalformedSafeSignature();

        uint8 v = uint8(signatures[64]);
        if (v == 1) revert ApprovedHashSignature();
        if (v == 27 || v == 28) {
            if (!allowEcdsa) revert UnsupportedSignatureType();
            signer = ecrecover(safeTxHash, v, bytes32(signatures[0:32]), bytes32(signatures[32:64]));
            if (signer == address(0)) revert MalformedSafeSignature();
            return (signer, 65, false);
        }
        if (v != 0) revert UnsupportedSignatureType();

        bytes32 ownerWord = bytes32(signatures[0:32]);
        if (uint256(ownerWord) >> 160 != 0) revert NonCanonicalOwnerWord();
        signer = address(uint160(uint256(ownerWord)));
        uint256 offset = uint256(bytes32(signatures[32:64]));
        if (offset != 65 || signatures.length < 65 + 32) revert MalformedSafeSignature();

        uint256 signatureLength = uint256(bytes32(signatures[65:97]));
        ownerEnd = 97 + signatureLength;
        if (ownerEnd > signatures.length) revert MalformedSafeSignature();
        return (signer, ownerEnd, true);
    }

    /// @notice Decodes one Safe contract-signature slot from a bounded static prefix.
    /// @param signatures Complete Safe signatures bytes.
    /// @param slotIndex Static 65-byte slot index to decode.
    /// @param staticSlots Number of Safe owner signature slots expected in the prefix.
    /// @return signer Owner contract encoded in the selected slot.
    /// @return payloadOffset Offset of the contract-signature length word.
    /// @return payloadEnd Offset immediately after the contract-signature payload.
    function decodeContractSignatureAt(bytes calldata signatures, uint256 slotIndex, uint256 staticSlots)
        internal pure returns (address signer, uint256 payloadOffset, uint256 payloadEnd)
    {
        if (staticSlots == 0 || slotIndex >= staticSlots || signatures.length < staticSlots * 65) revert MalformedSafeSignature();
        uint256 slotOffset = slotIndex * 65;
        uint8 v = uint8(signatures[slotOffset + 64]);
        if (v == 1) revert ApprovedHashSignature();
        if (v != 0) revert UnsupportedSignatureType();

        bytes32 ownerWord = bytes32(signatures[slotOffset:slotOffset + 32]);
        if (uint256(ownerWord) >> 160 != 0) revert NonCanonicalOwnerWord();
        signer = address(uint160(uint256(ownerWord)));
        payloadOffset = uint256(bytes32(signatures[slotOffset + 32:slotOffset + 64]));
        if (payloadOffset < staticSlots * 65 || signatures.length < payloadOffset + 32) revert MalformedSafeSignature();
        uint256 signatureLength = uint256(bytes32(signatures[payloadOffset:payloadOffset + 32]));
        payloadEnd = payloadOffset + 32 + signatureLength;
        if (payloadEnd > signatures.length) revert MalformedSafeSignature();
    }

    /// @notice Rejects extension or trailing bytes after the owner signature.
    /// @param signatures Complete signatures bytes to inspect.
    /// @param ownerEnd Expected end offset returned by decode.
    function requireNoTrailingData(bytes calldata signatures, uint256 ownerEnd) internal pure {
        if (signatures.length != ownerEnd) revert TrailingSafeSignatureData();
    }
}
