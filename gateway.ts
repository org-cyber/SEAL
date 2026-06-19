import express from 'express';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { startIndexer, getEventsForWallet, getEventsByType, getAllEvents, getStats } from './indexer';
import { x402ProviderMiddleware } from './provider-adapter';

dotenv.config();

// ── CONFIGURATION ──────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const client = new SuiClient({ url: process.env.SUI_RPC || getFullnodeUrl('testnet') });

const PACKAGE = process.env.PACKAGE_ID!;
const POOL = process.env.POOL_ID!;
const GATEWAY_ADDR = process.env.GATEWAY_ADDRESS!;
const gatewayKeypair = Ed25519Keypair.fromSecretKey(process.env.GATEWAY_PRIVATE_KEY!);
const PORT = process.env.PORT || '3001';

// ── DATA DIRECTORY ────────────────────────────────────────────────────────
// All persistent state lives in ./data/ so it's inspectable and survives restart

const DATA_DIR = join(process.cwd(), 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const API_KEYS_FILE = join(DATA_DIR, 'api-keys.json');
const LEDGER_FILE = join(DATA_DIR, 'credit-ledger.json');
const PAUSED_FILE = join(DATA_DIR, 'paused-wallets.json');
const CONSUMED_DIGESTS_FILE = join(DATA_DIR, 'consumed-digests.json');

// ── PROVIDER CONFIGURATION ─────────────────────────────────────────────────
// Hardcoded rates. Restart gateway to update. Measured in MIST per 1K tokens.
// These are DEMO RATES — not real provider pricing. Adjust as needed.

interface ModelConfig {
  costPer1kTokens: number;  // in MIST
}

interface ProviderConfig {
  baseUrl: string;
  apiKeyEnvVar: string;
  models: Record<string, ModelConfig>;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvVar: 'GROQ_API_KEY',
    models: {
      'llama-3.1-8b-instant': { costPer1kTokens: 50_000 },      // ~$0.00015 per 1K
      'llama-3.3-70b-versatile': { costPer1kTokens: 200_000 },  // ~$0.0006 per 1K
      'mixtral-8x7b-32768': { costPer1kTokens: 120_000 },       // ~$0.00036 per 1K
    },
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    models: {
      'gpt-4o': { costPer1kTokens: 500_000 },
      'gpt-4o-mini': { costPer1kTokens: 50_000 },
      'gpt-3.5-turbo': { costPer1kTokens: 50_000 },
    },
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    models: {
      'claude-3-5-sonnet-20241022': { costPer1kTokens: 800_000 },
      'claude-3-haiku-20240307': { costPer1kTokens: 100_000 },
    },
  },
};

// Helper: find provider for a given model
function getProviderForModel(model: string): { provider: string; config: ProviderConfig; modelConfig: ModelConfig } | null {
  for (const [providerName, providerConfig] of Object.entries(PROVIDERS)) {
    if (providerConfig.models[model]) {
      return { provider: providerName, config: providerConfig, modelConfig: providerConfig.models[model] };
    }
  }
  return null;
}

// Helper: calculate cost in MIST from token count
function calculateCost(model: string, tokenCount: number): bigint {
  const info = getProviderForModel(model);
  if (!info) return 0n;
  const cost = Math.ceil((tokenCount / 1000) * info.modelConfig.costPer1kTokens);
  return BigInt(cost);
}

// ── PERSISTENCE HELPERS ────────────────────────────────────────────────────

function loadJson<T>(path: string, defaultValue: T): T {
  if (!existsSync(path)) return defaultValue;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return defaultValue;
  }
}

function saveJson<T>(path: string, data: T) {
  writeFileSync(path, JSON.stringify(data, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value, 2));
}

// ── API KEY STORE ──────────────────────────────────────────────────────────

interface ApiKeyRecord {
  wallet: string;
  label: string;
  createdAt: number;
  revoked: boolean;
  allowApiKeyResume: boolean;  // If true, API key can resume a paused wallet
}

const apiKeys = new Map<string, ApiKeyRecord>(
  Object.entries(loadJson<Record<string, ApiKeyRecord>>(API_KEYS_FILE, {}))
);

