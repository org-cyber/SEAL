import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import dotenv from 'dotenv';

dotenv.config();

const client = new SuiClient({ url: getFullnodeUrl('testnet') });
const keypair = Ed25519Keypair.fromSecretKey(process.env.GATEWAY_PRIVATE_KEY!);
const address = keypair.getPublicKey().toSuiAddress();

async function main() {
  const coins = await client.getCoins({ owner: address, coinType: '0x2::sui::SUI' });
  
  if (coins.data.length < 2) {
    console.log('Need at least 2 coins to merge');
    return;
  }

  const [primary, ...others] = coins.data;
  console.log('Primary coin:', primary.coinObjectId, 'Balance:', primary.balance);
  console.log('Merging', others.length, 'coins');

  const tx = new Transaction();
  
  // Merge all other coins into primary
  tx.mergeCoins(
    tx.object(primary.coinObjectId),
    others.map(c => tx.object(c.coinObjectId))
  );

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true },
  });

  console.log('Merge digest:', result.digest);
}

main().catch(console.error);
