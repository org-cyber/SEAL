'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  ConnectButton,
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';

const GATEWAY_URL = 'http://localhost:3001';

const PACKAGE_ID =
  '0x6e1de9eee9168dbf4803abf85fa955c0047111c8572ff74a3e47d3983bd61fd4';

const POOL_ID =
  '0xed89af9714f4d509c3a3578d295cd3acd71b4a4ae51dc6afca2d295ac96c9809';

// ── TYPES ───────────────────────────────────────────────────────────────────

interface WalletStatus {
  wallet: string;
  balance: string;
  caps: { daily: string; monthly: string };
  spent: { daily: string; monthly: string; pending: string; reserved: string };
  pause: {
    onChain: boolean;
    soft: { pausedAt: number; reason: string; auto: boolean } | null;
  };
  velocity: { currentRate: number; windowMs: number; threshold: number };
}

interface ApiKey {
  key: string;
  label: string;
  createdAt: number;
  revoked: boolean;
  allowApiKeyResume: boolean;
}

interface ProviderInfo {
  configured: boolean;
  models: Record<string, { costPer1kTokens: number }>;
}

interface SuiEvent {
  id: { txDigest: string; eventSeq: number };
  type: string;
  parsedJson: any;
  timestampMs: number;
}

// ── UTILITY ─────────────────────────────────────────────────────────────────