function persistApiKeys() {
  saveJson(API_KEYS_FILE, Object.fromEntries(apiKeys));
}

function generateApiKey(): string {
  const random = crypto.randomBytes(24).toString('base64url');
  return `seal_${random}`;
}

// ── CREDIT LEDGER ─────────────────────────────────────────────────────────
// Tracks off-chain credits per wallet. Settled to chain every 5 minutes.

interface LedgerEntry {
  reserved: bigint;
  spent: bigint;
  lastSettlement: number;
  settlementFailures: number;  // NEW: track consecutive failures
}

const creditLedger = new Map<string, LedgerEntry>(
  Object.entries(loadJson<Record<string, LedgerEntry>>(LEDGER_FILE, {})).map(([k, v]) => [
    k,
    { ...v, reserved: BigInt(v.reserved || 0), spent: BigInt(v.spent || 0) }
  ])
);

function persistLedger() {
  saveJson(LEDGER_FILE, Object.fromEntries(creditLedger));
}

function getOrCreateLedger(wallet: string): LedgerEntry {
  if (!creditLedger.has(wallet)) {
    creditLedger.set(wallet, { reserved: 0n, spent: 0n, lastSettlement: Date.now(), settlementFailures: 0 });
    persistLedger();
  }
  return creditLedger.get(wallet)!;
}

// ── SOFT PAUSE STATE ──────────────────────────────────────────────────────

interface PauseRecord {
  pausedAt: number;
  reason: string;
  auto: boolean;  // true = triggered by velocity, false = manual
}

const pausedWallets = new Map<string, PauseRecord>(
  Object.entries(loadJson<Record<string, PauseRecord>>(PAUSED_FILE, {}))
);

function persistPaused() {
  saveJson(PAUSED_FILE, Object.fromEntries(pausedWallets));
}

// ── VELOCITY TRACKER ────────────────────────────────────────────────────────
// Sliding window: tracks request timestamps per wallet. Triggers soft pause
// if requests exceed threshold within window.

const VELOCITY_WINDOW_MS = 60_000;    // 1 minute window
const VELOCITY_THRESHOLD = 8;        // 10 requests per minute = spike
const VELOCITY_BURST_LIMIT = 5;       // 5 requests within 5 seconds = immediate pause

interface VelocityWindow {
  requests: number[];  // timestamps
}

const velocityWindows = new Map<string, VelocityWindow>();

function checkVelocity(wallet: string): { triggered: boolean; rate: number; reason: string } {
  const now = Date.now();
  let window = velocityWindows.get(wallet);
  if (!window) {
    window = { requests: [] };
    velocityWindows.set(wallet, window);
  }

  // Remove old requests outside window
  window.requests = window.requests.filter(t => now - t < VELOCITY_WINDOW_MS);
  window.requests.push(now);

  // Check burst: last 5 requests within 5 seconds
  const recent = window.requests.filter(t => now - t < 5_000);
  if (recent.length >= VELOCITY_BURST_LIMIT) {
    return { triggered: true, rate: recent.length, reason: `Burst detected: ${recent.length} requests in 5 seconds` };
  }

  // Check rate
  const rate = window.requests.length;
  if (rate > VELOCITY_THRESHOLD) {
    return { triggered: true, rate, reason: `Velocity spike: ${rate} requests in 1 minute (threshold: ${VELOCITY_THRESHOLD})` };
  }

  return { triggered: false, rate, reason: '' };
}

// ── CONSUMED DIGESTS (x402 replay protection) ──────────────────────────────

const consumedDigests = new Set<string>(
  loadJson<string[]>(CONSUMED_DIGESTS_FILE, [])
);

function persistConsumedDigests() {
  saveJson(CONSUMED_DIGESTS_FILE, Array.from(consumedDigests));
}

// ── RATE LIMITING ──────────────────────────────────────────────────────────
// Simple in-memory rate limiting. Per-IP and per-wallet.

interface RateLimitEntry {
  requests: number[];
}

