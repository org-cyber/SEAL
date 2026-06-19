import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

const client = new SuiClient({ url: getFullnodeUrl('testnet') });

const PACKAGE = process.env.PACKAGE_ID!;
const POOL = process.env.POOL_ID!;

// ── USER-SIGNED DEPOSIT ─────────────────────────────────────────────────────
// This script is for the TREASURY OWNER to deposit funds into their own wallet.
// It uses the user's private key, NOT the gateway key.
// 
// Usage:
//   SUI_PRIVATE_KEY=suiprivkey1... npx tsx deposit.ts [amount_in_mist]
//
// If SUI_PRIVATE_KEY is not set, it prompts for one (not recommended for production).

async function promptForKey(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('Enter your Sui private key (suiprivkey1...): ', (key) => {
      rl.close();
      resolve(key.trim());
    });
  });
}

async function main() {
  let privateKey = process.env.SUI_PRIVATE_KEY;

  if (!privateKey) {
    console.log('SUI_PRIVATE_KEY not set in environment.');
    privateKey = await promptForKey();
  }

  const keypair = Ed25519Keypair.fromSecretKey(privateKey);
  const myAddress = keypair.getPublicKey().toSuiAddress();

  console.log('Depositing from:', myAddress);

  // Parse amount from command line or default to 0.5 SUI
  const amountArg = process.argv[2];
  const depositAmount = amountArg ? BigInt(amountArg) : 500_000_000n;

  console.log(`Amount: ${depositAmount} MIST (${Number(depositAmount) / 1e9} SUI)`);

  // Find SUI coins in this wallet
  const coins = await client.getCoins({ owner: myAddress, coinType: '0x2::sui::SUI' });

  if (coins.data.length === 0) {
    console.log('❌ No SUI coins found. Get testnet SUI from faucet.sui.io first.');
    return;
  }

  console.log(`Found ${coins.data.length} coin(s)`);
  console.log(`Using coin: ${coins.data[0].coinObjectId} (Balance: ${coins.data[0].balance})`);

  // Check if coin has enough balance
  const coinBalance = BigInt(coins.data[0].balance);
  if (coinBalance < depositAmount) {
    console.log(`❌ Coin balance (${coinBalance}) is less than deposit amount (${depositAmount}).`);
    console.log('Try a smaller amount or merge coins first.');
    return;
  }

  const tx = new Transaction();

  // Split deposit amount from the coin
  const [paymentCoin] = tx.splitCoins(
    tx.object(coins.data[0].coinObjectId),
    [tx.pure.u64(depositAmount)]
  );

  // Deposit with source = manual
  tx.moveCall({
    target: `${PACKAGE}::seal_api_pool::deposit_with_source`,
    arguments: [
      tx.object(POOL),
      paymentCoin,
      tx.pure.vector('u8', Array.from(Buffer.from('manual'))),
      tx.object('0x6'),
    ],
  });

  console.log('Signing and executing transaction...');

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showEvents: true },
  });

  console.log('✅ Deposit successful!');
  console.log('Digest:', result.digest);
  console.log('Status:', result.effects?.status?.status);

  // Check for deposit event
  const depositEvent = result.events?.find(e => e.type.includes('DepositEvent'));
  if (depositEvent?.parsedJson) {
    const parsed = depositEvent.parsedJson as any;
    console.log('New balance:', parsed.new_balance);
    console.log('Source:', Buffer.from(parsed.source).toString());
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
