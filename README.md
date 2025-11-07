# EIP-7702 Context Preservation Bug - Minimal Reproducible Example

This project demonstrates a critical bug in EIP-7702 implementations regarding `msg.sender` identity in delegated transactions.

## The Bug

**Question:** In an EIP-7702 delegated transaction, should `msg.sender` be the **sponsor** or the **delegated EOA**?

**Expected:** `msg.sender` should be the **delegated EOA** (the account whose code is being executed).

**Actual:** `msg.sender` is the **sponsor** (the transaction signer).

## Why This Matters

**EIP-7702 sets the code AT the delegated EOA's address.** When that code executes:

**Expected Behavior:**
- `address(this)` = delegated EOA (the EOA where code is set) ✓
- `msg.sender` = delegated EOA (context preservation) ✓
- `msg.value` comes from delegated EOA's balance ✓

**Actual Behavior:**
- `address(this)` = delegated EOA ✓ (correct - code executes at the EOA)
- `msg.sender` = sponsor address ❌ (wrong - breaks context preservation)
- `msg.value` comes from sponsor's balance ❌ (wrong - should be from delegated EOA)

**The Problem:** The delegated EOA correctly receives funds at `address(this)` (because that's where the code is executing), but the sponsor incorrectly pays for them (because `msg.sender` and `msg.value` come from the sponsor's context).

## The Situation

Here's what happens in the test:

1. **Deploy Counter contract** - A user deploys `Counter.sol` to the network
2. **Delegator sets code** - The delegated EOA signs an authorization to set their code to the deployed Counter address (EIP-7702)
3. **Encode function call** - We encode the `incrementPayable(amount)` function where `amount` must equal `msg.value`
4. **The crafty delegator** - The delegated EOA has insufficient funds (0.0005 ETH) but asks a sponsor to execute a transaction requiring 0.001 ETH
5. **Sign authorization** - The delegator signs the authorization and passes it to the sponsor
6. **Sponsor executes** - The sponsor (who has sufficient funds) submits the transaction with the authorization list

**Expected:** Transaction should revert because the delegated EOA can't afford it.

**Actual:** Transaction succeeds because the sponsor's balance is used instead, and the delegated EOA receives the funds!

### Why Both Should Be Delegated EOA

When the code executes at the delegated EOA's address:

**`address(this)` = delegated EOA** ✓
- Because EIP-7702 sets the code AT the delegated EOA's address
- The code is executing in the context of the delegated EOA
- This is working correctly

**`msg.sender` = delegated EOA** ✓ (but currently broken)
- Context preservation: the delegated EOA is the account executing the code
- The sponsor is just submitting the transaction on behalf of the delegated EOA
- `msg.sender` should reflect who is executing the code, not who submitted the transaction
- This is currently returning the sponsor's address instead

## The Test

The test demonstrates this bug by:
1. Delegated EOA has 0.0005 ETH (insufficient for 0.001 ETH payable call)
2. Sponsor has 0.01 ETH (sufficient)
3. Transaction should revert (delegated EOA can't afford it)
4. **But it succeeds** because sponsor's balance is used instead

See `ContextPreservationBug.md` for full details.

## Project Overview

This project includes:

- A simple Hardhat configuration file.
- TypeScript integration tests using [`node:test`](nodejs.org/api/test.html) and [`viem`](https://viem.sh/).
- EIP-7702 payable function tests demonstrating the context preservation bug.

## Usage

### Running the Test

1. Copy the example environment file and configure your credentials:

```shell
cp .env.example .env
```

2. Edit `.env` and add your `SEPOLIA_RPC_URL` and `MNEMONIC`

3. Run the EIP-7702 context preservation bug test:

```shell
npx hardhat test ./test/SetCodePayableFunctionQuestion.ts --network sepolia
```

The test will demonstrate the bug by showing that a transaction succeeds even when the delegated EOA has insufficient balance, because the sponsor's balance is incorrectly used instead.