const ipLimits = new Map<string, RateLimitEntry>();
const walletLimits = new Map<string, RateLimitEntry>();

const IP_LIMIT = 100;       // requests per minute per IP
const WALLET_LIMIT = 10;    // requests per minute per wallet (for /v1/chat)

function checkRateLimit(map: Map<string, RateLimitEntry>, key: string, limit: number, windowMs: number = 60_000): boolean {
  const now = Date.now();
  let entry = map.get(key);
  if (!entry) {
    entry = { requests: [] };
    map.set(key, entry);
  }
  entry.requests = entry.requests.filter(t => now - t < windowMs);
  if (entry.requests.length >= limit) return false;
  entry.requests.push(now);
  return true;
}

// ── PROVIDER CALLERS ───────────────────────────────────────────────────────

async function callGroq(
  model: string,
  messages: any[],
  temperature: number,
  max_tokens: number
): Promise<{ model?: string; content?: string; usage?: { total_tokens: number; prompt_tokens: number; completion_tokens: number }; error?: string }> {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return { error: 'GROQ_API_KEY not configured' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      return { error: `Groq HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    return {
      model: data.model,
      content: data.choices?.[0]?.message?.content,
      usage: data.usage,
    };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { error: 'Groq request timed out after 30s' };
    }
    return { error: err.message };
  }
}

async function callOpenAIStub(): Promise<{ error: string }> {
  return { error: 'OpenAI provider not configured. Add OPENAI_API_KEY to enable.' };
}

async function callAnthropicStub(): Promise<{ error: string }> {
  return { error: 'Anthropic provider not configured. Add ANTHROPIC_API_KEY to enable.' };
}

// ── X402 CONFIG ───────────────────────────────────────────────────────────

const x402Config = {
  poolId: POOL,
  packageId: PACKAGE,
  gatewayUrl: `http://localhost:${PORT}`,
  minCost: BigInt(1_000_000),
  network: 'sui:testnet',
};

// ── ENDPOINTS ──────────────────────────────────────────────────────────────

// Health check
app.get('/health', async (_req, res) => {
  res.json({
    status: 'ok',
    pool: POOL,
    gateway: GATEWAY_ADDR,
    providers: Object.fromEntries(
      Object.entries(PROVIDERS).map(([name, config]) => [
        name,
        {
          configured: !!process.env[config.apiKeyEnvVar],
          models: Object.keys(config.models),
        },
      ])
    ),
  });
});

// Get provider list and cost rates (for dashboard)
app.get('/providers', async (_req, res) => {
  res.json({
    providers: Object.fromEntries(
      Object.entries(PROVIDERS).map(([name, config]) => [
        name,
        {
          configured: !!process.env[config.apiKeyEnvVar],
          models: Object.fromEntries(
            Object.entries(config.models).map(([model, modelConfig]) => [
              model,
              { costPer1kTokens: modelConfig.costPer1kTokens },
            ])
          ),
        },
      ])
    ),
  });
});

// Check wallet balance (gasless view call)
app.get('/balance/:wallet', async (req, res) => {
  const wallet = req.params.wallet;

  // Rate limit by wallet
  if (!checkRateLimit(walletLimits, wallet, 60)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 60 balance checks per minute.' });
  }

  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE}::seal_api_pool::get_balance`,
      arguments: [tx.object(POOL), tx.pure.address(wallet)],
    });

    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: GATEWAY_ADDR,
    });

    const returnValues = result.results?.[0]?.returnValues;
    if (!returnValues || !returnValues[0]) {
      return res.json({ wallet, balance: '0' });
    }

    const bytes = new Uint8Array(returnValues[0][0]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const balance = view.getBigUint64(0, true);

    return res.json({ wallet, balance: balance.toString() });
  } catch (err) {
    console.error('Balance error:', err);
    return res.status(500).json({ wallet, balance: '0', error: 'Failed to fetch balance' });
  }
});

// Get wallet status: balance, pause state, velocity, ledger
app.get('/status/:wallet', async (req, res) => {
  const wallet = req.params.wallet;

  try {
    // On-chain balance
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE}::seal_api_pool::get_balance`,
      arguments: [tx.object(POOL), tx.pure.address(wallet)],
    });

    const balanceResult = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: GATEWAY_ADDR,
    });

    let balance = 0n;
    const returnValues = balanceResult.results?.[0]?.returnValues;
    if (returnValues && returnValues[0]) {
      const bytes = new Uint8Array(returnValues[0][0]);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      balance = view.getBigUint64(0, true);
    }

    // Spend status
