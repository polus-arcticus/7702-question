import { type PublicClient, type WalletClient, formatEther, parseEther } from "viem";
import { mnemonicToAccount } from "viem/accounts";

// Minimal ABI for Counter contract (just the Increment event)
const COUNTER_ABI = [
  {
    type: 'event',
    name: 'Increment',
    inputs: [
      { name: 'value', type: 'uint256', indexed: false }
    ]
  }
] as const;

/**
 * Check if an EOA has code set (EIP-7702 delegation indicator)
 * @param publicClient - The public client to query
 * @param address - The EOA address to check
 * @returns true if the EOA has a delegation indicator set
 */
export async function hasCodeSet(publicClient: PublicClient, address: string): Promise<boolean> {
  try {
    const code = await publicClient.getCode({ address: address as `0x${string}` });
    // EIP-7702 delegation indicator is 0xef0100 || address (23 bytes total)
    // If code exists and is exactly 23 bytes starting with 0xef0100, it's a delegation
    
    // Handle undefined or empty code
    if (!code || code === '0x') {
      return false;
    }
    
    // Check if it's a delegation indicator
    return code.length === 46 && code.startsWith('0xef0100');
  } catch (error) {
    console.log(`Error checking code for ${address}:`, error);
    return false;
  }
}


/**
 * Find a clean EOA (without set code) from a mnemonic
 * @param publicClient - The public client to query
 * @param mnemonic - The mnemonic phrase
 * @param maxAttempts - Maximum number of addresses to check (default: 20)
 * @returns A clean EOA account
 */
export async function findCleanEOA(
  publicClient: PublicClient,
  mnemonic: string,
  maxAttempts: number = 20
): Promise<any> {
  // Generate a random starting index between 1 and 10000
  const randomStartIndex = Math.floor(Math.random() * 10000) + 1;
  console.log(`Starting search from random index: ${randomStartIndex}`);
  
  let attempts = 0;
  let index = randomStartIndex;
  
  while (attempts < maxAttempts) {
    const candidate = mnemonicToAccount(mnemonic, { addressIndex: index });
    console.log(`Checking EOA at index ${index}: ${candidate.address}`);
    
    const hasCode = await hasCodeSet(publicClient, candidate.address);
    if (!hasCode) {
      console.log(`✓ Found clean EOA at index ${index}: ${candidate.address}`);
      return candidate;
    }
    
    console.log(`✗ EOA at index ${index} has code set, trying next...`);
    
    // Move to next index, wrapping around if needed
    index = (index % 10000) + 1;
    attempts++;
  }
  
  throw new Error(`Could not find a clean EOA after checking ${maxAttempts} addresses starting from index ${randomStartIndex}`);
}

/**
 * Find a clean EOA and fund it
 * @param publicClient - The public client to query
 * @param deployerWalletClient - The wallet client to fund from
 * @param networkName - The network name
 * @param mnemonic - The mnemonic phrase
 * @param fundAmount - Amount to fund in wei
 * @param maxAttempts - Maximum number of addresses to check (default: 20)
 * @returns The funded clean EOA account
 */
export async function findAndFundEOA(
  publicClient: PublicClient,
  deployerWalletClient: WalletClient,
  networkName: string,
  mnemonic: string,
  fundAmount: bigint,
  maxAttempts: number = 20
): Promise<any> {
  console.log("\n=== Finding Clean EOA ===");
  const eoa = await findCleanEOA(publicClient, mnemonic, maxAttempts);
  
  console.log("\n=== Funding EOA ===");
  const initialBalance = await publicClient.getBalance({ address: eoa.address });
  console.log("Initial balance:", formatEther(initialBalance), "ETH");
  console.log("Target balance:", formatEther(fundAmount), "ETH");
  
  if (initialBalance < fundAmount) {
    const amountToSend = fundAmount - initialBalance;
    console.log("Sending:", formatEther(amountToSend), "ETH");
    
    const funderAddresses = await deployerWalletClient.getAddresses();
    const funder = funderAddresses[0];
    
    // Check deployer has enough balance
    const deployerBalance = await publicClient.getBalance({ address: funder });
    console.log("Deployer balance:", formatEther(deployerBalance), "ETH");
    
    if (deployerBalance < amountToSend + parseEther("0.1")) {
      throw new Error(
        `Insufficient deployer funds. Need ${formatEther(amountToSend)} ETH but only have ${formatEther(deployerBalance)} ETH. ` +
        `Please fund the deployer account: ${funder}`
      );
    }
    
    const fundHash = await deployerWalletClient.sendTransaction({
      account: funder,
      chain: publicClient.chain,
      to: eoa.address,
      value: amountToSend,
    });
    
    const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundHash });
    console.log("Funding complete:", fundHash);
    
    const newBalance = await publicClient.getBalance({ address: eoa.address });
    console.log("EOA balance:", formatEther(newBalance), "ETH");
  } else {
    console.log("EOA already has sufficient balance:", formatEther(initialBalance), "ETH");
  }
  
  return eoa;
}

