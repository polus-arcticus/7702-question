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

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npx hardhat test
```

You can also selectively run the Solidity or `node:test` tests:

```shell
npx hardhat test solidity
npx hardhat test nodejs
```

### Make a deployment to Sepolia

This project includes an example Ignition module to deploy the contract. You can deploy this module to a locally simulated chain or to Sepolia.

To run the deployment to a local chain:

```shell
npx hardhat ignition deploy ignition/modules/Counter.ts
```

To run the deployment to Sepolia, you need an account with funds to send the transaction. The provided Hardhat configuration includes a Configuration Variable called `SEPOLIA_PRIVATE_KEY`, which you can use to set the private key of the account you want to use.

You can set the `SEPOLIA_PRIVATE_KEY` variable using the `hardhat-keystore` plugin or by setting it as an environment variable.

To set the `SEPOLIA_PRIVATE_KEY` config variable using `hardhat-keystore`:

```shell
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
```

After setting the variable, you can run the deployment with the Sepolia network:

```shell
npx hardhat ignition deploy --network sepolia ignition/modules/Counter.ts
```
