# SEAL v0.2.0 — Agent Treasury Protocol

> One API key. Multiple providers. On-chain caps.

SEAL is a non-custodial billing layer for AI teams. Deposit once, set hard spend caps enforced by Sui Move smart contracts, and route API calls to any provider through a single key.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    SEAL Gateway (Node/TS)                │
│  • API key auth  • Provider routing  • Velocity tracking │
│  • Soft pause    • Batch settlement  • Rate limiting     │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│              Sui Move Contract (Testnet)                 │
│  • deposit / withdraw                                    │
│  • set_spend_caps / set_provider_cap                   │
│  • authorize_call (gateway-only)                         │
│  • pause_wallet / unpause_wallet (user-only)             │
│  • Events: Deposit, Withdraw, Receipt, Pause, Alert      │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│              Next.js Dashboard                           │
│  • Wallet connect  • Treasury setup PTB                │
│  • API key management  • Anomaly alerts  • Resume        │
│  • Spend history  • Provider status                      │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Gateway

```bash
cd seal-gateway
npm install
# Create .env from template
cp .env.example .env
# Edit .env with your keys
npm run dev        # tsx gateway.ts
```

### 2. Dashboard

```bash
cd seal-dashboard
npm install
npm run dev        # Next.js dev server on :3000
```

### 3. Agent SDK

```typescript
import { SealClient } from './seal-sdk';

const seal = new SealClient({
  apiKey: 'seal_...',
  gatewayUrl: 'http://localhost:3001',
});

const response = await seal.chat({
  model: 'llama-3.1-8b-instant',
  messages: [{ role: 'user', content: 'Hello' }],
});

console.log(response.content);
console.log(`Cost: ${response.cost.actual} MIST`);
```

## Key Features

### Non-Custodial by Design
- Gateway only signs `authorize_call` (settlement)
- User signs all treasury operations (deposit, caps, pause) via PTB
- No trust assumption on gateway operator

### Programmable Spend Caps
- Daily, monthly, and per-provider limits enforced on-chain
- Caps cannot be overridden by a compromised API key
- Batch settlement every 5 minutes (configurable)

### Velocity-Based Anomaly Detection
- Sliding window tracks request rate per wallet
- Auto-pause on spike (configurable threshold)
- Manual resume via dashboard or API key (if permitted)

### Provider Router
- Single API key routes to Groq, OpenAI, Anthropic, or any x402-compatible service
- Per-model cost rates (configurable, restart to update)
- Stubs for unconfigured providers (show architecture without API keys)

### Persistent State
- API keys, credit ledger, pause state, and consumed digests stored in `data/` JSON
- Survives gateway restarts
- Event indexer with per-type cursors (fixed from v0.1.0 bug)

## Environment Variables

```
SUI_RPC=https://fullnode.testnet.sui.io:443
PACKAGE_ID=0x6e1de9eee9168dbf4803abf85fa955c0047111c8572ff74a3e47d3983bd61fd4
POOL_ID=0xed89af9714f4d509c3a3578d295cd3acd71b4a4ae51dc6afca2d295ac96c9809
GATEWAY_ADDRESS=0xdb46b6c133f989a776279be1ef95c2f3cc0be6cf8103d8ab390363964d475c13
GATEWAY_PRIVATE_KEY=suiprivkey1qq3s87q8jlf5p3h6edxemqdklzjkwcfxevmqhk2sdvndjtuahyw2qwnag0x
PORT=3001
GROQ_API_KEY=gsk_...
# OPENAI_API_KEY=sk-...      # Optional
# ANTHROPIC_API_KEY=sk-...   # Optional
```

## API Endpoints

### Gateway

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Gateway status, provider config |
| GET | `/providers` | List providers, models, cost rates |
| GET | `/balance/:wallet` | On-chain balance (gasless) |
| GET | `/status/:wallet` | Full status: balance, caps, pause, velocity |
| POST | `/keys/create` | Generate API key |
| GET | `/keys/:wallet` | List keys for wallet |
| POST | `/keys/revoke` | Revoke API key |
| POST | `/v1/chat` | Chat completion (primary flow) |
| POST | `/api/:provider` | x402-protected route (secondary) |
| POST | `/resume` | Resume via API key (if permitted) |
| POST | `/resume/:wallet` | Resume via wallet address |
| POST | `/settle` | Manual on-chain settlement |

### Dashboard

- Connect Sui wallet via `@mysten/dapp-kit`
- "Setup Treasury" PTB: deposit + caps + provider caps + alert threshold
- Create API keys with optional resume permission
- Real-time status polling (10s interval)
- Anomaly alert banner with resume button
- API call demo with model selection

## Agent Demo

```bash
# Phase 1-3: Normal operation → bug injection → pause
cd seal-gateway
SEAL_API_KEY=seal_... npx tsx agent-demo.ts

# Phase 4: Resume and confirm
SEAL_API_KEY=seal_... RESUME=1 npx tsx agent-demo.ts
```

## Known Issues

1. **Contract bug:** `update_protocol_wallet` emits event with wrong `old_wallet` (both fields show new value). Avoid using this function.
2. **Contract bug:** `withdraw_from_team` and `deposit_to_team` emit `wallet` as `team_id` instead of actual withdrawer/depositor. Event indexing handles this correctly for display.
3. **Contract inefficiency:** Double `coin::split` in `authorize_call`. Functional but wastes gas.
4. **No `remove_team_member` or `update_team_caps`:** Team treasury functions are limited. Team treasury is deprioritized in v0.2.0.
5. **One team per address:** `create_team` uses sender as team_id. Cannot create multiple teams.
6. **Cost rates:** Hardcoded in gateway config. Restart to update. Not dynamically pulled from providers.
7. **JSON persistence:** File-based, no concurrency safety. Single gateway instance only.

## Roadmap

### v0.3.0
- [ ] USDC support (mainnet)
- [ ] Dynamic cost rate updates via admin endpoint
- [ ] Team treasury v2 (remove member, update caps, multiple teams)
- [ ] SQLite persistence (concurrency-safe)
- [ ] Webhook alerts (Discord, Slack, email)
- [ ] SDK: Python, Go bindings

### v0.4.0
- [ ] Permissionless gateway network (multi-sig settlement)
- [ ] Natural language policy config ("spend max $5/day on GPT-4")
- [ ] Provider marketplace (anyone can add a provider)
- [ ] Cross-chain settlement (Wormhole, LayerZero)

## License

MIT