/**
 * Confirm that a counter increment occurred by checking both the Increment event and storage
 * @param publicClient - The public client to query
 * @param eoaAddress - The EOA address where the counter is stored
 * @param txHash - The transaction hash to check
 * @param expectedStorageValue - The expected storage value after increment
 * @returns true if increment confirmed, false otherwise
 */
export async function confirmIncrement(
  publicClient: PublicClient,
  eoaAddress: `0x${string}`,
  txHash: `0x${string}`,
  expectedStorageValue: bigint
): Promise<boolean> {
  try {
    // Get transaction receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    
    // Check for Increment events from the EOA address
    const events = await publicClient.getContractEvents({
      address: eoaAddress,
      abi: COUNTER_ABI,
      eventName: "Increment",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    
    // Check storage at EOA address (slot 0 is where `uint public x` is stored)
    const storageAtEOA = await publicClient.getStorageAt({
      address: eoaAddress,
      slot: "0x0",
    });
    const actualStorageValue = BigInt(storageAtEOA || "0x0");
    
    const hasEvent = events.length > 0;
    const storageMatches = actualStorageValue === expectedStorageValue;
    
    console.log(`  Increment events: ${events.length}`);
    console.log(`  Expected storage: ${expectedStorageValue}, Actual: ${actualStorageValue}`);
    
    return hasEvent && storageMatches;
  } catch (error: any) {
    console.log(`  ✗ Error confirming increment: ${error.message}`);
    return false;
  }
}

/**
 * Refund remaining balance from an EOA back to the deployer
 * @param publicClient - The public client to query
 * @param eoaWalletClient - The wallet client of the EOA to refund from
 * @param deployerAddress - The deployer address to refund to
 * @param networkName - The network name
 * @param minBalanceToRefund - Minimum balance to bother refunding (default: 0.1 ETH)
 * @returns The refund transaction hash, or null if no refund needed
 */
export async function refundEOA(
  publicClient: PublicClient,
  eoaWalletClient: WalletClient,
  deployerAddress: `0x${string}`,
  networkName: string,
  minBalanceToRefund: bigint = parseEther("0.1") // 0.1 ETH
): Promise<`0x${string}` | null> {
  const eoaAddress = eoaWalletClient.account?.address;
  if (!eoaAddress) {
    console.log("⚠️  No EOA address found, skipping refund");
    return null;
  }
  
  const balance = await publicClient.getBalance({ address: eoaAddress });
  
  if (balance < minBalanceToRefund) {
    console.log(`Skipping refund: balance ${formatEther(balance)} ETH is below minimum ${formatEther(minBalanceToRefund)} ETH`);
    return null;
  }
  
  console.log(`\n=== Refunding EOA ${eoaAddress} ===`);
  console.log("Balance:", formatEther(balance), "ETH");
  
  // Estimate gas for the refund transaction
  const gasLimit = 21000n; // Standard ETH transfer
  
  // Get current gas price (for legacy) or maxFeePerGas (for EIP-1559)
  const gasPrice = await publicClient.getGasPrice();
  
  // Add a safety buffer (10%) to account for gas price fluctuations
  const gasCost = (gasLimit * gasPrice * 110n) / 100n;
  
  // Calculate amount to send (balance - gas cost with buffer)
  if (balance <= gasCost) {
    console.log("⚠️  Balance too low to cover gas, skipping refund");
    return null;
  }
  
  const amountToRefund = balance - gasCost;
  console.log("Estimated gas cost (with 10% buffer):", formatEther(gasCost), "ETH");
  console.log("Refunding:", formatEther(amountToRefund), "ETH to", deployerAddress);
  
  try {
    if (!eoaWalletClient.account) {
      console.log("⚠️  No account in wallet client, skipping refund");
      return null;
    }
    
    const refundHash = await eoaWalletClient.sendTransaction({
      account: eoaWalletClient.account,
      chain: publicClient.chain,
      to: deployerAddress,
      value: amountToRefund,
      gas: gasLimit,
    });
    
    await publicClient.waitForTransactionReceipt({ hash: refundHash });
    console.log("✓ Refund complete:", refundHash);
    
    return refundHash;
  } catch (error: any) {
    console.log("⚠️  Refund failed:", error.message);
    return null;
  }
}
