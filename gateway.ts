import express from 'express';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import dotenv from 'dotenv';
import { x402ProviderMiddleware } from './provider-adapter';

dotenv.config();

const app = express();
app.use(express.json());

const client = new SuiClient({ url: process.env.SUI_RPC || getFullnodeUrl('testnet') });

const PACKAGE = process.env.PACKAGE_ID!;
const POOL = process.env.POOL_ID!;
const GATEWAY_ADDR = process.env.GATEWAY_ADDRESS!;
const gatewayKeypair = Ed25519Keypair.fromSecretKey(process.env.GATEWAY_PRIVATE_KEY!);
const PORT = process.env.PORT || '3000';

const x402Config = {
  poolId: POOL,
  packageId: PACKAGE,
  gatewayUrl: `http://localhost:${PORT}`,
  minCost: BigInt(1_000_000),
  network: 'sui:testnet',
};

async function proxyToProvider(provider: string, body: any): Promise<any> {
  return {
    status: 'proxied',
    provider,
    received: body,
    message: 'This is a stub. Wire to real API here.',
    timestamp: Date.now(),
  };
}

// ── X402 PROTECTED ROUTE ──
app.post('/api/:provider', x402ProviderMiddleware(x402Config), async (req, res) => {
  const { provider } = req.params;
  const apiResponse = await proxyToProvider(provider, req.body);
  res.json(apiResponse);
});

// Health check
app.get('/health', async (_req, res) => {
  res.json({ status: 'ok', pool: POOL, gateway: GATEWAY_ADDR });
});

// Simple API proxy route (no x402 yet — for testing)
app.post('/api/:provider', async (req, res) => {
  const { provider } = req.params;
  const apiResponse = await proxyToProvider(provider, req.body);
  res.json(apiResponse);
});

// Check wallet balance (gasless view call)
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

  const returnVal = result.results?.[0]?.returnValues?.[0];
  let balance = 0;
  if (returnVal) {
    const bytes = returnVal[0] as number[];
    balance = parseInt(Buffer.from(bytes).toString('hex'), 16);
  }

  res.json({ wallet, balance });
});

// Settle payment on-chain
app.post('/settle', async (req, res) => {
  const { wallet, total_cost, provider_name, provider_addr, model_name, tokens_used, request_hash } = req.body;

  if (!wallet || !total_cost || !provider_name || !provider_addr) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE}::seal_api_pool::authorize_call`,
    arguments: [
      tx.object(POOL),
      tx.pure.address(wallet),
      tx.pure.u64(total_cost),
      tx.pure.vector('u8', Array.from(Buffer.from(provider_name))),
      tx.pure.address(provider_addr),
      tx.pure.vector('u8', Array.from(Buffer.from(request_hash || 'default'))),
      tx.pure.vector('u8', Array.from(Buffer.from(model_name || 'unknown'))),
      tx.pure.u64(tokens_used || 0),
      tx.object('0x6'),
    ],
  });

  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: gatewayKeypair,
      options: { showEffects: true, showEvents: true },
    });

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

app.listen(PORT, () => {
  console.log(`SEAL Gateway running on http://localhost:${PORT}`);
  console.log(`Pool: ${POOL}`);
  console.log(`Gateway: ${GATEWAY_ADDR}`);
});
