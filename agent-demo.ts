/**
 * SEAL Agent Demo Script
 * 
 * Simulates a real AI agent that uses the SEAL SDK to make API calls.
 * 
 * Phase 1: Normal operation — 3 calls at reasonable intervals
 * Phase 2: Bug injection — enters retry loop, rapid-fire calls
 * Phase 3: SEAL detects velocity spike, soft-pauses wallet
 * Phase 4: Agent catches SealPauseError, stops
 * Phase 5: (Manual) Operator resumes via dashboard
 * 
 * Usage:
 *   SEAL_API_KEY=seal_... npx tsx agent-demo.ts
 */

import { SealClient, SealPauseError, SealBalanceError } from './seal-sdk';

const GATEWAY_URL = process.env.SEAL_GATEWAY_URL || 'http://localhost:3001';
const API_KEY = process.env.SEAL_API_KEY;

if (!API_KEY) {
  console.error('Error: Set SEAL_API_KEY environment variable');
  process.exit(1);
}

const seal = new SealClient({
  apiKey: API_KEY,
  gatewayUrl: GATEWAY_URL,
  maxRetries: 2,
  retryDelayMs: 500,
});

const MODEL = 'llama-3.1-8b-instant';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') {
  const colors = {
    info: '[36m',    // Cyan
    success: '[32m', // Green
    error: '[31m',   // Red
    warning: '[33m', // Yellow
  };
  const reset = '[0m';
  console.log(`${colors[type]}[${new Date().toISOString().split('T')[1].slice(0, 8)}] ${message}${reset}`);
}

// ── PHASE 1: NORMAL OPERATION ───────────────────────────────────────────────

async function normalOperation() {
  log('═'.repeat(60), 'info');
  log('PHASE 1: Normal Operation — 3 API calls, 2s intervals', 'info');
  log('═'.repeat(60), 'info');

  for (let i = 1; i <= 3; i++) {
    log(`Call ${i}/3: Sending request...`);
    try {
      const response = await seal.chat({
        model: MODEL,
        messages: [{ role: 'user', content: `What is ${i} + ${i}?` }],
        max_tokens: 64,
      });

      log(`Call ${i}/3: ✅ Success — Cost: ${response.cost.actual} MIST, Tokens: ${response.usage?.total_tokens || 'N/A'}`, 'success');
      log(`  Response: ${response.content.slice(0, 80)}...`);

      // Show velocity info
      if (response.velocity) {
        log(`  Velocity: ${response.velocity.rate}/${response.velocity.threshold} req/min`, 'info');
      }
    } catch (err: any) {
      log(`Call ${i}/3: ❌ Error — ${err.message}`, 'error');
    }

    if (i < 3) {
      log('Waiting 2 seconds...');
      await delay(2000);
    }
  }
}

// ── PHASE 2: BUG INJECTION — RETRY LOOP ───────────────────────────────────

async function bugInjection() {
  log('');
  log('═'.repeat(60), 'warning');
  log('PHASE 2: BUG INJECTION — Simulating retry loop (10 rapid calls)', 'warning');
  log('═'.repeat(60), 'warning');

const MAX_BUG_CALLS = 15;
  let pauseCaught = false;

  for (let i = 1; i <= MAX_BUG_CALLS; i++) {
    log(`Bug call ${i}/${MAX_BUG_CALLS}: Rapid-fire request...`);

    try {
      const response = await seal.chat({
        model: MODEL,
        messages: [{ role: 'user', content: 'Retrying due to timeout...' }],
        max_tokens: 32,
      });

      log(`Bug call ${i}/${MAX_BUG_CALLS}: ✅ Success — Cost: ${response.cost.actual} MIST`, 'success');
      log(`  Velocity: ${response.velocity.rate}/${response.velocity.threshold} req/min`, 'warning');

      // If velocity is getting high, warn
      if (response.velocity.rate > response.velocity.threshold * 0.7) {
        log(`  ⚠️ Velocity approaching threshold!`, 'warning');
      }
    } catch (err: any) {
      if (err instanceof SealPauseError) {
        log(`Bug call ${i}/${MAX_BUG_CALLS}: 🛑 WALLET PAUSED by SEAL!`, 'error');
        log(`  Reason: ${err.reason}`, 'error');
        log(`  Auto-detected: ${err.auto ? 'Yes' : 'No'}`, 'error');
        log(`  Paused at: ${new Date(err.pausedAt).toISOString()}`, 'error');
        pauseCaught = true;
        break;
      }

      if (err instanceof SealBalanceError) {
        log(`Bug call ${i}/${MAX_BUG_CALLS}: 💸 Insufficient balance`, 'error');
        log(`  Balance: ${err.balance}, Required: ${err.required}`, 'error');
        break;
      }

      log(`Bug call ${i}/${MAX_BUG_CALLS}: ❌ Error — ${err.message}`, 'error');
    }

    // Realistic bug: aggressive retry with 100ms delay
    // This simulates a typical retry loop that doesn't back off properly
    await delay(100);
  }

  return pauseCaught;
}