const tx2 = new Transaction();
tx2.moveCall({
  target: `${PACKAGE}::seal_api_pool::get_spend_status`,
  arguments: [tx2.object(POOL), tx2.pure.address(wallet)],
});

    const spendResult = await client.devInspectTransactionBlock({
      transactionBlock: tx2,
      sender: GATEWAY_ADDR,
    });

    let dailyCap = 0n, dailySpent = 0n, monthlyCap = 0n, monthlySpent = 0n;
    const spendValues = spendResult.results?.[0]?.returnValues;
    if (spendValues && spendValues.length >= 4) {
      const parseU64 = (val: any): bigint => {
        const bytes = new Uint8Array(val[0]);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return view.getBigUint64(0, true);
      };
      dailyCap = parseU64(spendValues[0]);
      dailySpent = parseU64(spendValues[1]);
      monthlyCap = parseU64(spendValues[2]);
      monthlySpent = parseU64(spendValues[3]);
    }

    // Check pause state
  const tx3 = new Transaction();
tx3.moveCall({
  target: `${PACKAGE}::seal_api_pool::is_wallet_paused`,
  arguments: [tx3.object(POOL), tx3.pure.address(wallet)],
});

    const pauseResult = await client.devInspectTransactionBlock({
      transactionBlock: tx3,
      sender: GATEWAY_ADDR,
    });

    let onChainPaused = false;
    const pauseValues = pauseResult.results?.[0]?.returnValues;
    if (pauseValues && pauseValues[0]) {
      onChainPaused = new Uint8Array(pauseValues[0][0])[0] !== 0;
    }

    const ledger = getOrCreateLedger(wallet);
    const pauseRecord = pausedWallets.get(wallet);
    const velocityWindow = velocityWindows.get(wallet);

    res.json({
      wallet,
      balance: balance.toString(),
      caps: {
        daily: dailyCap.toString(),
        monthly: monthlyCap.toString(),
      },
      spent: {
        daily: dailySpent.toString(),
        monthly: monthlySpent.toString(),
        pending: ledger.spent.toString(),
        reserved: ledger.reserved.toString(),
      },
      pause: {
        onChain: onChainPaused,
        soft: pauseRecord ? { pausedAt: pauseRecord.pausedAt, reason: pauseRecord.reason, auto: pauseRecord.auto } : null,
      },
      velocity: {
        currentRate: velocityWindow?.requests.length || 0,
        windowMs: VELOCITY_WINDOW_MS,
        threshold: VELOCITY_THRESHOLD,
      },
    });
  } catch (err: any) {
    console.error('Status error:', err);
    res.status(500).json({ error: 'Failed to fetch status', message: err.message });
  }
});

// ── API KEY MANAGEMENT ────────────────────────────────────────────────────

app.post('/keys/create', async (req, res) => {
  const { wallet, label, allowApiKeyResume = false } = req.body;
  if (!wallet) {
    return res.status(400).json({ error: 'wallet required' });
  }

  const key = generateApiKey();
  apiKeys.set(key, {
    wallet,
    label: label || 'default',
    createdAt: Date.now(),
    revoked: false,
    allowApiKeyResume: !!allowApiKeyResume,
  });

  getOrCreateLedger(wallet);
  persistApiKeys();

  res.json({
    status: 'success',
    key,
    wallet,
    label: label || 'default',
    allowApiKeyResume: !!allowApiKeyResume,
  });
});

