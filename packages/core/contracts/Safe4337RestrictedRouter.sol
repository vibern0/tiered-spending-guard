// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

/// @notice Local Safe 1.5 research adapter for one pinned Safe4337Module artifact.
/// @dev Safe calls this as its fallback handler. Delegatecall keeps the Safe as
///      msg.sender for the stock module, while this contract is the enabled
///      module that the Safe's module guard must constrain.
contract Safe4337RestrictedRouter {
    struct PackedUserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        bytes32 gasFees;
        bytes paymasterAndData;
        bytes signature;
    }

    bytes4 private constant VALIDATE = bytes4(keccak256("validateUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32,uint256)"));
    bytes4 private constant EXECUTE = bytes4(keccak256("executeUserOp(address,uint256,bytes,uint8)"));
    bytes4 private constant EXECUTE_WITH_ERROR = bytes4(keccak256("executeUserOpWithErrorString(address,uint256,bytes,uint8)"));
    bytes4 private constant OPERATION_HASH = bytes4(keccak256("getOperationHash((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))"));
    bytes32 private constant MODULE_RUNTIME_HASH = 0x2aea997c4e3cf0e2f333025372e219abcfde81c21fc2f8fb066414a5685dd3e0;

    address public immutable SAFE;
    address public immutable STANDARD_MODULE;
    address public immutable ENTRY_POINT;

    error InvalidConfiguration();
    error UnsupportedSelector();
    error InvalidCaller();
    error NonCanonicalCall();

    constructor(address safe, address standardModule, address entryPoint) {
        if (safe == address(0) || standardModule == address(0) || entryPoint == address(0)) revert InvalidConfiguration();
        if (safe.code.length == 0 || standardModule.codehash != MODULE_RUNTIME_HASH) revert InvalidConfiguration();
        (bool ok, bytes memory result) = standardModule.staticcall(abi.encodeWithSignature("SUPPORTED_ENTRYPOINT()"));
        if (!ok || result.length != 32 || abi.decode(result, (address)) != entryPoint) revert InvalidConfiguration();
        (ok, result) = safe.staticcall(abi.encodeWithSignature("VERSION()"));
        if (!ok || keccak256(result) != keccak256(abi.encode("1.5.0"))) revert InvalidConfiguration();
        SAFE = safe;
        STANDARD_MODULE = standardModule;
        ENTRY_POINT = entryPoint;
    }

    fallback() external {
        bytes4 selector = msg.sig;
        if (selector == OPERATION_HASH) {
            _requireCanonicalHashCall(msg.data);
            _delegate();
        }

        if (selector != VALIDATE && selector != EXECUTE && selector != EXECUTE_WITH_ERROR) revert UnsupportedSelector();
        if (msg.sender != SAFE || msg.data.length < 24) revert InvalidCaller();
        address originalCaller;
        assembly ("memory-safe") {
            originalCaller := shr(96, calldataload(sub(calldatasize(), 20)))
        }
        if (originalCaller != ENTRY_POINT) revert InvalidCaller();
        bytes calldata callData = msg.data[:msg.data.length - 20];
        if (selector == VALIDATE) {
            (PackedUserOperation memory op, bytes32 userOpHash, uint256 missingFunds) =
                abi.decode(callData[4:], (PackedUserOperation, bytes32, uint256));
            if (keccak256(callData) != keccak256(abi.encodeWithSelector(VALIDATE, op, userOpHash, missingFunds))) revert NonCanonicalCall();
        } else {
            (address to, uint256 value, bytes memory data, uint8 operation) = abi.decode(callData[4:], (address, uint256, bytes, uint8));
            if (keccak256(callData) != keccak256(abi.encodeWithSelector(selector, to, value, data, operation))) revert NonCanonicalCall();
        }
        _delegate();
    }

    function _requireCanonicalHashCall(bytes calldata callData) private pure {
        (PackedUserOperation memory op) = abi.decode(callData[4:], (PackedUserOperation));
        if (keccak256(callData) != keccak256(abi.encodeWithSelector(OPERATION_HASH, op))) revert NonCanonicalCall();
    }

    function _delegate() private {
        address implementation = STANDARD_MODULE;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, 0, calldatasize())
            let success := delegatecall(gas(), implementation, ptr, calldatasize(), 0, 0)
            let length := returndatasize()
            returndatacopy(ptr, 0, length)
            if iszero(success) { revert(ptr, length) }
            return(ptr, length)
        }
    }
}
