// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "hardhat/console.sol";

contract Counter {
  uint public x;
  address public deployer;

  event Increment(uint by);
  event IncrementPayable(address indexed sender, uint256 value, uint256 amount, uint256 senderBalance);

  constructor() {
    deployer = msg.sender;
  }

  function inc() public {
    x++;
    emit Increment(1);
  }

  function incBy(uint by) public {
    require(by > 0, "incBy: increment should be positive");
    x += by;
    emit Increment(by);
  }

  function incrementPayable(uint amount) public payable {
    // Emit detailed event BEFORE any checks to capture what actually happened
    
    require(msg.value == amount, "incrementPayable: msg.value must equal amount");
    require(amount > 0, "incrementPayable: amount must be positive");
    
    // msg.value is already transferred to this contract automatically
    // The question is: in EIP-7702, does it come from the delegated EOA or the sponsor?
    // This should pull from msg.sender's balance (which should be the delegated EOA in EIP-7702)
    
    x += 1;
    emit IncrementPayable(msg.sender, msg.value, amount, msg.sender.balance);
  }

  function sweep() public {
    require(msg.sender == deployer, "sweep: only deployer can sweep");
    uint balance = address(this).balance;
    require(balance > 0, "sweep: no balance to sweep");
    payable(deployer).transfer(balance);
  }

  receive() external payable {}
}