app.get('/keys/:wallet', async (req, res) => {
  const wallet = req.params.wallet;
  const keys = Array.from(apiKeys.entries())
    .filter(([_, v]) => v.wallet === wallet)
    .map(([k, v]) => ({
      key: k,
      label: v.label,
      createdAt: v.createdAt,
      revoked: v.revoked,
      allowApiKeyResume: v.allowApiKeyResume,
    }));

  res.json({ wallet, keys });
});

app.post('/keys/revoke', async (req, res) => {
  const { key } = req.body;
  const record = apiKeys.get(key);
  if (!record) {
    return res.status(404).json({ error: 'Key not found' });
  }
  record.revoked = true;
  persistApiKeys();
  res.json({ status: 'success', message: 'Key revoked' });
});

// ── PROTECTED API ROUTE (API KEY MODE) ────────────────────────────────────

app.post('/v1/chat', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

  // IP rate limit
  if (!checkRateLimit(ipLimits, clientIp, IP_LIMIT)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 100 requests per minute.' });
  }

  const authHeader = req.headers['authorization'] as string;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing API key. Use: Authorization: Bearer seal_...' });
  }

  const apiKey = authHeader.slice(7);
  const keyRecord = apiKeys.get(apiKey);

  if (!keyRecord || keyRecord.revoked) {
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }

  const wallet = keyRecord.wallet;

// ── CHECK SOFT PAUSE (before rate limit so paused wallets get clear error) ──
const pauseRecord = pausedWallets.get(wallet);
if (pauseRecord) {
  return res.status(403).json({
    error: 'Wallet paused',
    reason: pauseRecord.reason,
    pausedAt: pauseRecord.pausedAt,
    auto: pauseRecord.auto,
    message: 'This wallet has been paused due to unusual activity. Connect your wallet to the dashboard to resume.',
  });
}

