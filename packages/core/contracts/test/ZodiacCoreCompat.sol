// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

// Compiler-compatible vendored surface for the pinned Delay v1.1.1 fixture.
// The upstream 1.1.1 source imports zodiac-core 4.3, whose current package
// uses Solidity transient storage syntax newer than this repository's pinned
// compiler. The Delay logic itself remains unchanged in ZodiacDelayV1_1_1.
library Enum { enum Operation { Call, DelegateCall } }

abstract contract Modifier {
    event AvatarSet(address indexed previousAvatar, address indexed newAvatar);
    event TargetSet(address indexed previousTarget, address indexed newTarget);
    event EnabledModule(address module);
    event DisabledModule(address module);

    address public owner;
    address public avatar;
    address public target;
    mapping(address => address) internal modules;
    address internal constant SENTINEL_MODULES = address(0x1);
    bool private initialized;

    modifier initializer() { require(!initialized, "already initialized"); initialized = true; _; }
    modifier onlyOwner() { require(msg.sender == owner, "Ownable: unauthorized"); _; }
    modifier moduleOnly() { require(modules[msg.sender] != address(0), "not authorized module"); _; }

    function setUp(bytes memory) public virtual;
    function execTransactionFromModule(address, uint256, bytes calldata, Enum.Operation) public virtual returns (bool);
    function execTransactionFromModuleReturnData(address, uint256, bytes calldata, Enum.Operation) public virtual returns (bool, bytes memory);

    function _transferOwnership(address next) internal { owner = next; }
    function setupModules() internal { modules[SENTINEL_MODULES] = SENTINEL_MODULES; }
    function enableModule(address module) public onlyOwner { require(module != address(0) && module != SENTINEL_MODULES && modules[module] == address(0), "invalid module"); modules[module] = modules[SENTINEL_MODULES]; modules[SENTINEL_MODULES] = module; emit EnabledModule(module); }
    function disableModule(address previous, address module) public onlyOwner { require(modules[previous] == module, "invalid module"); modules[previous] = modules[module]; delete modules[module]; emit DisabledModule(module); }
    function isModuleEnabled(address module) public view returns (bool) { return module != SENTINEL_MODULES && modules[module] != address(0); }
    function exec(address to, uint256 value, bytes memory data, Enum.Operation operation) internal returns (bool success) {
        (bool ok, bytes memory result) = target.call(abi.encodeWithSignature("execTransactionFromModule(address,uint256,bytes,uint8)", to, value, data, operation));
        success = ok && (result.length == 0 || abi.decode(result, (bool)));
    }
}