function formatSui(mist: string): string {
  return (Number(mist) / 1e9).toFixed(6);
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

// ── COMPONENT ─────────────────────────────────────────────────────────────

export default function Home() {
  const account = useCurrentAccount();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();
  const wallet = account?.address;

  // ── STATE ────────────────────────────────────────────────────────────────

  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [events, setEvents] = useState<SuiEvent[]>([]);
  const [providers, setProviders] = useState<Record<string, ProviderInfo>>({});
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [allowKeyResume, setAllowKeyResume] = useState(false);
  const [keyLoading, setKeyLoading] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [depositLoading, setDepositLoading] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [apiLoading, setApiLoading] = useState(false);
  const [apiResponse, setApiResponse] = useState<any>(null);
  const [prompt, setPrompt] = useState('');
  const [selectedModel, setSelectedModel] = useState('llama-3.1-8b-instant');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── REFRESH FUNCTIONS ────────────────────────────────────────────────────
const refreshStatus = useCallback(async () => {
  if (!wallet) return;
  try {
    const res = await fetch(`${GATEWAY_URL}/status/${wallet}`);
    if (!res.ok) {
      console.error('Status fetch failed:', res.status);
      return; // don't overwrite good state with an error object
    }
    const data = await res.json();
    if (data.error) {
      console.error('Status error from gateway:', data.error);
      return; // same — bail out, keep previous status
    }
    setStatus(data);
  } catch (err: any) {
    console.error('Status fetch error:', err);
    setError('Failed to fetch wallet status: ' + err.message);
  }
}, [wallet]);

  const refreshEvents = useCallback(async () => {
    if (!wallet) return;
    try {
      const res = await fetch(`${GATEWAY_URL}/events/${wallet}`);
      const data = await res.json();
      setEvents(data.events || []);
    } catch (err) {
      console.error('Events fetch error:', err);
    }
  }, [wallet]);

  const refreshProviders = useCallback(async () => {
    try {
      const res = await fetch(`${GATEWAY_URL}/providers`);
      const data = await res.json();
      setProviders(data.providers || {});
    } catch (err) {
      console.error('Providers fetch error:', err);
    }
  }, []);

  const refreshApiKeys = useCallback(async () => {
    if (!wallet) return;
    try {
      const res = await fetch(`${GATEWAY_URL}/keys/${wallet}`);
      const data = await res.json();
      setApiKeys(data.keys || []);
    } catch (err) {
      console.error('API keys error:', err);
    }
  }, [wallet]);

  // ── POLLING ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!wallet) return;

    refreshStatus();
    refreshEvents();
    refreshProviders();
    refreshApiKeys();

    const interval = setInterval(() => {
      refreshStatus();
      refreshEvents();
    }, 10000); // Poll every 10 seconds

    return () => clearInterval(interval);
  }, [wallet, refreshStatus, refreshEvents, refreshProviders, refreshApiKeys]);

  // ── DEPOSIT PTB (Standalone) ───────────────────────────────────────────────
  // For users who already have a treasury and just want to add funds.

  const handleDeposit = async () => {
    if (!wallet) {
      setError('Connect wallet first');
      return;
    }

    setDepositLoading(true);
    setError(null);

    try {
      const tx = new Transaction();
      tx.setGasBudget(10_000_000);

      // Split 0.05 SUI from gas coin for deposit
      const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(50_000_000n)]);

      tx.moveCall({
        target: `${PACKAGE_ID}::seal_api_pool::deposit_with_source`,
        arguments: [
          tx.object(POOL_ID),
          paymentCoin,
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('manual'))),
          tx.object('0x6'),
        ],
      });

      signAndExecute(
        { transaction: tx },
        {
          onSuccess: async (result) => {
            setError(null);
            await new Promise((r) => setTimeout(r, 3000));
            await refreshStatus();
            await refreshEvents();
            setDepositLoading(false);
          },
          onError: (err) => {
            setError('Deposit failed: ' + err.message);
            setDepositLoading(false);
          },
        }
      );
    } catch (err: any) {
      setError('Error: ' + err.message);
      setDepositLoading(false);
    }
  };


  // ── SETUP TREASURY PTB ───────────────────────────────────────────────────
  // Single button: deposit + set caps + set provider caps + alert threshold

  const handleSetupTreasury = async () => {
    if (!wallet) {
      setError('Connect wallet first');
      return;
    }

    setSetupLoading(true);
    setError(null);

    try {
      const tx = new Transaction();
      tx.setGasBudget(10_000_000);

      // Split 0.05 SUI from gas coin for deposit
      const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(50_000_000n)]);

      // 1. Deposit with source = manual
      tx.moveCall({
        target: `${PACKAGE_ID}::seal_api_pool::deposit_with_source`,
        arguments: [
          tx.object(POOL_ID),
          paymentCoin,
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('manual'))),
          tx.object('0x6'),
        ],
      });

      // 2. Set global spend caps: 5M MIST daily, 50M MIST monthly
      tx.moveCall({
        target: `${PACKAGE_ID}::seal_api_pool::set_spend_caps`,
        arguments: [
          tx.object(POOL_ID),
          tx.pure.u64(5_000_000n),
          tx.pure.u64(50_000_000n),
          tx.object('0x6'),
        ],
      });

      // 3. Set Claude provider cap: 2M MIST daily
      tx.moveCall({
        target: `${PACKAGE_ID}::seal_api_pool::set_provider_cap`,
        arguments: [
          tx.object(POOL_ID),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('claude'))),
          tx.pure.u64(2_000_000n),
          tx.object('0x6'),
        ],
      });

      // 4. Set OpenAI provider cap: 1M MIST daily
      tx.moveCall({
        target: `${PACKAGE_ID}::seal_api_pool::set_provider_cap`,
        arguments: [
          tx.object(POOL_ID),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('openai'))),
          tx.pure.u64(1_000_000n),
          tx.object('0x6'),
        ],
      });

      // 5. Set Groq provider cap: 3M MIST daily
      tx.moveCall({
        target: `${PACKAGE_ID}::seal_api_pool::set_provider_cap`,
        arguments: [
          tx.object(POOL_ID),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('groq'))),
          tx.pure.u64(3_000_000n),
          tx.object('0x6'),
        ],
      });

      // 6. Set low balance alert threshold: 500K MIST
      tx.moveCall({
        target: `${PACKAGE_ID}::seal_api_pool::set_low_balance_threshold`,
        arguments: [
          tx.object(POOL_ID),
          tx.pure.u64(500_000n),
          tx.object('0x6'),
        ],
      });

      signAndExecute(
        { transaction: tx },
        {
          onSuccess: async (result) => {
            setError(null);
            await new Promise((r) => setTimeout(r, 3000));
            await refreshStatus();
            await refreshEvents();
            setSetupLoading(false);
          },
          onError: (err) => {
            setError('Transaction failed: ' + err.message);
            setSetupLoading(false);
          },
        }
      );
    } catch (err: any) {
      setError('Error: ' + err.message);
      setSetupLoading(false);
    }
  };

  // ── CREATE API KEY ─────────────────────────────────────────────────────

  const handleCreateKey = async () => {
    if (!wallet) return;
    setKeyLoading(true);
    setNewKey(null);

    try {
      const res = await fetch(`${GATEWAY_URL}/keys/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet,
          label: newKeyLabel || 'default',
          allowApiKeyResume: allowKeyResume,
        }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        setNewKey(data.key);
        setNewKeyLabel('');
        setAllowKeyResume(false);
        await refreshApiKeys();
      } else {
        setError('Failed to create key: ' + (data.error || 'Unknown error'));
      }
    } catch (err: any) {
      setError('Error: ' + err.message);
    } finally {
      setKeyLoading(false);
    }
  };

  // ── RESUME WALLET ──────────────────────────────────────────────────────

  const handleResume = async () => {
    if (!wallet) return;
    setResumeLoading(true);

    try {
      const res = await fetch(`${GATEWAY_URL}/resume/${wallet}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.status === 'success') {
        await refreshStatus();
      } else {
        setError('Resume failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err: any) {
      setError('Error: ' + err.message);
    } finally {
      setResumeLoading(false);
    }
  };

  // ── API CALL DEMO ───────────────────────────────────────────────────────

  const handleApiCall = async () => {
    if (!wallet || !prompt.trim()) return;
    setApiLoading(true);
    setApiResponse(null);
    setError(null);

    // Use the first active API key, or fallback to demo mode
    const activeKey = apiKeys.find(k => !k.revoked);
    if (!activeKey) {
      setError('No active API key. Create one first.');
      setApiLoading(false);
      return;
    }

    try {
      const res = await fetch(`${GATEWAY_URL}/v1/chat`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${activeKey.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [{ role: 'user', content: prompt.trim() }],
          temperature: 0.7,
          max_tokens: 256,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setApiResponse(data);
      } else {
        setApiResponse({
          error: data.error || 'Request failed',
          details: data.message || data.details || '',
        });
      }

      await new Promise((r) => setTimeout(r, 1000));
      await refreshStatus();
      await refreshEvents();
    } catch (err: any) {
      setApiResponse({ error: err.message });
    } finally {
      setApiLoading(false);
    }
  };

  // ── RENDER ───────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 40, background: '#0a0a0a', minHeight: '100vh', color: '#fff' }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 36, marginBottom: 4, fontWeight: 800 }}>
          SEAL
        </h1>
        <p style={{ color: '#888', fontSize: 14 }}>
          One API key. Multiple providers. On-chain caps.
        </p>
      </div>

      <div style={{ marginBottom: 32 }}>
        <ConnectButton />
      </div>

      {/* Error Banner */}
      {error && (
        <div style={{
          background: '#331111',
          border: '1px solid #ff4444',
          padding: 16,
          borderRadius: 8,
          marginBottom: 24,
          color: '#ff8888',
          fontSize: 14,
        }}>
          ⚠️ {error}
          <button
            onClick={() => setError(null)}
            style={{
              float: 'right',
              background: 'transparent',
              border: 'none',
              color: '#ff8888',
              cursor: 'pointer',
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {wallet && status && (
        <div>
          {/* ── ANOMALY ALERT BANNER ────────────────────────────────────── */}
         {status.pause?.soft && (
            <div style={{
              background: '#331111',
              border: '1px solid #ff4444',
              padding: 20,
              borderRadius: 12,
              marginBottom: 24,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <div style={{ color: '#ff4444', fontWeight: 'bold', fontSize: 18, marginBottom: 4 }}>
                    🚨 Treasury Paused
                  </div>
                  <div style={{ color: '#ff8888', fontSize: 13 }}>
                    {status.pause.soft.reason}
                  </div>
                  <div style={{ color: '#aa6666', fontSize: 12, marginTop: 4 }}>
                    Paused at: {formatDate(status.pause.soft.pausedAt)}
                  </div>
                </div>
                <button
                  onClick={handleResume}
                  disabled={resumeLoading}
                  style={{
                    padding: '12px 24px',
                    fontSize: 14,
                    fontWeight: 'bold',
                    background: resumeLoading ? '#333' : '#ff4444',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    cursor: resumeLoading ? 'not-allowed' : 'pointer',
                  }}
                >
                  {resumeLoading ? 'Resuming...' : '▶ Resume Treasury'}
                </button>
              </div>
            </div>
          )}

          {/* ── WALLET CARD ─────────────────────────────────────────────── */}
          <div style={{ background: '#111', padding: 24, borderRadius: 12, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 20, marginBottom: 8 }}>Wallet</h2>
                <p style={{ fontFamily: 'monospace', fontSize: 13, color: '#aaa' }}>
                  {wallet}
                </p>
              </div>
              {status.pause.onChain && (
                <span style={{
                  background: '#ff4444',
                  color: '#fff',
                  padding: '4px 12px',
                  borderRadius: 4,
                  fontSize: 12,
                  fontWeight: 'bold',
                }}>
                  ON-CHAIN PAUSED
                </span>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
              <div style={{ background: '#1a1a1a', padding: 16, borderRadius: 8 }}>
                <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}>Balance</div>
                <div style={{ fontSize: 28, fontWeight: 'bold', color: '#00d4aa' }}>
                  {formatSui(status.balance)} <span style={{ fontSize: 14, color: '#888' }}>SUI</span>
                </div>
              </div>
              <div style={{ background: '#1a1a1a', padding: 16, borderRadius: 8 }}>
                <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}>Daily Spent</div>
                <div style={{ fontSize: 28, fontWeight: 'bold' }}>
                  {formatSui(status.spent.daily)} <span style={{ fontSize: 14, color: '#888' }}>/ {formatSui(status.caps.daily)}</span>
                </div>
              </div>
              <div style={{ background: '#1a1a1a', padding: 16, borderRadius: 8 }}>
                <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}>Pending Settlement</div>
                <div style={{ fontSize: 28, fontWeight: 'bold', color: '#ffaa00' }}>
                  {formatSui(status.spent.pending)} <span style={{ fontSize: 14, color: '#888' }}>SUI</span>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ background: '#1a1a1a', padding: '8px 12px', borderRadius: 6, fontSize: 12 }}>
                <span style={{ color: '#888' }}>Monthly: </span>
                <span style={{ color: '#fff' }}>{formatSui(status.spent.monthly)} / {formatSui(status.caps.monthly)} SUI</span>
              </div>
              <div style={{ background: '#1a1a1a', padding: '8px 12px', borderRadius: 6, fontSize: 12 }}>
                <span style={{ color: '#888' }}>Reserved: </span>
                <span style={{ color: '#fff' }}>{formatSui(status.spent.reserved)} SUI</span>
              </div>
              <div style={{ background: '#1a1a1a', padding: '8px 12px', borderRadius: 6, fontSize: 12 }}>
                <span style={{ color: '#888' }}>Velocity: </span>
                <span style={{ color: status.velocity.currentRate > status.velocity.threshold ? '#ff4444' : '#00d4aa' }}>
                  {status.velocity.currentRate} / {status.velocity.threshold} req/min
                </span>
              </div>
            </div>
          </div>

          {/* ── SETUP BUTTON ────────────────────────────────────────────── */}
          <div style={{ marginBottom: 24 }}>
            <button
              onClick={handleSetupTreasury}
              disabled={setupLoading}
              style={{
                width: '100%',
                padding: '18px 24px',
                fontSize: 16,
                fontWeight: 'bold',
                background: setupLoading ? '#333' : '#00d4aa',
                color: '#000',
                border: 'none',
                borderRadius: 8,
                cursor: setupLoading ? 'not-allowed' : 'pointer',
              }}
            >
              {setupLoading ? 'Building PTB...' : '⚡ Setup Treasury (Deposit + Caps PTB)'}
            </button>
            <p style={{ color: '#666', fontSize: 12, marginTop: 8 }}>
              Deposits 0.05 SUI and sets daily/monthly caps, provider caps, and alert threshold in a single PTB.
            </p>
          </div>

          {/* ── DEPOSIT (Standalone) ────────────────────────────────────── */}
          <div style={{ marginBottom: 24 }}>
            <button
              onClick={handleDeposit}
              disabled={depositLoading}
              style={{
                width: '100%',
                padding: '14px 24px',
                fontSize: 15,
                fontWeight: 'bold',
                background: depositLoading ? '#333' : '#0066cc',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                cursor: depositLoading ? 'not-allowed' : 'pointer',
                marginBottom: 8,
              }}
            >
              {depositLoading ? 'Building PTB...' : '💰 Deposit to Treasury (PTB)'}
            </button>
            <p style={{ color: '#666', fontSize: 12 }}>
              Add funds to your existing treasury. Uses your wallet to sign the transaction.
            </p>
          </div>

          {/* ── PROVIDERS ───────────────────────────────────────────────── */}
          <div style={{ background: '#111', padding: 24, borderRadius: 12, marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, marginBottom: 16 }}>🔌 Providers</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {Object.entries(providers).map(([name, info]) => (
                <div key={name} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: 12,
                  background: '#1a1a1a',
                  borderRadius: 8,
                }}>
                  <div>
                    <div style={{ fontWeight: 'bold', textTransform: 'capitalize' }}>{name}</div>
                    <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>
                      {Object.keys(info.models).join(', ')}
                    </div>
                  </div>
                  <span style={{
                    padding: '4px 12px',
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 'bold',
                    background: info.configured ? '#004d33' : '#4d3300',
                    color: info.configured ? '#00d4aa' : '#ffaa00',
                  }}>
                    {info.configured ? '● LIVE' : '○ STUB'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ── API KEYS ────────────────────────────────────────────────── */}
          <div style={{ background: '#111', padding: 24, borderRadius: 12, marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, marginBottom: 16 }}>🔑 API Keys</h2>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="Key label (e.g., Production Agent)"
                value={newKeyLabel}
                onChange={(e) => setNewKeyLabel(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 200,
                  padding: 10,
                  background: '#1a1a1a',
                  border: '1px solid #333',
                  borderRadius: 6,
                  color: '#fff',
                  fontSize: 13,
                }}
              />
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 12px',
                background: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: 6,
                fontSize: 12,
                color: '#888',
                cursor: 'pointer',
              }}>
                <input
                  type="checkbox"
                  checked={allowKeyResume}
                  onChange={(e) => setAllowKeyResume(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                Allow resume
              </label>
              <button
                onClick={handleCreateKey}
                disabled={keyLoading}
                style={{
                  padding: '10px 20px',
                  fontSize: 14,
                  fontWeight: 'bold',
                  background: keyLoading ? '#333' : '#00d4aa',
                  color: '#000',
                  border: 'none',
                  borderRadius: 6,
                  cursor: keyLoading ? 'not-allowed' : 'pointer',
                }}
              >
                {keyLoading ? 'Creating...' : 'Generate Key'}
              </button>
            </div>

            {newKey && (
              <div style={{
                background: '#0a2a1a',
                border: '1px solid #00d4aa',
                padding: 16,
                borderRadius: 8,
                marginBottom: 16,
              }}>
                <div style={{ color: '#00d4aa', fontWeight: 'bold', marginBottom: 8 }}>
                  🔐 API Key Created — Copy this now!
                </div>
                <div style={{
                  fontFamily: 'monospace',
                  fontSize: 13,
                  background: '#0a0a0a',
                  padding: 12,
                  borderRadius: 6,
                  wordBreak: 'break-all',
                  color: '#fff',
                }}>
                  {newKey}
                </div>
                <button
                  onClick={() => {
                    copyToClipboard(newKey);
                    setCopiedKey(newKey);
                    setTimeout(() => setCopiedKey(null), 2000);
                  }}
                  style={{
                    marginTop: 8,
                    padding: '6px 12px',
                    fontSize: 12,
                    background: '#00d4aa',
                    color: '#000',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  {copiedKey === newKey ? '✓ Copied!' : 'Copy to Clipboard'}
                </button>
              </div>
            )}

            {apiKeys.length === 0 ? (
              <p style={{ color: '#888' }}>No API keys yet</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {apiKeys.map((k, i) => (
                  <div key={i} style={{
                    padding: 12,
                    background: '#1a1a1a',
                    borderRadius: 6,
                    fontSize: 13,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}>
                    <div>
                      <div style={{ fontFamily: 'monospace', color: '#aaa' }}>
                        {k.key.slice(0, 24)}...
                      </div>
                      <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>
                        {k.label}
                        {k.allowApiKeyResume && <span style={{ color: '#00d4aa', marginLeft: 8 }}>● Can resume</span>}
                        {k.revoked && <span style={{ color: '#ff4444', marginLeft: 8 }}>● Revoked</span>}
                      </div>
                    </div>
                    <div style={{ color: '#888', fontSize: 11 }}>
                      {formatDate(k.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 16, padding: 12, background: '#0a0a0a', borderRadius: 6 }}>
              <div style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>Example usage:</div>
              <code style={{ fontSize: 11, color: '#00d4aa', fontFamily: 'monospace', display: 'block', whiteSpace: 'pre-wrap' }}>
                {`curl -X POST ${GATEWAY_URL}/v1/chat \
  -H "Authorization: Bearer seal_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.1-8b-instant","messages":[{"role":"user","content":"Hello"}]}'`}
              </code>
            </div>
          </div>

          {/* ── API CALL DEMO ───────────────────────────────────────────── */}
          <div style={{ background: '#111', padding: 24, borderRadius: 12, marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, marginBottom: 16 }}>🤖 API Call Demo</h2>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                style={{
                  padding: 10,
                  background: '#1a1a1a',
                  border: '1px solid #333',
                  borderRadius: 6,
                  color: '#fff',
                  fontSize: 13,
                }}
              >
                {Object.entries(providers).flatMap(([providerName, info]) =>
                  Object.keys(info.models).map(model => (
                    <option key={model} value={model}>
                      {model} ({providerName})
                    </option>
                  ))
                )}
              </select>
            </div>

            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Type a prompt..."
              rows={3}
              style={{
                width: '100%',
                padding: 12,
                background: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: 8,
                color: '#fff',
                fontFamily: 'system-ui, sans-serif',
                fontSize: 14,
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />

            <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
              <button
                onClick={handleApiCall}
                disabled={apiLoading || !prompt.trim()}
                style={{
                  padding: '12px 24px',
                  fontSize: 16,
                  fontWeight: 'bold',
                  background: apiLoading ? '#333' : '#00d4aa',
                  color: '#000',
                  border: 'none',
                  borderRadius: 8,
                  cursor: apiLoading || !prompt.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                {apiLoading ? 'Processing...' : '⚡ Pay & Call AI'}
              </button>
              <span style={{ color: '#888', fontSize: 14 }}>
                Uses your active API key
              </span>
            </div>

            {apiResponse && (
              <div style={{
                marginTop: 16,
                padding: 16,
                background: '#1a1a1a',
                borderRadius: 8,
                border: apiResponse.error ? '1px solid #ff4444' : '1px solid #333',
              }}>
                {apiResponse.error ? (
                  <div>
                    <div style={{ color: '#ff4444', fontWeight: 'bold', marginBottom: 8 }}>
                      Error
                    </div>
                    <div style={{ fontSize: 14, color: '#ff8888' }}>
                      {apiResponse.error}
                    </div>
                    {apiResponse.details && (
                      <div style={{ fontSize: 12, color: '#aa6666', marginTop: 4 }}>
                        {apiResponse.details}
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <div style={{ color: '#00d4aa', fontWeight: 'bold', marginBottom: 8 }}>
                      Response
                    </div>
                    <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                      {apiResponse.content}
                    </div>
                    {apiResponse.cost && (
                      <div style={{
                        marginTop: 12,
                        padding: 12,
                        background: '#0a0a0a',
                        borderRadius: 6,
                        fontSize: 12,
                        fontFamily: 'monospace',
                        color: '#888',
                      }}>
                        <div>Model: {apiResponse.model}</div>
                        <div>Cost: {apiResponse.cost.actual} MIST (est: {apiResponse.cost.estimated})</div>
                        <div>Tokens: {apiResponse.usage?.total_tokens || 'N/A'}</div>
                        <div>Pending settlement: {apiResponse.settlement?.pending} MIST</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── RECENT EVENTS ───────────────────────────────────────────── */}
          <div style={{ background: '#111', padding: 24, borderRadius: 12 }}>
            <h2 style={{ fontSize: 18, marginBottom: 16 }}>📋 Recent Events</h2>

            {events.length === 0 ? (
              <p style={{ color: '#888' }}>No events found</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {events.slice(0, 15).map((e, i) => (
                  <div key={i} style={{
                    padding: 12,
                    background: '#1a1a1a',
                    borderRadius: 8,
                    fontSize: 13,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#00d4aa', fontWeight: 'bold' }}>
                        {e.type?.split('::').pop() || 'Event'}
                      </span>
                      <span style={{ color: '#666', fontSize: 11 }}>
                        {e.timestampMs ? formatDate(e.timestampMs) : 'Unknown'}
                      </span>
                    </div>
                    <div style={{ color: '#888', fontFamily: 'monospace', fontSize: 11, marginTop: 4 }}>
                      {e.id?.txDigest?.slice(0, 20)}...
                    </div>
                    {e.parsedJson && (
                      <div style={{ color: '#666', fontSize: 11, marginTop: 4 }}>
                        {Object.entries(e.parsedJson)
                          .filter(([k]) => !['timestamp', 'wallet_call_number'].includes(k))
                          .slice(0, 4)
                          .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
                          .join(' | ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
