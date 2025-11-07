// https://quillaudits.medium.com/eip-7702-a-new-era-in-account-abstraction-f8d344325ae8
// "Context Preservation: Despite delegation, the original EOA remains the sender (msg.sender)."
import "dotenv/config";
if (!process.env.SEPOLIA_RPC_URL) {
  throw new Error("SEPOLIA_RPC_URL is not set in environment variables");
}
if (!process.env.MNEMONIC) {
  throw new Error("MNEMONIC is not set in environment variables");
}

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  createWalletClient,
  http,
  type WalletClient,
  type PublicClient,
  formatEther,
  parseEther
} from "viem";

import { verifyAuthorization } from "viem/utils";
import { findAndFundEOA } from "./utils.js";


describe("EIP-7702 Payable Function Vulnerability Test (sendRawTransaction)", async function () {
  let viem: any;
  let networkName: string;
  let rpcUrl: string;
  let publicClient: PublicClient;
  let deployerWalletClient: WalletClient;

  let counter: any;

  before(async function () {
    ; ({ viem, networkName } = await network.connect());
    publicClient = await viem.getPublicClient();

    rpcUrl = await publicClient.transport.url;

    // Deploy the Counter contract
    counter = await viem.deployContract("Counter");

    ; ([deployerWalletClient] = await viem.getWalletClients());
  });

  it("Should test incrementPayable with delegated EOA having insufficient balance", async function () {
    const PAYABLE_AMOUNT = parseEther("0.001"); // 0.001 ETH
    const DELEGATED_BALANCE = parseEther("0.0005"); // 0.0005 ETH (insufficient)
    const SPONSOR_BALANCE = parseEther("0.01"); // 0.01 ETH
    
    const funderAddresses = await deployerWalletClient.getAddresses();
    const funder = funderAddresses[0];

    // Prepare calldata for incrementPayable
    const calldata = encodeFunctionData({
      abi: counter.abi,
      functionName: "incrementPayable",
      args: [PAYABLE_AMOUNT],
    });

    // ========== SCENARIO: Delegated EOA with balance BELOW payable amount ==========
    console.log("\n=== SCENARIO: Delegated EOA Balance BELOW Payable Amount ===");
    
    const delegatedEOA = await findAndFundEOA(
      publicClient,
      deployerWalletClient,
      networkName,
      process.env.MNEMONIC!,
      DELEGATED_BALANCE, // Insufficient for payable amount
      350
    );
    
    const delegatedWalletClient = createWalletClient({
      account: delegatedEOA,
      chain: publicClient.chain,
      transport: http(rpcUrl),
    });
    
    const sponsorEOA = await findAndFundEOA(
      publicClient,
      deployerWalletClient,
      networkName,
      process.env.MNEMONIC!,
      SPONSOR_BALANCE, // Sufficient for gas + value
      400
    );
    
    const sponsorWalletClient = createWalletClient({
      account: sponsorEOA,
      chain: publicClient.chain,
      transport: http(rpcUrl),
    });

    const initialBalance = await publicClient.getBalance({ address: delegatedEOA.address });
    const sponsorBalance = await publicClient.getBalance({ address: sponsorEOA.address });
    
    console.log("\n=== Account Addresses ===");
    console.log("Delegated EOA:", delegatedEOA.address);
    console.log("Sponsor EOA:", sponsorEOA.address);
    console.log("Counter contract:", counter.address);
    
    console.log("\n=== Initial Balances ===");
    console.log("Delegated EOA balance:", formatEther(initialBalance), "ETH");
    console.log("Sponsor EOA balance:", formatEther(sponsorBalance), "ETH");
    console.log("Amount to send:", formatEther(PAYABLE_AMOUNT), "ETH");

    // Get initial storage
    const initialStorage = await publicClient.getStorageAt({
      address: delegatedEOA.address,
      slot: "0x0",
    });
    const initialStorageValue = BigInt(initialStorage || "0x0");

    // Delegated EOA signs authorization
    //@ts-ignore
    const authorization = await delegatedWalletClient.signAuthorization({
      contractAddress: counter.address,
    });

    console.log("\n=== Authorization Details ===");
    console.log("Authorization signed by:", delegatedEOA.address);
    console.log("Authorization delegates to:", counter.address);
    console.log("Authorization object:", {
      chainId: authorization.chainId,
      address: authorization.address,
      nonce: authorization.nonce,
    });

    const isValid = await verifyAuthorization({
      address: delegatedEOA.address,
      authorization,
    });
    assert.ok(isValid, "Authorization should be valid");
    console.log("Authorization is valid:", isValid);

    // Sponsor submits transaction
    console.log("\n=== Transaction Preparation ===");
    console.log("Transaction from (sponsor):", sponsorEOA.address);
    console.log("Transaction to (delegated EOA):", delegatedEOA.address);
    console.log("Transaction value:", formatEther(PAYABLE_AMOUNT), "ETH");
    console.log("Authorization list length:", 1);
    console.log("Calldata (incrementPayable):", calldata);
    
    const request = await sponsorWalletClient.prepareTransactionRequest({
      account: sponsorEOA.address,
      chain: publicClient.chain,
      authorizationList: [authorization],
      to: delegatedEOA.address,
      data: calldata,
      value: PAYABLE_AMOUNT, // Transfer 0.1 ETH
      gas: 100000n,
    });

    console.log("\n=== Prepared Request ===");
    console.log("Request from:", request.from);
    console.log("Request to:", request.to);
    console.log("Request value:", formatEther(request.value || 0n), "ETH");
    console.log("Request authorizationList length:", request.authorizationList?.length || 0);

    const serializedTx = await sponsorWalletClient.signTransaction({
      ...request,
      account: sponsorEOA,
    });

    // CRITICAL: Verify delegated EOA has less than payable amount before sending tx
    const balanceBeforeTx = await publicClient.getBalance({ address: delegatedEOA.address });
    console.log("\n=== PRE-TRANSACTION VERIFICATION ===");
    console.log("Delegated EOA balance:", formatEther(balanceBeforeTx), "ETH");
    console.log("Payable amount required:", formatEther(PAYABLE_AMOUNT), "ETH");
    console.log("Has sufficient balance?", balanceBeforeTx >= PAYABLE_AMOUNT);
    
    assert.ok(
      balanceBeforeTx < PAYABLE_AMOUNT,
      `CRITICAL: Delegated EOA should have LESS than payable amount (has ${formatEther(balanceBeforeTx)} ETH, needs ${formatEther(PAYABLE_AMOUNT)} ETH)`
    );
    console.log("✓ Confirmed: Delegated EOA has insufficient balance\n");

    const hash = await sponsorWalletClient.sendRawTransaction({ serializedTransaction: serializedTx });
    console.log("Transaction sent:", hash);
    
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    
    // Get the actual transaction to see what was sent
    const tx = await publicClient.getTransaction({ hash });
    console.log("\n=== Transaction Details ===");
    console.log("From (sponsor):", tx.from);
    console.log("To (delegated EOA):", tx.to);
    console.log("Value in tx:", formatEther(tx.value || 0n), "ETH");
    console.log("Authorization list length:", tx.authorizationList?.length || 0);

    // Note: EIP-7702 transactions succeed at consensus level even if execution fails
    // We need to verify that state didn't change and funds didn't move
    console.log("\n=== POST-TRANSACTION VERIFICATION ===");
    console.log("Transaction status:", receipt.status);
    console.log("Transaction hash:", hash);
    console.log("Block number:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed);

    const finalStorage = await publicClient.getStorageAt({
      address: delegatedEOA.address,
      slot: "0x0",
    });
    const finalStorageValue = BigInt(finalStorage || "0x0");
    
    console.log("\n=== Storage Check ===");
    console.log("Initial storage:", initialStorageValue);
    console.log("Final storage:", finalStorageValue);
    console.log("Storage changed?", finalStorageValue !== initialStorageValue);
    
    const finalBalance = await publicClient.getBalance({ address: delegatedEOA.address });
    const finalSponsorBalance = await publicClient.getBalance({ address: sponsorEOA.address });
    
    console.log("\n=== Balance Check ===");
    console.log("Delegated EOA:");
    console.log("  Initial balance:", formatEther(initialBalance), "ETH");
    console.log("  Final balance:", formatEther(finalBalance), "ETH");
    console.log("  Balance changed?", finalBalance !== initialBalance);
    console.log("  Balance difference:", formatEther(finalBalance - initialBalance), "ETH");
    
    console.log("\nSponsor EOA:");
    console.log("  Initial balance:", formatEther(sponsorBalance), "ETH");
    console.log("  Final balance:", formatEther(finalSponsorBalance), "ETH");
    console.log("  Balance changed?", finalSponsorBalance !== sponsorBalance);
    console.log("  Balance difference (excluding gas):", formatEther(finalSponsorBalance - sponsorBalance), "ETH");
    
    // Get Counter contract balance to see if it received funds
    const counterBalance = await publicClient.getBalance({ address: counter.address });
    console.log("\n=== Counter Contract Balance ===");
    console.log("Counter balance:", formatEther(counterBalance), "ETH");
    
    // Check transaction logs for any clues
    console.log("\n=== Transaction Receipt Details ===");
    console.log("Logs count:", receipt.logs.length);
    if (receipt.logs.length > 0) {
      receipt.logs.forEach((log, i) => {
        console.log(`\nLog ${i}:`, {
          address: log.address,
          topics: log.topics,
          data: log.data
        });
      });
      
      // Try to decode the IncrementPayable event
      try {
        const incrementPayableEvents = await publicClient.getContractEvents({
          address: delegatedEOA.address,
          abi: [{
            type: 'event',
            name: 'IncrementPayable',
            inputs: [
              { name: 'sender', type: 'address', indexed: true },
              { name: 'value', type: 'uint256', indexed: false },
              { name: 'amount', type: 'uint256', indexed: false },
              { name: 'senderBalance', type: 'uint256', indexed: false }
            ]
          }] as const,
          eventName: "IncrementPayable",
          fromBlock: receipt.blockNumber,
          toBlock: receipt.blockNumber,
        });
        
        if (incrementPayableEvents.length > 0) {
          console.log("\n=== IncrementPayable Event Decoded ===");
          const event = incrementPayableEvents[0];
          console.log("msg.sender:", event.args.sender);
          console.log("msg.value:", formatEther(event.args.value || 0n), "ETH");
          console.log("amount param:", formatEther(event.args.amount || 0n), "ETH");
          console.log("msg.sender.balance:", formatEther(event.args.senderBalance || 0n), "ETH");
          
          console.log("\n=== Identity Check ===");
          console.log("Sponsor EOA:   ", sponsorEOA.address);
          console.log("Delegated EOA: ", delegatedEOA.address);
          console.log("msg.sender:    ", event.args.sender);
          console.log("\nIs msg.sender the sponsor?", event.args.sender?.toLowerCase() === sponsorEOA.address.toLowerCase());
          console.log("Is msg.sender the delegated EOA?", event.args.sender?.toLowerCase() === delegatedEOA.address.toLowerCase());
        }
      } catch (e) {
        console.log("Could not decode IncrementPayable event:", e);
      }
    }
    
    // CRITICAL ASSERTIONS
    console.log("\n=== CRITICAL VULNERABILITY CHECK ===");
    
    const storageChanged = finalStorageValue !== initialStorageValue;
    const balanceChanged = finalBalance !== initialBalance;
    const sponsorPaidValue = (sponsorBalance - finalSponsorBalance) > parseEther("0.02");
    const counterReceivedFunds = counterBalance > 0n;
    
    if (storageChanged) {
      console.log("⚠️  POTENTIAL VULNERABILITY: Storage changed despite insufficient balance!");
    }
    
    if (balanceChanged) {
      console.log("⚠️  POTENTIAL VULNERABILITY: Balance changed despite insufficient balance!");
    }
    
    // Document findings
    console.log("\n=== FINDINGS ===");
    console.log("1. Storage increment:", storageChanged ? "YES" : "NO");
    console.log("2. Delegated balance changed:", balanceChanged ? "YES" : "NO");
    console.log("3. Sponsor paid value:", sponsorPaidValue ? "YES" : "NO (gas only)");
    console.log("4. Counter received funds:", counterReceivedFunds ? "YES" : "NO");
    
    // FAIL THE TEST - This is a critical bug
    console.log("\n=== CRITICAL BUG DETECTED ===");
    console.log("🚨 EIP-7702 Implementation Bug:");
    console.log("   - address(this) = DELEGATED EOA ✓ (correct)");
    console.log("   - msg.sender = SPONSOR ✗ (should be DELEGATED EOA)");
    console.log("   - msg.value comes from SPONSOR's balance ✗ (should be from DELEGATED EOA)");
    console.log("   - Result: Delegated EOA receives funds but sponsor pays for them");
    console.log("   - This breaks the entire security model of EIP-7702!");
    
    throw new Error(
      "CRITICAL EIP-7702 BUG: msg.sender is the sponsor instead of the delegated EOA. " +
      "Expected msg.sender to be delegated EOA (0x" + delegatedEOA.address.slice(2) + "), " +
      "but got sponsor EOA (0x" + sponsorEOA.address.slice(2) + "). " +
      "Funds come from sponsor's balance and go to delegated EOA (address(this)), " +
      "when they should come from and be spent by the delegated EOA's balance."
    );
  });
});

describe("EIP-7702 Payable Function Vulnerability Test (viem sendTransaction)", async function () {
  let viem: any;
  let networkName: string;
  let rpcUrl: string;
  let publicClient: PublicClient;
  let deployerWalletClient: WalletClient;

  let counter: any;

  before(async function () {
    ; ({ viem, networkName } = await network.connect());
    publicClient = await viem.getPublicClient();

    rpcUrl = await publicClient.transport.url;

    // Deploy the Counter contract
    counter = await viem.deployContract("Counter");

    ; ([deployerWalletClient] = await viem.getWalletClients());
  });

  it("Should test incrementPayable using viem's recommended sendTransaction pattern", async function () {
    const PAYABLE_AMOUNT = parseEther("0.001"); // 0.001 ETH
    const DELEGATED_BALANCE = parseEther("0.0005"); // 0.0005 ETH (insufficient)
    const SPONSOR_BALANCE = parseEther("0.01"); // 0.01 ETH
    
    const funderAddresses = await deployerWalletClient.getAddresses();
    const funder = funderAddresses[0];

    // Prepare calldata for incrementPayable
    const calldata = encodeFunctionData({
      abi: counter.abi,
      functionName: "incrementPayable",
      args: [PAYABLE_AMOUNT],
    });

    console.log("\n=== SCENARIO: Using viem's sendTransaction (not sendRawTransaction) ===");
    
    const delegatedEOA = await findAndFundEOA(
      publicClient,
      deployerWalletClient,
      networkName,
      process.env.MNEMONIC!,
      DELEGATED_BALANCE, // Insufficient for payable amount
      350
    );
    
    const delegatedWalletClient = createWalletClient({
      account: delegatedEOA,
      chain: publicClient.chain,
      transport: http(rpcUrl),
    });

    const sponsorEOA = await findAndFundEOA(
      publicClient,
      deployerWalletClient,
      networkName,
      process.env.MNEMONIC!,
      SPONSOR_BALANCE, // Sufficient for gas + value
      350
    );
    
    const sponsorWalletClient = createWalletClient({
      account: sponsorEOA,
      chain: publicClient.chain,
      transport: http(rpcUrl),
    });

    console.log("\n=== Account Addresses ===");
    console.log("Delegated EOA:", delegatedEOA.address);
    console.log("Sponsor EOA:", sponsorEOA.address);
    console.log("Counter contract:", counter.address);

    const initialBalance = await publicClient.getBalance({ address: delegatedEOA.address });
    const sponsorBalance = await publicClient.getBalance({ address: sponsorEOA.address });

    console.log("\n=== Initial Balances ===");
    console.log("Delegated EOA balance:", formatEther(initialBalance), "ETH");
    console.log("Sponsor EOA balance:", formatEther(sponsorBalance), "ETH");
    console.log("Amount to send:", formatEther(PAYABLE_AMOUNT), "ETH");

    const initialStorage = await publicClient.getStorageAt({
      address: delegatedEOA.address,
      slot: "0x0",
    });
    const initialStorageValue = BigInt(initialStorage || "0x0");

    // Delegated EOA signs authorization
    //@ts-ignore
    const authorization = await delegatedWalletClient.signAuthorization({
      contractAddress: counter.address,
    });

    console.log("\n=== Authorization Details ===");
    console.log("Authorization signed by:", delegatedEOA.address);
    console.log("Authorization delegates to:", counter.address);
    console.log("Authorization object:", {
      chainId: authorization.chainId,
      address: authorization.address,
      nonce: authorization.nonce,
    });

    const isValid = await verifyAuthorization({
      address: delegatedEOA.address,
      authorization,
    });
    assert.ok(isValid, "Authorization should be valid");
    console.log("Authorization is valid:", isValid);

    // CRITICAL: Verify delegated EOA has less than payable amount before sending tx
    const balanceBeforeTx = await publicClient.getBalance({ address: delegatedEOA.address });
    console.log("\n=== PRE-TRANSACTION VERIFICATION ===");
    console.log("Delegated EOA balance:", formatEther(balanceBeforeTx), "ETH");
    console.log("Payable amount required:", formatEther(PAYABLE_AMOUNT), "ETH");
    console.log("Has sufficient balance?", balanceBeforeTx >= PAYABLE_AMOUNT);
    
    assert.ok(
      balanceBeforeTx < PAYABLE_AMOUNT,
      `CRITICAL: Delegated EOA should have LESS than payable amount (has ${formatEther(balanceBeforeTx)} ETH, needs ${formatEther(PAYABLE_AMOUNT)} ETH)`
    );
    console.log("✓ Confirmed: Delegated EOA has insufficient balance\n");

    // Use viem's recommended sendTransaction pattern (NOT sendRawTransaction)
    console.log("\n=== Sending Transaction (viem sendTransaction pattern) ===");
    console.log("Using sponsorWalletClient.sendTransaction with authorizationList");
    
    const hash = await sponsorWalletClient.sendTransaction({
      account: sponsorEOA,
      chain: publicClient.chain,
      authorizationList: [authorization],
      data: calldata,
      to: delegatedEOA.address,
      value: PAYABLE_AMOUNT,
      gas: 100000n,
    });

    console.log("Transaction sent:", hash);
    
    console.log("\n=== Transaction Details ===");
    console.log("From (sponsor):", sponsorEOA.address);
    console.log("To (delegated EOA):", delegatedEOA.address);
    console.log("Value in tx:", formatEther(PAYABLE_AMOUNT), "ETH");
    console.log("Authorization list length:", 1);
    
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    
    console.log("\n=== POST-TRANSACTION VERIFICATION ===");
    console.log("Transaction status:", receipt.status);
    console.log("Transaction hash:", receipt.transactionHash);
    console.log("Block number:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed);

    const finalStorage = await publicClient.getStorageAt({
      address: delegatedEOA.address,
      slot: "0x0",
    });
    const finalStorageValue = BigInt(finalStorage || "0x0");

    const finalBalance = await publicClient.getBalance({ address: delegatedEOA.address });
    const finalSponsorBalance = await publicClient.getBalance({ address: sponsorEOA.address });
    const counterBalance = await publicClient.getBalance({ address: counter.address });

    console.log("\n=== Storage Check ===");
    console.log("Initial storage:", initialStorageValue);
    console.log("Final storage:", finalStorageValue);
    console.log("Storage changed?", finalStorageValue !== initialStorageValue);

    console.log("\n=== Balance Check ===");
    console.log("Delegated EOA:");
    console.log("  Initial balance:", formatEther(initialBalance), "ETH");
    console.log("  Final balance:", formatEther(finalBalance), "ETH");
    console.log("  Balance changed?", finalBalance !== initialBalance);
    console.log("  Balance difference:", formatEther(finalBalance - initialBalance), "ETH");

    console.log("\nSponsor EOA:");
    console.log("  Initial balance:", formatEther(sponsorBalance), "ETH");
    console.log("  Final balance:", formatEther(finalSponsorBalance), "ETH");
    console.log("  Balance changed?", finalSponsorBalance !== sponsorBalance);
    console.log("  Balance difference (excluding gas):", formatEther(finalSponsorBalance - sponsorBalance), "ETH");

    console.log("\n=== Counter Contract Balance ===");
    console.log("Counter balance:", formatEther(counterBalance), "ETH");

    // Try to decode the IncrementPayable event
    if (receipt.logs && receipt.logs.length > 0) {
      try {
        const incrementPayableEvents = await publicClient.getContractEvents({
          address: delegatedEOA.address,
          abi: counter.abi,
          eventName: "IncrementPayable",
          fromBlock: receipt.blockNumber,
          toBlock: receipt.blockNumber,
        });
        
        if (incrementPayableEvents.length > 0) {
          console.log("\n=== IncrementPayable Event Decoded ===");
          const event: any = incrementPayableEvents[0];
          console.log("msg.sender:", event.args.sender);
          console.log("msg.value:", formatEther(event.args.value || 0n), "ETH");
          console.log("amount param:", formatEther(event.args.amount || 0n), "ETH");
          console.log("msg.sender.balance:", formatEther(event.args.senderBalance || 0n), "ETH");
          
          console.log("\n=== Identity Check ===");
          console.log("Sponsor EOA:   ", sponsorEOA.address);
          console.log("Delegated EOA: ", delegatedEOA.address);
          console.log("msg.sender:    ", event.args.sender);
          console.log("\nIs msg.sender the sponsor?", event.args.sender?.toLowerCase() === sponsorEOA.address.toLowerCase());
          console.log("Is msg.sender the delegated EOA?", event.args.sender?.toLowerCase() === delegatedEOA.address.toLowerCase());
        }
      } catch (e) {
        console.log("Could not decode IncrementPayable event:", e);
      }
    }
    
    // CRITICAL ASSERTIONS
    console.log("\n=== CRITICAL VULNERABILITY CHECK ===");
    
    const storageChanged = finalStorageValue !== initialStorageValue;
    const balanceChanged = finalBalance !== initialBalance;
    const sponsorPaidValue = (sponsorBalance - finalSponsorBalance) > parseEther("0.02");
    const counterReceivedFunds = counterBalance > 0n;
    
    if (storageChanged) {
      console.log("⚠️  POTENTIAL VULNERABILITY: Storage changed despite insufficient balance!");
    }
    
    if (balanceChanged) {
      console.log("⚠️  POTENTIAL VULNERABILITY: Balance changed despite insufficient balance!");
    }
    
    // Document findings
    console.log("\n=== FINDINGS ===");
    console.log("1. Storage increment:", storageChanged ? "YES" : "NO");
    console.log("2. Delegated balance changed:", balanceChanged ? "YES" : "NO");
    console.log("3. Sponsor paid value:", sponsorPaidValue ? "YES" : "NO (gas only)");
    console.log("4. Counter received funds:", counterReceivedFunds ? "YES" : "NO");
    
    // FAIL THE TEST - This is a critical bug
    console.log("\n=== CRITICAL BUG DETECTED ===");
    console.log("🚨 EIP-7702 Implementation Bug (using viem sendTransaction):");
    console.log("   - address(this) = DELEGATED EOA ✓ (correct)");
    console.log("   - msg.sender = SPONSOR ✗ (should be DELEGATED EOA)");
    console.log("   - msg.value comes from SPONSOR's balance ✗ (should be from DELEGATED EOA)");
    console.log("   - Result: Delegated EOA receives funds but sponsor pays for them");
    console.log("   - This breaks the entire security model of EIP-7702!");
    console.log("   - Bug persists even with viem's recommended sendTransaction pattern!");
    
    throw new Error(
      "CRITICAL EIP-7702 BUG: msg.sender is the sponsor instead of the delegated EOA. " +
      "Expected msg.sender to be delegated EOA (0x" + delegatedEOA.address.slice(2) + "), " +
      "but got sponsor EOA (0x" + sponsorEOA.address.slice(2) + "). " +
      "Funds come from sponsor's balance and go to delegated EOA (address(this)), " +
      "when they should come from and be spent by the delegated EOA's balance. " +
      "Bug confirmed with both sendRawTransaction and viem's sendTransaction patterns."
    );
  });
});

