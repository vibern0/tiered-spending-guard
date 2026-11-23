// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

import {Safe4337RestrictedRouter} from "./Safe4337RestrictedRouter.sol";
import {ISafe} from "@safe-global/safe-smart-account/contracts/interfaces/ISafe.sol";
import {Enum} from "@safe-global/safe-smart-account/contracts/libraries/Enum.sol";

interface IInstantGuard {
    function verifyInstant(bytes32 digest, bool stepUp, bytes calldata primary, bytes calldata secondary) external view;
    function queueDelay() external view returns (address);
    function beginCancel(bytes32 digest, address token, uint256 head, bytes32 transferHash, bytes calldata cancelCall) external;
    function beginQueue(bytes32 digest, bytes calldata queueCall) external;
    function beginInstant(bytes32 digest, address token, bytes calldata callData, bool stepUp) external;
    function instantFinished() external view returns (bool);
}
interface IWithdrawalQueue {
    function txNonce() external view returns (uint256);
    function setTxNonce(uint256 next) external;
}
interface IInstantEntryPoint {
    function getUserOpHash(Safe4337RestrictedRouter.PackedUserOperation calldata op) external view returns (bytes32);
}

/// @notice Local-only Safe fallback/module accepting one signed, paymaster-backed GLD UserOperation.
contract Safe4337InstantRouter is Safe4337RestrictedRouter {
    enum Tier { Base, StepUp, Queue, Cancel }
    struct Send {
        address guard;
        address token;
        address recipient;
        uint256 amount;
        Tier tier;
        uint48 validUntil;
    }
    bytes32 private constant DOMAIN = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant SEND_TYPE = keccak256("InstantSend(bytes32 userOpHash,address guard)");
    bytes32 private constant QUEUE_TYPE = keccak256("QueueWithdrawal(bytes32 userOpHash,address guard,address delay)");
    bytes32 private constant CANCEL_TYPE = keccak256("CancelWithdrawal(bytes32 userOpHash,address guard,address delay)");
    uint256 private constant GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    uint256 private constant MODULE_GUARD_SLOT = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;
    address public immutable TOKEN;
    address public immutable PAYMASTER;

    constructor(address safe, address standard, address entry, address token, address paymaster)
        Safe4337RestrictedRouter(safe, standard, entry) {
        if (token.code.length == 0 || paymaster.code.length == 0) revert InvalidConfiguration();
        TOKEN = token;
        PAYMASTER = paymaster;
    }

    function _requireEntryPoint() private view {
        if (msg.sender != SAFE || msg.data.length < 24 ||
            address(bytes20(msg.data[msg.data.length - 20:])) != ENTRY_POINT) revert InvalidCaller();
    }

    function validateUserOp(PackedUserOperation calldata op, bytes32 opHash, uint256 missingFunds)
        external returns (uint256 validationData) {
        _requireEntryPoint();
        if (keccak256(msg.data[:msg.data.length - 20]) != keccak256(abi.encodeWithSelector(msg.sig, op, opHash, missingFunds))) revert NonCanonicalCall();
        if (op.sender != SAFE || missingFunds != 0 || op.paymasterAndData.length < 52 ||
            address(bytes20(op.paymasterAndData[:20])) != PAYMASTER) revert InvalidConfiguration();
        if (bytes4(op.callData[:4]) != this.executeUserOp.selector) _delegate();
        (Send memory send,) = _verified(op, opHash);
        return uint256(send.validUntil) << 160;
    }

    /// @dev This is the full-operation EntryPoint v0.7 selector. Stock execution selectors still enter the restricted fallback.
    function executeUserOp(PackedUserOperation calldata op, bytes32 opHash) external {
        _requireEntryPoint();
        if (keccak256(msg.data[:msg.data.length - 20]) != keccak256(abi.encodeWithSelector(msg.sig, op, opHash))) revert NonCanonicalCall();
        (Send memory send, bytes32 digest) = _verified(op, opHash);
        if (block.timestamp > send.validUntil) revert InvalidConfiguration();
        IInstantGuard guard = IInstantGuard(send.guard);
        bytes memory transfer = abi.encodeWithSelector(bytes4(0xa9059cbb), send.recipient, send.amount);
        address target = send.token;
        bytes memory callData = transfer;
        if (send.tier == Tier.Cancel) {
            target = guard.queueDelay();
            uint256 head = _cancelHead(op);
            callData = abi.encodeCall(IWithdrawalQueue.setTxNonce, (head + 1));
            bytes32 transferHash = keccak256(abi.encodePacked(send.token, uint256(0), transfer, Enum.Operation.Call));
            guard.beginCancel(digest, send.token, head, transferHash, callData);
        } else if (send.tier == Tier.Queue) {
            target = guard.queueDelay();
            callData = abi.encodeWithSelector(ISafe(payable(SAFE)).execTransactionFromModule.selector, send.token, 0, transfer, Enum.Operation.Call);
            guard.beginQueue(digest, callData);
        } else {
            guard.beginInstant(digest, send.token, transfer, send.tier == Tier.StepUp);
        }
        if (!ISafe(payable(SAFE)).execTransactionFromModule(target, 0, callData, Enum.Operation.Call) ||
            !guard.instantFinished()) revert InvalidConfiguration();
        if (send.tier == Tier.Cancel && IWithdrawalQueue(target).txNonce() != _cancelHead(op) + 1) revert InvalidConfiguration();
    }

    function _cancelHead(PackedUserOperation calldata op) private pure returns (uint256) {
        // Six static ABI words in Send precede the signed queue entry number.
        return abi.decode(op.callData[4 + 6 * 32:], (uint256));
    }

    function _verified(PackedUserOperation calldata op, bytes32 opHash) private view returns (Send memory send, bytes32 digest) {
        if (op.sender != SAFE || op.initCode.length != 0 || op.paymasterAndData.length < 52 ||
            address(bytes20(op.paymasterAndData[:20])) != PAYMASTER ||
            IInstantEntryPoint(ENTRY_POINT).getUserOpHash(op) != opHash) revert InvalidConfiguration();
        send = abi.decode(op.callData[4:], (Send));
        bytes memory payload = send.tier == Tier.Cancel ? abi.encode(send, _cancelHead(op)) : abi.encode(send);
        if (keccak256(op.callData) != keccak256(abi.encodePacked(this.executeUserOp.selector, payload)) ||
            send.token != TOKEN || send.recipient == address(0) || send.amount == 0 || send.validUntil == 0 ||
            send.guard.code.length == 0) revert NonCanonicalCall();
        ISafe account = ISafe(payable(SAFE));
        if (abi.decode(account.getStorageAt(GUARD_SLOT, 1), (address)) != send.guard ||
            abi.decode(account.getStorageAt(MODULE_GUARD_SLOT, 1), (address)) != send.guard) revert InvalidConfiguration();
        bytes32 domain = keccak256(abi.encode(DOMAIN, keccak256("GLD Instant Send"), keccak256("1"), block.chainid, address(this)));
        bytes32 action = send.tier == Tier.Queue || send.tier == Tier.Cancel
            ? keccak256(abi.encode(send.tier == Tier.Cancel ? CANCEL_TYPE : QUEUE_TYPE, opHash, send.guard, IInstantGuard(send.guard).queueDelay()))
            : keccak256(abi.encode(SEND_TYPE, opHash, send.guard));
        digest = keccak256(abi.encodePacked(hex"1901", domain, action));
        (bytes memory primary, bytes memory secondary) = abi.decode(op.signature, (bytes, bytes));
        if (keccak256(op.signature) != keccak256(abi.encode(primary, secondary))) revert NonCanonicalCall();
        IInstantGuard(send.guard).verifyInstant(digest, send.tier != Tier.Base, primary, secondary);
    }
}
