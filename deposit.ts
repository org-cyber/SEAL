import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import dotenv from 'dotenv';

dotenv.config();

const client = new SuiClient({ url: getFullnodeUrl('testnet') });
const keypair = Ed25519Keypair.fromSecretKey(process.env.GATEWAY_PRIVATE_KEY!);
const myAddress = keypair.getPublicKey().toSuiAddress();

const PACKAGE = process.env.PACKAGE_ID!;
const POOL = process.env.POOL_ID!;

async function main() {
  // Find SUI coins in this wallet
  const coins = await client.getCoins({ owner: myAddress, coinType: '0x2::sui::SUI' });
  
  if (coins.data.length === 0) {
    console.log('No SUI coins found. Get testnet SUI from faucet.sui.io first.');
    return;
  }

  console.log('Found', coins.data.length, 'coin(s)');
  console.log('Using coin:', coins.data[0].coinObjectId, 'Balance:', coins.data[0].balance);

  const tx = new Transaction();
  
  // Split 0.5 SUI (500,000,000 MIST) from your coin to deposit
  const [paymentCoin] = tx.splitCoins(tx.object(coins.data[0].coinObjectId), [tx.pure.u64(500_000_000)]);

  tx.moveCall({
    target: `${PACKAGE}::seal_api_pool::deposit`,
    arguments: [
      tx.object(POOL),
      paymentCoin,
      tx.object('0x6'),
    ],
  });

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true },
  });

  console.log('Deposit digest:', result.digest);
  console.log('Status:', result.effects?.status?.status);
}

main().catch(console.error);
