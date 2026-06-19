/**
 * SEAL Agent SDK
 * 
 * A simple client for AI agents to interact with the SEAL gateway.
 * Handles authentication, retries, and respects pause signals.
 * 
 * Usage:
 *   const seal = new SealClient({
 *     apiKey: 'seal_...',
 *     gatewayUrl: 'http://localhost:3001',
 *   });
 * 
 *   const response = await seal.chat({
 *     model: 'llama-3.1-8b-instant',
 *     messages: [{ role: 'user', content: 'Hello' }],
 *   });
 */

interface SealClientConfig {
  apiKey: string;
  gatewayUrl?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

interface ChatResponse {
  status: string;
  model: string;
  content: string;
  usage?: {
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
  };
  cost: {
    estimated: string;
    actual: string;
    currency: string;
  };
  settlement: {
    pending: string;
    lastSettled: number;
  };
  velocity: {
    rate: number;
    threshold: number;
    windowMs: number;
  };
}

interface SealError {
  error: string;
  message?: string;
  details?: string;
}

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

export class SealClient {
  private apiKey: string;
  private gatewayUrl: string;
  private maxRetries: number;
  private retryDelayMs: number;
  private timeoutMs: number;

  constructor(config: SealClientConfig) {
    this.apiKey = config.apiKey;
    this.gatewayUrl = config.gatewayUrl || 'http://localhost:3001';
    this.maxRetries = config.maxRetries || 3;
    this.retryDelayMs = config.retryDelayMs || 1000;
    this.timeoutMs = config.timeoutMs || 30000;
  }

  /**
   * Make a chat completion request through SEAL.
   * Automatically retries on transient errors.
   * Respects 403 (paused) and 402 (insufficient balance) by throwing immediately.
   */
  async chat(options: ChatOptions): Promise<ChatResponse> {
    const url = `${this.gatewayUrl}/v1/chat`;
    const body = JSON.stringify({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 256,
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        const data = await response.json();

        if (response.status === 403) {
          // Wallet paused — don't retry
          throw new SealPauseError(
            data.error || 'Wallet paused',
            data.reason,
            data.pausedAt,
            data.auto
          );
        }

        if (response.status === 402) {
          // Insufficient balance — don't retry
          throw new SealBalanceError(
            data.error || 'Insufficient balance',
            data.balance,
            data.required
          );
        }

        if (response.status === 429) {
          // Rate limited — retry with backoff
          lastError = new Error(data.error || 'Rate limited');
          await this.delay(this.retryDelayMs * (attempt + 1));
          continue;
        }

        if (!response.ok) {
          // Other error — retry
          lastError = new Error(data.error || `HTTP ${response.status}`);
          await this.delay(this.retryDelayMs * (attempt + 1));
          continue;
        }

        return data as ChatResponse;
      } catch (err: any) {
        if (err instanceof SealPauseError || err instanceof SealBalanceError) {
          throw err; // Don't retry these
        }
        if (err.name === 'AbortError') {
          lastError = new Error('Request timed out');
        } else {
          lastError = err;
        }
        await this.delay(this.retryDelayMs * (attempt + 1));
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  /**
   * Check wallet status: balance, caps, pause state, velocity.
   */
  async getStatus(): Promise<WalletStatus> {
    // Extract wallet from API key lookup — we need a /status endpoint that accepts API key
    // For now, we'll use a workaround: the gateway doesn't expose wallet from key
    // In production, add GET /v1/status that uses the API key
    throw new Error('getStatus() requires wallet address. Use getStatusByWallet() instead.');
  }

  /**
   * Resume a paused wallet (if the API key has resume permission).
   */
  async resume(): Promise<{ status: string; previousPause?: any }> {
    const response = await fetch(`${this.gatewayUrl}/resume`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Thrown when the wallet is paused (auto or manual).
 */
export class SealPauseError extends Error {
  reason: string;
  pausedAt: number;
  auto: boolean;

  constructor(message: string, reason: string, pausedAt: number, auto: boolean) {
    super(message);
    this.name = 'SealPauseError';
    this.reason = reason;
    this.pausedAt = pausedAt;
    this.auto = auto;
  }
}

/**
 * Thrown when the wallet has insufficient balance.
 */
export class SealBalanceError extends Error {
  balance: string;
  required: string;

  constructor(message: string, balance: string, required: string) {
    super(message);
    this.name = 'SealBalanceError';
    this.balance = balance;
    this.required = required;
  }
}
