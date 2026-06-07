import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Request, Response, NextFunction } from 'express';

interface X402ProviderConfig {
  poolId: string;
  packageId: string;
  gatewayUrl: string;
  minCost: bigint;
  network: string;
}

const verifiedPayments = new Map<string, number>();

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

    // ── Payment proof provided → verify on-chain ──
    try {
      if (verifiedPayments.has(paymentDigest)) {
        const age = Date.now() - verifiedPayments.get(paymentDigest)!;
        if (age < 300_000) {
          return next();
        }
      }

      const tx = await client.getTransactionBlock({
        digest: paymentDigest,
        options: { showEvents: true, showEffects: true },
      });

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

      verifiedPayments.set(paymentDigest, Date.now());
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
