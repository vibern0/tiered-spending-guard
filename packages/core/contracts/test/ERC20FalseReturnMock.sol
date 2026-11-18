// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ERC20FalseReturnMock {
    mapping(address => uint256) public balanceOf;

    constructor(address holder, uint256 amount) {
        balanceOf[holder] = amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}
