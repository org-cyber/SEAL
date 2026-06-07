import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Signer } from '@mysten/sui/cryptography';

interface PaymentRequirements {
  scheme: 'x402-sui';
  network: string;
  pool: string;
  package: string;
  amount: string;
  currency: string;
  gateway: string;
}

interface X402ClientConfig {
  signer: Signer;           // Wallet keypair or browser wallet adapter
  client?: SuiClient;
}

/**
 * x402 Client Adapter
 * 
 * Usage:
 *   const adapter = new X402ClientAdapter({ signer: myKeypair });
 *   const response = await adapter.fetch('https://api.example.com/claude', {
 *     method: 'POST',
 *     body: JSON.stringify({ prompt: 'Hello' }),
 *   });
 */
export class X402ClientAdapter {
  private client: SuiClient;
  private signer: Signer;

  constructor(config: X402ClientConfig) {
    this.client = config.client || new SuiClient({ url: getFullnodeUrl('testnet') });
    this.signer = config.signer;
  }

  /**
   * Make an HTTP request that handles 402 payment-required automatically
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    // First attempt: no payment proof
    let response = await this.plainFetch(url, init);

    // If not 402, return as-is
    if (response.status !== 402) {
      return response;
    }

    // Parse 402 requirements
    const body = await response.json();
    if (!body.x402 || !body.payment) {
      throw new Error('Server returned 402 but not x402-compatible');
    }

    const requirements: PaymentRequirements = body.payment;

    // Build and submit payment transaction
    const digest = await this.submitPayment(requirements);

    // Retry with payment proof
    return this.plainFetch(url, {
      ...init,
      headers: {
        ...init.headers,
        'x-sui-payment': digest,
      },
    });
  }

  /**
   * Submit payment to SEAL pool and return transaction digest
   */
  private async submitPayment(req: PaymentRequirements): Promise<string> {
    // For SEAL, the payment is an authorize_call transaction
    // In a real implementation, the client would need to know:
    // - their wallet address
    // - the provider address
    // - the provider name
    // - the cost amount
    
    // For now, we'll build a generic deposit transaction as proof of concept
    // In production, this would call authorize_call or the gateway would handle it
    
    const tx = new Transaction();
    
    // The client needs their SUI coin object ID
    // This would come from wallet connection or coin selection
    const coins = await this.client.getCoins({
      owner: this.signer.getPublicKey().toSuiAddress(),
      coinType: '0x2::sui::SUI',
    });

    if (coins.data.length === 0) {
      throw new Error('No SUI coins available for payment');
    }

    const [paymentCoin] = tx.splitCoins(
      tx.object(coins.data[0].coinObjectId),
      [tx.pure.u64(BigInt(req.amount))]
    );

    tx.moveCall({
      target: `${req.package}::seal_api_pool::deposit`,
      arguments: [
        tx.object(req.pool),
        paymentCoin,
        tx.object('0x6'),
      ],
    });

    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.signer,
      options: { showEffects: true },
    });

    return result.digest;
  }

  private async plainFetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  }
}
