# EIP-7702: Should `msg.sender` be the sponsor or delegated EOA in payable delegations?

## Context

I'm testing EIP-7702 (Set EOA Account Code) on Sepolia and encountering unexpected behavior with `msg.sender` in delegated transactions involving payable functions.

## The Setup

1. Deploy a `Counter` contract with a payable function:
```solidity
function incrementPayable(uint amount) public payable {
    require(msg.value == amount, "msg.value must equal amount");
    require(amount > 0, "amount must be positive");
    x += 1;
    emit IncrementPayable(msg.sender, msg.value, amount, msg.sender.balance);
}
```

2. Delegated EOA signs an authorization to set their code to the Counter contract address
3. Delegated EOA has **0.0005 ETH** (insufficient for the 0.001 ETH payable call)
4. Sponsor EOA has **0.01 ETH** (sufficient)
5. Sponsor submits transaction with `authorizationList` containing the delegated EOA's authorization

## The Question

**When the code executes at the delegated EOA's address, should `msg.sender` be the sponsor or the delegated EOA?**

According to my understanding of EIP-7702:
- `address(this)` = delegated EOA (because that's where the code is set and executing) ✓
- `msg.sender` = delegated EOA (context preservation - the delegated EOA is executing the code)
- `msg.value` should come from the delegated EOA's balance

## Observed Behavior

The transaction **succeeds** when it should fail:

```
✓ address(this) = delegated EOA (correct - funds go to delegated EOA)
✗ msg.sender = sponsor EOA (expected: delegated EOA)
✗ msg.value comes from sponsor's balance (expected: delegated EOA's balance)

Result:
- Sponsor pays 0.001 ETH + gas
- Delegated EOA receives 0.001 ETH at address(this)
- Transaction succeeds despite delegated EOA having insufficient funds
```

## Expected Behavior

The transaction should **revert** because the delegated EOA only has 0.0005 ETH but needs 0.001 ETH. The `msg.sender` should be the delegated EOA (context preservation), and `msg.value` should be deducted from the delegated EOA's balance, not the sponsor's.

## Security Concern

If `msg.sender` is the sponsor and `msg.value` comes from the sponsor's balance, a malicious delegated EOA can trick sponsors into draining their own funds:
1. Attacker (delegated EOA) signs authorization for a payable contract
2. Sponsor thinks they're helping the delegated EOA execute a transaction
3. Sponsor pays from their own balance while delegated EOA receives the funds at `address(this)`

## Test Code

Full reproducible test available at: https://github.com/polus-arcticus/7702-question

```typescript
// Delegated EOA signs authorization
const authorization = await delegatedWalletClient.signAuthorization({
  contractAddress: counter.address,
});

// Sponsor sends transaction
const hash = await sponsorWalletClient.sendTransaction({
  account: sponsorEOA,
  authorizationList: [authorization],
  to: delegatedEOA.address,
  data: encodeFunctionData({
    abi: counter.abi,
    functionName: "incrementPayable",
    args: [parseEther("0.001")],
  }),
  value: parseEther("0.001"),
  gas: 100000n,
});
```

## Reproduction Steps

```bash
git clone https://github.com/polus-arcticus/7702-question
cd 7702-question
cp .env.example .env
# Edit .env with your SEPOLIA_RPC_URL and MNEMONIC
npx hardhat test ./test/SetCodePayableFunctionQuestion.ts --network sepolia
```

## Questions

1. **Is this the intended behavior of EIP-7702?** Should `msg.sender` be the sponsor or the delegated EOA?
2. **Should `msg.value` come from the sponsor's balance or the delegated EOA's balance?**
3. **Is there a specification or reference that clarifies the expected context preservation semantics?**

## References

The [EIP-7702 spec](https://eips.ethereum.org/EIPS/eip-7702) states in the [Behavior section](https://eips.ethereum.org/EIPS/eip-7702#behavior):
> "All code executing operations must load and execute the code pointed to by the delegation."

Regarding context preservation, [QuillAudits' EIP-7702 Analysis](https://quillaudits.medium.com/eip-7702-a-new-era-in-account-abstraction-f8d344325ae8) states:
> "Context Preservation: Despite delegation, the original EOA remains the sender (`msg.sender`)."

However, I interpret "original EOA" as the delegated EOA (whose code is being executed), not the sponsor EOA (who submits the transaction). The current behavior seems to treat the sponsor as `msg.sender`, which breaks the security model for payable functions.

## Environment

- Network: Sepolia testnet
- Testing with: Hardhat + Viem
- EIP-7702 implementation: Latest Sepolia fork

---

## ✅ SOLUTION

After extensive testing, I discovered that **the observed behavior is correct per the EIP-7702 specification**. In EIP-7702:

- `msg.sender` = **transaction signer (sponsor)**, not the delegated EOA
- `msg.value` = comes from the **sponsor's balance**
- `address(this)` = delegated EOA address

This is **working as intended**. The confusion arose from misinterpreting "context preservation."

### The Real Solution: Implement Sponsorship at the Contract Level

**Don't try to achieve proper sponsorship from the JavaScript/transaction side. Instead, implement the sponsorship logic in your contract using `delegatecall`.**

Add this function to your implementation contract:

```solidity
struct Call {
    address to;
    uint256 value;
    bytes data;
}

function executeSponsored(Call calldata call) external payable {
    // Step 1: Transfer sponsor's msg.value to target contract (pre-funding)
    if (msg.value > 0) {
        (bool sent, ) = call.to.call{value: msg.value}("");
        require(sent, "Value transfer failed");
    }
    
    // Step 2: Delegatecall to execute target's code in this (delegated EOA's) storage context
    (bool success, ) = call.to.delegatecall(call.data);
    require(success, "Delegatecall failed");
}
```

### How This Achieves True Sponsorship

1. **Sponsor** sends transaction with `msg.value` to the **delegated EOA**
2. `executeSponsored()` transfers `msg.value` to the **target contract** (pre-funding)
3. **Delegatecall** executes the target's code in the **delegated EOA's storage context**
4. Target contract now has funds and can execute properly

### The Result

- ✅ Sponsor pays gas + value
- ✅ Delegated EOA pays **nothing**
- ✅ Target contract receives sponsor's funds
- ✅ Code executes in delegated EOA's context
- ✅ No security vulnerability

### Key Insight

The pattern is:
1. **Pre-fund** the target contract using `call{value: msg.value}`
2. **Then** execute via `delegatecall` for context preservation

This separates value transfer (from sponsor) from code execution (in delegated context), giving you proper sponsorship semantics.

## Tags

`ethereum` `eip-7702` `solidity` `account-abstraction` `msg.sender`

