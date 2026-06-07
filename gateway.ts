import express from 'express';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const client = new SuiClient({ url: process.env.SUI_RPC || getFullnodeUrl('testnet') });

const PACKAGE = process.env.PACKAGE_ID!;
const POOL = process.env.POOL_ID!;
const GATEWAY_ADDR = process.env.GATEWAY_ADDRESS!;
const gatewayKeypair = Ed25519Keypair.fromSecretKey(process.env.GATEWAY_PRIVATE_KEY!);

// Health check
app.get('/health', async (_req, res) => {
  res.json({ status: 'ok', pool: POOL, gateway: GATEWAY_ADDR });
});

// Check wallet balance (no gas needed)
app.get('/balance/:wallet', async (req, res) => {
  const wallet = req.params.wallet;
  
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE}::seal_api_pool::get_balance`,
    arguments: [tx.object(POOL), tx.pure.address(wallet)],
  });

  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: GATEWAY_ADDR,
  });

  // Parse the return value
  const returnVal = result.results?.[0]?.returnValues?.[0];
  let balance = 0;
  if (returnVal) {
    const bytes = returnVal[0] as number[];
    balance = parseInt(Buffer.from(bytes).toString('hex'), 16);
  }

  res.json({ wallet, balance });
});

// Settle payment on-chain (this costs gas)
app.post('/settle', async (req, res) => {
  const { wallet, total_cost, provider_name, provider_addr, model_name, tokens_used, request_hash } = req.body;

  if (!wallet || !total_cost || !provider_name || !provider_addr) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE}::seal_api_pool::authorize_call`,
    arguments: [
      tx.object(POOL),                                    // pool
      tx.pure.address(wallet),                            // wallet paying
      tx.pure.u64(total_cost),                            // amount to deduct
      tx.pure.vector('u8', Array.from(Buffer.from(provider_name))),  // provider name as bytes
      tx.pure.address(provider_addr),                     // provider wallet to receive 99%
      tx.pure.vector('u8', Array.from(Buffer.from(request_hash || 'default'))), // request hash
      tx.pure.vector('u8', Array.from(Buffer.from(model_name || 'unknown'))),   // model name
      tx.pure.u64(tokens_used || 0),                      // token count
      tx.object('0x6'),                                   // clock
    ],
  });

  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: gatewayKeypair,
      options: { showEffects: true, showEvents: true },
    });

    // Find the receipt event
    const receiptEvent = result.events?.find(e => 
      e.type.includes('ApiCallReceiptEvent')
    );

    res.json({
      status: 'success',
      digest: result.digest,
      receipt: receiptEvent?.parsedJson || null,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`SEAL Gateway running on http://localhost:${process.env.PORT}`);
  console.log(`Pool: ${POOL}`);
  console.log(`Gateway: ${GATEWAY_ADDR}`);
});
