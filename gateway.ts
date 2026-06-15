import express from 'express';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import dotenv from 'dotenv';
import { quickSetup } from './ptb-setup';
import { x402ProviderMiddleware } from './provider-adapter';
import { startIndexer, getEventsForWallet, getEventsByType, getAllEvents, getStats } from './indexer';
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
  const prompt = body.prompt || 'Hello';

  try {
    const response = await fetch('http://localhost:8080/completion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: prompt,
        n_predict: 128,
        temperature: 0.7,
        stop: ["</s>", "User:", "Human:"],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`llama.cpp error: ${response.status}`);
    }

    const data = await response.json();

    return {
      status: 'success',
      provider,
      seal: { settled: true },
      ai: {
        model: 'qwen2.5-coder-1.5b-instruct-q4_0',
        content: data.content?.trim() || 'No response',
        tokens_used: data.tokens_evaluated || 0,
      },
      timestamp: Date.now(),
    };

  } catch (err: any) {
    return {
      status: 'error',
      provider,
      message: 'llama.cpp server not running on port 8080',
      error: err.message,
      timestamp: Date.now(),
    };
  }
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


// ── TEAM TREASURY ENDPOINTS ─────────────────────────────────────────────────

// Create a team treasury
app.post('/team/create', async (req, res) => {
  const { payment_amount, team_daily_cap, team_monthly_cap } = req.body;

  if (!payment_amount || payment_amount <= 0) {
    return res.status(400).json({ error: 'payment_amount required' });
  }

  const sender = req.body.sender || GATEWAY_ADDR; // TODO: get from auth/session

  try {
    // Get a coin to use for deposit
    const coins = await client.getCoins({ owner: sender, coinType: '0x2::sui::SUI' });
    if (coins.data.length === 0) {
      return res.status(400).json({ error: 'No SUI coins available' });
    }

    const tx = new Transaction();
    const [paymentCoin] = tx.splitCoins(
      tx.object(coins.data[0].coinObjectId),
      [tx.pure.u64(BigInt(payment_amount))]
    );

    tx.moveCall({
      target: `${PACKAGE}::seal_api_pool::create_team`,
      arguments: [
        tx.object(POOL),
        paymentCoin,
        tx.pure.u64(BigInt(team_daily_cap || 0)),
        tx.pure.u64(BigInt(team_monthly_cap || 0)),
        tx.object('0x6'),
      ],
    });

    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: gatewayKeypair, // In production: use user's signer
      options: { showEffects: true, showEvents: true },
    });

    const teamEvent = result.events?.find(e => e.type.includes('TeamCreatedEvent'));

    res.json({
      status: 'success',
      digest: result.digest,
      team_id: sender, // team_id = admin address
      event: teamEvent?.parsedJson || null,
    });

  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Add member to team
app.post('/team/add-member', async (req, res) => {
  const { team_id, member, member_daily_cap } = req.body;

  if (!team_id || !member) {
    return res.status(400).json({ error: 'team_id and member required' });
  }

  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE}::seal_api_pool::add_team_member`,
      arguments: [
        tx.object(POOL),
        tx.pure.address(team_id),
        tx.pure.address(member),
        tx.pure.u64(BigInt(member_daily_cap || 0)),
        tx.object('0x6'),
      ],
    });

    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: gatewayKeypair, // In production: team admin's signer
      options: { showEffects: true, showEvents: true },
    });

    const memberEvent = result.events?.find(e => e.type.includes('TeamMemberAddedEvent'));

    res.json({
      status: 'success',
      digest: result.digest,
      event: memberEvent?.parsedJson || null,
    });

  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Team API call settlement (x402 flow)
app.post('/team/settle', async (req, res) => {
  const {
    team_id,
    member,
    total_cost,
    provider_name,
    provider_addr,
    model_name,
    tokens_used,
    request_hash,
  } = req.body;

  if (!team_id || !member || !total_cost || !provider_name || !provider_addr) {
    return res.status(400).json({ error: 'Missing required fields: team_id, member, total_cost, provider_name, provider_addr' });
  }

  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE}::seal_api_pool::authorize_team_call`,
    arguments: [
      tx.object(POOL),
      tx.pure.address(team_id),
      tx.pure.address(member),
      tx.pure.u64(BigInt(total_cost)),
      tx.pure.vector('u8', Array.from(Buffer.from(provider_name))),
      tx.pure.address(provider_addr),
      tx.pure.vector('u8', Array.from(Buffer.from(request_hash || 'default'))),
      tx.pure.vector('u8', Array.from(Buffer.from(model_name || 'unknown'))),
      tx.pure.u64(BigInt(tokens_used || 0)),
      tx.object('0x6'),
    ],
  });

  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: gatewayKeypair,
      options: { showEffects: true, showEvents: true },
    });

    const teamReceipt = result.events?.find(e => e.type.includes('TeamCallReceiptEvent'));
    const apiReceipt = result.events?.find(e => e.type.includes('ApiCallReceiptEvent'));

    res.json({
      status: 'success',
      digest: result.digest,
      team_receipt: teamReceipt?.parsedJson || null,
      api_receipt: apiReceipt?.parsedJson || null,
    });

  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ── EVENT INDEXER ENDPOINTS ───────────────────────────────────────────────

// Start background polling
startIndexer();

// Get all events (paginated)
app.get('/events', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  res.json({
    events: getAllEvents(limit),
    stats: getStats(),
  });
});

// Get events for a specific wallet/address
app.get('/events/:wallet', async (req, res) => {
  const wallet = req.params.wallet;
  const events = getEventsForWallet(wallet);
  res.json({
    wallet,
    count: events.length,
    events,
  });
});

// Get events by type
app.get('/events/type/:eventType', async (req, res) => {
  const eventType = req.params.eventType;
  const fullType = `${PACKAGE}::seal_api_pool::${eventType}`;
  const events = getEventsByType(fullType);
  res.json({
    type: eventType,
    count: events.length,
    events,
  });
});

// Get indexer stats
app.get('/indexer/stats', async (_req, res) => {
  res.json(getStats());
});


// ── PTB QUICK SETUP ENDPOINT ────────────────────────────────────────────────

app.post('/quick-setup', async (req, res) => {
  const {
    coinObjectId,
    depositAmount,
    dailyCap,
    monthlyCap,
    claudeCap,
    openaiCap,
    lowBalanceThreshold,
  } = req.body;

  if (!coinObjectId) {
    return res.status(400).json({ error: 'coinObjectId required' });
  }

  try {
    // In production: use user's signer from session/auth
    // For hackathon: use gateway keypair (user must trust gateway)
    const digest = await quickSetup({
      signer: gatewayKeypair,
      coinObjectId,
      depositAmount: BigInt(depositAmount || 100_000_000),
      dailyCap: BigInt(dailyCap || 5_000_000),
      monthlyCap: BigInt(monthlyCap || 50_000_000),
      claudeCap: BigInt(claudeCap || 2_000_000),
      openaiCap: BigInt(openaiCap || 1_000_000),
      lowBalanceThreshold: BigInt(lowBalanceThreshold || 500_000),
    });

    res.json({
      status: 'success',
      digest,
      message: 'PTB executed: deposit + spend caps + provider caps + alert threshold',
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