// Wallet rate limit
if (!checkRateLimit(walletLimits, wallet, WALLET_LIMIT)) {
  return res.status(429).json({ error: 'Rate limit exceeded. Max 10 requests per minute per wallet.' });
}

  const { model, messages, temperature = 0.7, max_tokens = 256 } = req.body;

  if (!model || !messages) {
    return res.status(400).json({ error: 'model and messages required' });
  }

  // ── CHECK PROVIDER AVAILABILITY ────────────────────────────────────────
  const providerInfo = getProviderForModel(model);
  if (!providerInfo) {
    return res.status(400).json({ error: `Unsupported model: ${model}. Use /providers to see available models.` });
  }

  if (!process.env[providerInfo.config.apiKeyEnvVar]) {
    return res.status(503).json({
      error: `Provider ${providerInfo.provider} not configured`,
      message: `Set ${providerInfo.config.apiKeyEnvVar} environment variable to enable.`,
    });
  }

  // ── ESTIMATE COST ─────────────────────────────────────────────────────
  // Use max_tokens as upper bound for reservation
  const estimatedTokens = max_tokens;
  const estimatedCost = calculateCost(model, estimatedTokens);

  if (estimatedCost === 0n) {
    return res.status(500).json({ error: 'Failed to calculate cost for model' });
  }

  // ── CHECK ON-CHAIN BALANCE ────────────────────────────────────────────
  let onChainBalance: bigint;
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE}::seal_api_pool::get_balance`,
      arguments: [tx.object(POOL), tx.pure.address(wallet)],
    });

    const balanceResult = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: GATEWAY_ADDR,
    });

    const returnValues = balanceResult.results?.[0]?.returnValues;
    if (!returnValues || !returnValues[0]) {
      return res.status(402).json({ error: 'Could not verify balance' });
    }

    const bytes = new Uint8Array(returnValues[0][0]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    onChainBalance = view.getBigUint64(0, true);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to verify on-chain balance' });
  }

  // ── CHECK OFF-CHAIN LEDGER ────────────────────────────────────────────
  const ledger = getOrCreateLedger(wallet);
  const available = onChainBalance - ledger.reserved - ledger.spent;

  if (available < estimatedCost) {
    return res.status(402).json({
      error: 'Insufficient balance',
      balance: onChainBalance.toString(),
      reserved: ledger.reserved.toString(),
      spent: ledger.spent.toString(),
      required: estimatedCost.toString(),
    });
  }

  // ── RESERVE CREDITS ───────────────────────────────────────────────────
  ledger.reserved += estimatedCost;
  persistLedger();

  // ── CALL PROVIDER ─────────────────────────────────────────────────────
  let providerResponse;
  try {
    if (providerInfo.provider === 'groq') {
      providerResponse = await callGroq(model, messages, temperature, max_tokens);
    } else if (providerInfo.provider === 'openai') {
      providerResponse = await callOpenAIStub();
    } else if (providerInfo.provider === 'anthropic') {
      providerResponse = await callAnthropicStub();
    } else {
      ledger.reserved -= estimatedCost;
      persistLedger();
      return res.status(500).json({ error: 'Provider implementation missing' });
    }
  } catch (err: any) {
    ledger.reserved -= estimatedCost;
    persistLedger();
    return res.status(502).json({ error: 'Provider call failed', details: err.message });
  }

  if (providerResponse.error) {
    ledger.reserved -= estimatedCost;
    persistLedger();
    return res.status(502).json({ error: 'Provider error', details: providerResponse.error });
  }

  // ── CALCULATE ACTUAL COST ────────────────────────────────────────────
  const actualTokens = providerResponse.usage?.total_tokens || estimatedTokens;
  const actualCost = calculateCost(model, actualTokens);

  // ── DEDUCT FROM LEDGER ───────────────────────────────────────────────
  ledger.reserved -= estimatedCost;
  ledger.spent += actualCost;
  persistLedger();

  // ── VELOCITY CHECK ────────────────────────────────────────────────────
  const velocityCheck = checkVelocity(wallet);
  if (velocityCheck.triggered) {
    // Auto-pause
 pausedWallets.set(wallet, {
  pausedAt: Date.now(),
  reason: velocityCheck.reason,
  auto: true,
});
persistPaused();
walletLimits.delete(wallet);

    console.log(`[AUTO-PAUSE] Wallet ${wallet}: ${velocityCheck.reason}`);
  }

  // ── RETURN RESPONSE ───────────────────────────────────────────────────
  res.json({
    status: 'success',
    model: providerResponse.model,
    content: providerResponse.content,
    usage: providerResponse.usage,
    cost: {
      estimated: estimatedCost.toString(),
      actual: actualCost.toString(),
      currency: 'MIST',
    },
    settlement: {
      pending: ledger.spent.toString(),
      lastSettled: ledger.lastSettlement,
    },
    velocity: {
      rate: velocityCheck.rate,
      threshold: VELOCITY_THRESHOLD,
      windowMs: VELOCITY_WINDOW_MS,
    },
  });
});

// ── RESUME ENDPOINTS ──────────────────────────────────────────────────────

// Resume via API key (if allowApiKeyResume is true)
app.post('/resume', async (req, res) => {
  const authHeader = req.headers['authorization'] as string;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing API key' });
  }

  const apiKey = authHeader.slice(7);
  const keyRecord = apiKeys.get(apiKey);

  if (!keyRecord || keyRecord.revoked) {
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }

  if (!keyRecord.allowApiKeyResume) {
    return res.status(403).json({
      error: 'API key not authorized to resume',
      message: 'This key was created without resume permission. Use the dashboard to resume.',
    });
  }

  const wallet = keyRecord.wallet;
  const pauseRecord = pausedWallets.get(wallet);
  if (!pauseRecord) {
    return res.json({ status: 'already_resumed', wallet });
  }

  pausedWallets.delete(wallet);
  persistPaused();

  res.json({
    status: 'success',
    wallet,
    previousPause: pauseRecord,
  });
});

// Resume via wallet signature (most secure)
// This is a stub — the actual implementation would verify a signature
// For now, we accept a wallet address and trust the caller (dashboard uses dapp-kit)
app.post('/resume/:wallet', async (req, res) => {
  const wallet = req.params.wallet;
  const pauseRecord = pausedWallets.get(wallet);

  if (!pauseRecord) {
    return res.json({ status: 'already_resumed', wallet });
  }

  pausedWallets.delete(wallet);
  persistPaused();

  res.json({
    status: 'success',
    wallet,
    previousPause: pauseRecord,
  });
});

// ── ON-CHAIN SETTLEMENT ───────────────────────────────────────────────────

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

    const receiptEvent = result.events?.find(e => e.type.includes('ApiCallReceiptEvent'));

    res.json({
      status: 'success',
      digest: result.digest,
      receipt: receiptEvent?.parsedJson || null,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── X402 PROTECTED ROUTE (SECONDARY FLOW) ────────────────────────────────

app.post('/api/:provider', x402ProviderMiddleware(x402Config), async (req, res) => {
  const { provider } = req.params;
  const apiResponse = await proxyToProvider(provider, req.body);
  res.json(apiResponse);
});

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
        stop: ['</s>', 'User:', 'Human:'],
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

// ── BATCH SETTLEMENT ───────────────────────────────────────────────────────
// Every 5 minutes, settle accumulated spend on-chain.
// If settlement fails 3 times consecutively, stop retrying and alert.

const SETTLEMENT_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_SETTLEMENT_FAILURES = 3;

async function runBatchSettlement() {
  console.log('[SETTLEMENT] Running batch settlement...');

  for (const [wallet, ledger] of creditLedger.entries()) {
    if (ledger.spent === 0n) continue;
    if (ledger.settlementFailures >= MAX_SETTLEMENT_FAILURES) {
      console.warn(`[SETTLEMENT] Skipping ${wallet}: ${ledger.settlementFailures} consecutive failures. Manual intervention required.`);
      continue;
    }

    const amount = ledger.spent;
    console.log(`[SETTLEMENT] Settling ${amount} MIST for ${wallet}`);

    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE}::seal_api_pool::authorize_call`,
        arguments: [
          tx.object(POOL),
          tx.pure.address(wallet),
          tx.pure.u64(amount),
          tx.pure.vector('u8', Array.from(Buffer.from('batch'))),
          tx.pure.address(GATEWAY_ADDR),
          tx.pure.vector('u8', Array.from(Buffer.from('batch_settlement'))),
          tx.pure.vector('u8', Array.from(Buffer.from('batch'))),
          tx.pure.u64(0),
          tx.object('0x6'),
        ],
      });

      const result = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: gatewayKeypair,
        options: { showEffects: true, showEvents: true },
      });

      if (result.effects?.status?.status === 'success') {
        ledger.spent = 0n;
        ledger.settlementFailures = 0;
        ledger.lastSettlement = Date.now();
        persistLedger();
        console.log(`[SETTLEMENT] Success: ${result.digest}`);
      } else {
        ledger.settlementFailures++;
        persistLedger();
        console.error(`[SETTLEMENT] Failed for ${wallet}:`, result.effects?.status);
      }
    } catch (err: any) {
      ledger.settlementFailures++;
      persistLedger();
      console.error(`[SETTLEMENT] Error for ${wallet}:`, err.message);
    }
  }
}

setInterval(runBatchSettlement, SETTLEMENT_INTERVAL);

// ── EVENT INDEXER ENDPOINTS ────────────────────────────────────────────────

startIndexer();

app.get('/events', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  res.json({
    events: getAllEvents(limit),
    stats: getStats(),
  });
});

app.get('/events/:wallet', async (req, res) => {
  const wallet = req.params.wallet;
  const events = getEventsForWallet(wallet);
  res.json({ wallet, count: events.length, events });
});

app.get('/events/type/:eventType', async (req, res) => {
  const eventType = req.params.eventType;
  const fullType = `${PACKAGE}::seal_api_pool::${eventType}`;
  const events = getEventsByType(fullType);
  res.json({ type: eventType, count: events.length, events });
});

app.get('/indexer/stats', async (_req, res) => {
  res.json(getStats());
});

// ── START SERVER ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`SEAL Gateway v0.2.0 running on http://localhost:${PORT}`);
  console.log(`Pool: ${POOL}`);
  console.log(`Gateway: ${GATEWAY_ADDR}`);
  console.log(`Providers: ${Object.keys(PROVIDERS).join(', ')}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
