// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

contract HashBound1271Signer {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;
    bytes32 public acceptedHash;
    bytes32 public acceptedSignatureHash;

    function setAccepted(bytes32 hash, bytes calldata signature) external {
        acceptedHash = hash;
        acceptedSignatureHash = keccak256(signature);
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (hash == acceptedHash && keccak256(signature) == acceptedSignatureHash) return MAGICVALUE;
        return 0xffffffff;
    }
}