// ── PHASE 3: POST-PAUSE STATE ────────────────────────────────────────────

async function postPauseState(pauseCaught: boolean) {
  log('');
  log('═'.repeat(60), 'info');
  log('PHASE 3: Post-Pause State', 'info');
  log('═'.repeat(60), 'info');

  if (pauseCaught) {
    log('Agent detected pause. Attempting one more call to confirm...', 'info');

    try {
      await seal.chat({
        model: MODEL,
        messages: [{ role: 'user', content: 'Is this working?' }],
        max_tokens: 32,
      });
      log('Unexpected: Call succeeded after pause', 'warning');
    } catch (err: any) {
      if (err instanceof SealPauseError) {
        log('Confirmed: Wallet still paused. Agent halting.', 'error');
        log(`  Reason: ${err.reason}`, 'error');
      } else {
        log(`Unexpected error: ${err.message}`, 'error');
      }
    }

    log('');
    log('📋 Operator Action Required:', 'warning');
    log('  1. Open SEAL Dashboard', 'info');
    log('  2. Connect wallet', 'info');
    log('  3. Click "▶ Resume Treasury"', 'info');
    log('  4. Agent will continue automatically', 'info');
    log('');
    log('(In this demo, press Ctrl+C and re-run with RESUME=1)', 'info');
  } else {
    log('No pause detected. This could mean:', 'warning');
    log('  - Velocity threshold not reached (try increasing loop count)', 'info');
    log('  - Gateway not running', 'info');
    log('  - API key not configured correctly', 'info');
  }
}

// ── PHASE 4: RESUME AND CONTINUE (optional) ──────────────────────────────

async function resumeAndContinue() {
  log('');
  log('═'.repeat(60), 'success');
  log('PHASE 4: Resuming Treasury', 'success');
  log('═'.repeat(60), 'success');

  try {
    const result = await seal.resume();
    log('Resume successful!', 'success');
    log(`  Previous pause: ${JSON.stringify(result.previousPause)}`, 'info');
  } catch (err: any) {
    log(`Resume failed: ${err.message}`, 'error');
    return;
  }

  log('');
  log('Making one confirmation call...', 'info');
  await delay(1000);

  try {
    const response = await seal.chat({
      model: MODEL,
      messages: [{ role: 'user', content: 'System resumed. Confirm operational.' }],
      max_tokens: 64,
    });
    log('✅ Agent operational after resume!', 'success');
    log(`  Response: ${response.content.slice(0, 80)}...`, 'success');
  } catch (err: any) {
    log(`Post-resume error: ${err.message}`, 'error');
  }
}

// ── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  log('');
  log('╔══════════════════════════════════════════════════════════╗', 'info');
  log('║          SEAL Agent Demo — "The Agent That Went Rogue"   ║', 'info');
  log('╚══════════════════════════════════════════════════════════╝', 'info');
  log(`Gateway: ${GATEWAY_URL}`, 'info');
  log(`API Key: ${API_KEY.slice(0, 20)}...`, 'info');
  log('');

  const shouldResume = process.env.RESUME === '1';

  if (shouldResume) {
    await resumeAndContinue();
  } else {
    await normalOperation();
    const pauseCaught = await bugInjection();
    await postPauseState(pauseCaught);
  }

  log('');
  log('Demo complete.', 'success');
}

main().catch(err => {
  log(`Fatal error: ${err.message}`, 'error');
  process.exit(1);
});
