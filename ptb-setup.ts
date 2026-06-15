import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import dotenv from 'dotenv';

dotenv.config();

const client = new SuiClient({ url: process.env.SUI_RPC || getFullnodeUrl('testnet') });

const PACKAGE = process.env.PACKAGE_ID!;
const POOL = process.env.POOL_ID!;

interface QuickSetupParams {
  signer: Ed25519Keypair;
  coinObjectId: string;           // User's SUI coin to split from
  depositAmount: bigint;          // How much to deposit (e.g., 1_000_000_000 = 1 SUI)
  dailyCap: bigint;
  monthlyCap: bigint;
  claudeCap: bigint;              // Per-provider daily cap for Claude
  openaiCap: bigint;              // Per-provider daily cap for OpenAI
  lowBalanceThreshold: bigint;    // Alert when below this
}

export async function quickSetup(params: QuickSetupParams): Promise<string> {
  const tx = new Transaction();

  // 1. Split coin for deposit
  const [paymentCoin] = tx.splitCoins(
    tx.object(params.coinObjectId),
    [tx.pure.u64(params.depositAmount)]
  );

  // 2. Deposit with source = manual
  tx.moveCall({
    target: `${PACKAGE}::seal_api_pool::deposit_with_source`,
    arguments: [
      tx.object(POOL),
      paymentCoin,
      tx.pure.vector('u8', Array.from(Buffer.from('manual'))),
      tx.object('0x6'),
    ],
  });

  // 3. Set global spend caps
  tx.moveCall({
    target: `${PACKAGE}::seal_api_pool::set_spend_caps`,
    arguments: [
      tx.object(POOL),
      tx.pure.u64(params.dailyCap),
      tx.pure.u64(params.monthlyCap),
      tx.object('0x6'),
    ],
  });

  // 4. Set Claude provider cap
  tx.moveCall({
    target: `${PACKAGE}::seal_api_pool::set_provider_cap`,
    arguments: [
      tx.object(POOL),
      tx.pure.vector('u8', Array.from(Buffer.from('claude'))),
      tx.pure.u64(params.claudeCap),
      tx.object('0x6'),
    ],
  });

  // 5. Set OpenAI provider cap
  tx.moveCall({
    target: `${PACKAGE}::seal_api_pool::set_provider_cap`,
    arguments: [
      tx.object(POOL),
      tx.pure.vector('u8', Array.from(Buffer.from('openai'))),
      tx.pure.u64(params.openaiCap),
      tx.object('0x6'),
    ],
  });

  // 6. Set low balance alert threshold
  tx.moveCall({
    target: `${PACKAGE}::seal_api_pool::set_low_balance_threshold`,
    arguments: [
      tx.object(POOL),
      tx.pure.u64(params.lowBalanceThreshold),
      tx.object('0x6'),
    ],
  });

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: params.signer,
    options: { showEffects: true, showEvents: true },
  });

  if (result.effects?.status?.status !== 'success') {
    throw new Error(`PTB failed: ${JSON.stringify(result.effects?.status)}`);
  }

  return result.digest;
}

// CLI test runner
async function main() {
  const privateKey = process.env.GATEWAY_PRIVATE_KEY!;
  const signer = Ed25519Keypair.fromSecretKey(privateKey);

  // Get user's coins
  const address = signer.getPublicKey().toSuiAddress();
  const coins = await client.getCoins({ owner: address, coinType: '0x2::sui::SUI' });

  if (coins.data.length === 0) {
    console.log('No SUI coins found');
    return;
  }

  console.log('Using coin:', coins.data[0].coinObjectId);
  console.log('Balance:', coins.data[0].balance);

  const digest = await quickSetup({
    signer,
    coinObjectId: coins.data[0].coinObjectId,
    depositAmount: BigInt(100_000_000),      // 0.5 SUI
    dailyCap: BigInt(5_000_000),             // 0.005 SUI/day
    monthlyCap: BigInt(50_000_000),          // 0.05 SUI/month
    claudeCap: BigInt(2_000_000),            // 0.002 SUI/day for Claude
    openaiCap: BigInt(1_000_000),            // 0.001 SUI/day for OpenAI
    lowBalanceThreshold: BigInt(500_000),    // alert below 0.0005 SUI
  });

  console.log('PTB success! Digest:', digest);
}

if (require.main === module) {
  main().catch(console.error);
}
