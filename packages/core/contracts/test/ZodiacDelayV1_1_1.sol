// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

// Pinned test fixture copied from gnosisguild/zodiac-modifier-delay v1.1.1
// (commit 30f3aafa9b3be3425bcac390fe6ab6bd9afb5f16). This is the reviewed
// Delay implementation used by the integration tests, not a project rewrite.
import {Enum, Modifier} from "./ZodiacCoreCompat.sol";

contract ZodiacDelayV1_1_1 is Modifier {
    event DelaySetup(address indexed initiator, address indexed owner, address indexed avatar, address target);
    event TxCooldownSet(uint256 cooldown);
    event TxExpirationSet(uint256 expiration);
    event TxNonceSet(uint256 nonce);
    event TransactionAdded(uint256 indexed queueNonce, bytes32 indexed txHash, address to, uint256 value, bytes data, Enum.Operation operation);

    uint256 public txCooldown;
    uint256 public txExpiration;
    uint256 public txNonce;
    uint256 public queueNonce;
    mapping(uint256 => bytes32) public txHash;
    mapping(uint256 => uint256) public txCreatedAt;

    constructor(address owner_, address avatar_, address target_, uint256 cooldown_, uint256 expiration_) {
        setUp(abi.encode(owner_, avatar_, target_, cooldown_, expiration_));
    }

    function setUp(bytes memory initParams) public override initializer {
        (address owner_, address avatar_, address target_, uint256 cooldown_, uint256 expiration_) = abi.decode(initParams, (address, address, address, uint256, uint256));
        require(avatar_ != address(0), "Avatar can not be zero address");
        require(target_ != address(0), "Target can not be zero address");
        require(expiration_ == 0 || expiration_ >= 60, "Expiration must be 0 or at least 60 seconds");
        _transferOwnership(owner_);
        avatar = avatar_;
        target = target_;
        txExpiration = expiration_;
        txCooldown = cooldown_;
        setupModules();
        emit DelaySetup(msg.sender, owner_, avatar_, target_);
        emit AvatarSet(address(0), avatar_);
        emit TargetSet(address(0), target_);
    }

    function setTxCooldown(uint256 cooldown_) public onlyOwner { txCooldown = cooldown_; emit TxCooldownSet(cooldown_); }
    function setTxExpiration(uint256 expiration_) public onlyOwner {
        require(expiration_ == 0 || expiration_ >= 60, "Expiration must be 0 or at least 60 seconds");
        txExpiration = expiration_;
        emit TxExpirationSet(expiration_);
    }
    function setTxNonce(uint256 nonce_) public onlyOwner {
        require(nonce_ > txNonce, "New nonce must be higher than current txNonce");
        require(nonce_ <= queueNonce, "Cannot be higher than queueNonce");
        txNonce = nonce_;
        emit TxNonceSet(nonce_);
    }

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, Enum.Operation operation)
        public override moduleOnly returns (bool success)
    {
        bytes32 hash = getTransactionHash(to, value, data, operation);
        txHash[queueNonce] = hash;
        txCreatedAt[queueNonce] = block.timestamp;
        emit TransactionAdded(queueNonce, hash, to, value, data, operation);
        queueNonce++;
        success = true;
    }

    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, Enum.Operation operation)
        public override moduleOnly returns (bool success, bytes memory returnData)
    {
        bytes32 hash = getTransactionHash(to, value, data, operation);
        txHash[queueNonce] = hash;
        txCreatedAt[queueNonce] = block.timestamp;
        emit TransactionAdded(queueNonce, hash, to, value, data, operation);
        success = true;
        returnData = abi.encode(queueNonce, hash, block.timestamp);
        queueNonce++;
    }

    function executeNextTx(address to, uint256 value, bytes calldata data, Enum.Operation operation) public {
        require(txNonce < queueNonce, "Transaction queue is empty");
        uint256 created = txCreatedAt[txNonce];
        require(block.timestamp - created >= txCooldown, "Transaction is still in cooldown");
        if (txExpiration != 0) require(created + txCooldown + txExpiration >= block.timestamp, "Transaction expired");
        require(txHash[txNonce] == getTransactionHash(to, value, data, operation), "Transaction hashes do not match");
        txNonce++;
        require(exec(to, value, data, operation), "Module transaction failed");
    }

    function skipExpired() public {
        while (txExpiration != 0 && txCreatedAt[txNonce] + txCooldown + txExpiration < block.timestamp && txNonce < queueNonce) txNonce++;
    }

    function getTransactionHash(address to, uint256 value, bytes memory data, Enum.Operation operation) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(to, value, data, operation));
    }
    function getTxHash(uint256 nonce_) public view returns (bytes32) { return txHash[nonce_]; }
    function getTxCreatedAt(uint256 nonce_) public view returns (uint256) { return txCreatedAt[nonce_]; }
}
