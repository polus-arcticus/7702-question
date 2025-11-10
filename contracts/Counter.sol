// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "hardhat/console.sol";

struct Call {
    address to;
    uint256 value;
    bytes data;
}

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

  // ============================================================================
  // SOLUTION: Proper Sponsorship Pattern for EIP-7702
  // ============================================================================
  // 
  // The issue with direct EIP-7702 calls is that msg.sender = sponsor (not delegated EOA).
  // This breaks the expected security model for payable functions.
  //
  // SOLUTION: Implement sponsorship logic at the contract level using delegatecall
  //
  // How it works:
  // 1. Sponsor sends transaction with msg.value to the delegated EOA
  // 2. executeSponsored() transfers msg.value to target contract (pre-funding)
  // 3. Then delegatecall executes target's code in delegated EOA's storage context
  // 4. Target contract now has funds and code executes with proper context
  //
  // This achieves TRUE SPONSORSHIP:
  // - Sponsor pays gas + value
  // - Delegated EOA pays nothing
  // - Target contract receives sponsor's funds
  // - Code executes in delegated EOA's context
  // ============================================================================
  
  function executeSponsored(Call calldata call) external payable {
    // Step 1: Pre-fund the target contract with sponsor's msg.value
    if (msg.value > 0) {
        (bool sent, ) = call.to.call{value: msg.value}("");
        require(sent, "Value transfer failed");
    }
    
    // Step 2: Delegatecall to execute target's code in this contract's storage context
    // This preserves storage/balance context while executing arbitrary code
    (bool success, ) = call.to.delegatecall(call.data);
    require(success, "Delegatecall failed");
  }

  function sweep() public {
    require(msg.sender == deployer, "sweep: only deployer can sweep");
    uint balance = address(this).balance;
    require(balance > 0, "sweep: no balance to sweep");
    payable(deployer).transfer(balance);
  }

  receive() external payable {}
}
