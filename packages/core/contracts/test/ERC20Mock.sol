// contracts/GLDToken.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20Mock is ERC20 {
    constructor(address to, uint256 initialSupply) ERC20("Gold", "GLD") {
        _mint(to, initialSupply);
    }
}
