import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Request, Response, NextFunction } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

interface X402ProviderConfig {
  poolId: string;
  packageId: string;
  gatewayUrl: string;
  minCost: bigint;
  network: string;
}

// ── SHARED PERSISTENCE ──────────────────────────────────────────────────────
// Consumed digests are shared across all gateway instances (if single instance)
// and survive restarts. This prevents replay attacks beyond the 5-min cache.

const CONSUMED_DIGESTS_FILE = join(process.cwd(), 'data', 'consumed-digests.json');

function loadConsumedDigests(): Set<string> {
  if (!existsSync(CONSUMED_DIGESTS_FILE)) return new Set();
  try {
    const data = JSON.parse(readFileSync(CONSUMED_DIGESTS_FILE, 'utf-8'));
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

function saveConsumedDigests(digests: Set<string>) {
  // Keep last 1000 digests to prevent unbounded growth
  const arr = Array.from(digests).slice(-1000);
  writeFileSync(CONSUMED_DIGESTS_FILE, JSON.stringify(arr, null, 2));
}

const consumedDigests = loadConsumedDigests();

// In-memory cache for fast lookups (5-minute TTL)
const verifiedPayments = new Map<string, number>();
const VERIFICATION_TTL_MS = 300_000; // 5 minutes

export function x402ProviderMiddleware(config: X402ProviderConfig) {
  const client = new SuiClient({ url: getFullnodeUrl('testnet') });

  return async (req: Request, res: Response, next: NextFunction) => {
    const paymentDigest = req.headers['x-sui-payment'] as string;

    // ── No payment proof → return 402 ──
    if (!paymentDigest) {
      return res.status(402).json({
        error: 'Payment Required',
        x402: true,
        payment: {
          scheme: 'x402-sui',
          network: config.network,
          pool: config.poolId,
          package: config.packageId,
          amount: config.minCost.toString(),
          currency: 'SUI',
          gateway: config.gatewayUrl,
        },
        message: 'Submit a Sui transaction to the SEAL pool and retry with the transaction digest in the x-sui-payment header.',
      });
    }

    // ── Check consumed digests (replay protection) ──────────────────────
    if (consumedDigests.has(paymentDigest)) {
      return res.status(402).json({
        error: 'Payment Already Consumed',
        message: 'This payment digest has already been used. Each payment can only be used once.',
      });
    }

    // ── Check in-memory cache (fast path, 5-min TTL) ────────────────────────
    if (verifiedPayments.has(paymentDigest)) {
      const age = Date.now() - verifiedPayments.get(paymentDigest)!;
      if (age < VERIFICATION_TTL_MS) {
        return next();
      }
      // Expired from cache — fall through to re-verify and re-consume
    }

    // ── Payment proof provided → verify on-chain ──────────────────────────
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

      const tx = await client.getTransactionBlock({
        digest: paymentDigest,
        options: { showEvents: true, showEffects: true },
      });

      clearTimeout(timeout);

      if (tx.effects?.status?.status !== 'success') {
        return res.status(402).json({
          error: 'Payment Invalid',
          message: 'Transaction failed or not found on-chain.',
        });
      }

      const receiptEvent = tx.events?.find(e =>
        e.type.includes('ApiCallReceiptEvent') ||
        e.type.includes('TeamCallReceiptEvent')
      );

      if (!receiptEvent) {
        return res.status(402).json({
          error: 'Payment Invalid',
          message: 'Transaction does not contain a valid SEAL receipt event.',
        });
      }

      const receipt = receiptEvent.parsedJson as any;
      const totalCost = BigInt(receipt.cost || 0) + BigInt(receipt.fee || 0);

      if (totalCost < config.minCost) {
        return res.status(402).json({
          error: 'Payment Insufficient',
          message: `Payment ${totalCost} is less than required ${config.minCost}.`,
        });
      }

      // ── Mark as consumed (permanent replay protection) ───────────────────
      consumedDigests.add(paymentDigest);
      saveConsumedDigests(consumedDigests);
      verifiedPayments.set(paymentDigest, Date.now());

      next();

    } catch (err: any) {
      if (err.name === 'AbortError') {
        return res.status(504).json({
          error: 'Payment Verification Timeout',
          message: 'Could not verify payment within 30 seconds. Try again.',
        });
      }

      console.error('x402 verification error:', err);
      return res.status(402).json({
        error: 'Payment Verification Failed',
        message: 'Could not verify payment on-chain.',
      });
    }
  };
}
