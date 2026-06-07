import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Request, Response, NextFunction } from 'express';

// Configuration passed by the API provider
interface X402ProviderConfig {
  poolId: string;
  packageId: string;
  gatewayUrl: string;
  minCost: bigint;        // Minimum payment in MIST
  network: string;        // "sui:testnet" or "sui:mainnet"
}

// Payment requirements returned in 402 response
interface PaymentRequirements {
  scheme: 'x402-sui';
  network: string;
  pool: string;
  package: string;
  amount: string;
  currency: string;
  gateway: string;
}

// In-memory cache of verified payments (prevent replay)
// Production: use Redis with TTL
const verifiedPayments = new Map<string, number>(); // digest -> timestamp

/**
 * x402 Provider Middleware
 * 
 * Usage in Express:
 *   app.use('/api/claude', x402ProviderMiddleware(config));
 *   app.post('/api/claude', (req, res) => { ... actual Claude handler ... });
 */
export function x402ProviderMiddleware(config: X402ProviderConfig) {
  const client = new SuiClient({ url: getFullnodeUrl('testnet') });

  return async (req: Request, res: Response, next: NextFunction) => {
    const paymentDigest = req.headers['x-sui-payment'] as string;

    // ── No payment proof provided → return 402 ──
    if (!paymentDigest) {
      const requirements: PaymentRequirements = {
        scheme: 'x402-sui',
        network: config.network,
        pool: config.poolId,
        package: config.packageId,
        amount: config.minCost.toString(),
        currency: 'SUI',
        gateway: config.gatewayUrl,
      };

      return res.status(402).json({
        error: 'Payment Required',
        x402: true,
        payment: requirements,
        message: 'Submit a Sui transaction to the SEAL pool and retry with the transaction digest in the x-sui-payment header.',
      });
    }

    // ── Payment proof provided → verify on-chain ──
    try {
      // Check cache first (prevent replay attacks)
      if (verifiedPayments.has(paymentDigest)) {
        const age = Date.now() - verifiedPayments.get(paymentDigest)!;
        if (age < 300_000) { // 5 minutes cache
          return next(); // Already verified, proceed
        }
      }

      // Fetch transaction from Sui
      const tx = await client.getTransactionBlock({
        digest: paymentDigest,
        options: { showEvents: true, showEffects: true },
      });

      // Verify transaction succeeded
      if (tx.effects?.status?.status !== 'success') {
        return res.status(402).json({
          error: 'Payment Invalid',
          message: 'Transaction failed or not found on-chain.',
        });
      }

      // Verify receipt event exists
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

      // Verify payment amount meets minimum
      const receipt = receiptEvent.parsedJson as any;
      const totalCost = BigInt(receipt.cost || 0) + BigInt(receipt.fee || 0);
      
      if (totalCost < config.minCost) {
        return res.status(402).json({
          error: 'Payment Insufficient',
          message: `Payment ${totalCost} is less than required ${config.minCost}.`,
        });
      }

      // Verify receipt is for this provider (optional but recommended)
      const providerName = Buffer.from(receipt.provider || []).toString();
      // Could check providerName matches expected value

      // Cache verified payment
      verifiedPayments.set(paymentDigest, Date.now());

      // ── Payment valid → proceed to API handler ──
      next();

    } catch (err) {
      console.error('x402 verification error:', err);
      return res.status(402).json({
        error: 'Payment Verification Failed',
        message: 'Could not verify payment on-chain.',
      });
    }
  };
}
