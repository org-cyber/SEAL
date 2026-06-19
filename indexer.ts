import { SuiClient, getFullnodeUrl, SuiEvent } from '@mysten/sui/client';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const client = new SuiClient({ url: process.env.SUI_RPC || getFullnodeUrl('testnet') });
const PACKAGE = process.env.PACKAGE_ID!;

const CACHE_FILE = join(process.cwd(), 'data', 'events-cache.json');
const POLL_INTERVAL = 30000; // 30 seconds

// Event types we care about
const EVENT_TYPES = [
  `${PACKAGE}::seal_api_pool::DepositEvent`,
  `${PACKAGE}::seal_api_pool::WithdrawEvent`,
  `${PACKAGE}::seal_api_pool::ApiCallReceiptEvent`,
  `${PACKAGE}::seal_api_pool::TeamCallReceiptEvent`,
  `${PACKAGE}::seal_api_pool::TeamCreatedEvent`,
  `${PACKAGE}::seal_api_pool::TeamMemberAddedEvent`,
  `${PACKAGE}::seal_api_pool::SpendCapsSetEvent`,
  `${PACKAGE}::seal_api_pool::ProviderCapSetEvent`,
  `${PACKAGE}::seal_api_pool::WalletPauseEvent`,
  `${PACKAGE}::seal_api_pool::LowBalanceAlertEvent`,
];

// ── FIXED: Per-type cursors instead of single global cursor ─────────────────
interface CachedEvents {
  cursors: Record<string, string | null>;  // eventType → cursor
  events: SuiEvent[];
  lastUpdated: number;
}

function loadCache(): CachedEvents {
  if (!existsSync(CACHE_FILE)) {
    return { cursors: {}, events: [], lastUpdated: 0 };
  }
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return { cursors: {}, events: [], lastUpdated: 0 };
  }
}

function saveCache(cache: CachedEvents) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ── BACKFILL ────────────────────────────────────────────────────────────────
// Fetch all historical events per type, oldest first.

async function backfillEvents() {
  console.log('[INDEXER] Backfilling historical events...');
  const cache = loadCache();

  for (const eventType of EVENT_TYPES) {
    try {
      let hasNext = true;
      let cursor: string | null | undefined = undefined;

      while (hasNext) {
        const response = await client.queryEvents({
          query: { MoveEventType: eventType },
          cursor,
          limit: 50,
          order: 'ascending',
        });

        if (response.data.length > 0) {
          const existingKeys = new Set(cache.events.map(e => `${e.id.txDigest}-${e.id.eventSeq}`));
          const newEvents = response.data.filter(e => !existingKeys.has(`${e.id.txDigest}-${e.id.eventSeq}`));

          cache.events.push(...newEvents);
          console.log(`[INDEXER] [${eventType.split('::').pop()}] +${newEvents.length} historical events`);
        }

        hasNext = response.hasNextPage;
        cursor = response.nextCursor;
      }
    } catch (err) {
      console.error(`[INDEXER] Failed to backfill ${eventType}:`, err);
    }
  }

  // Sort by timestamp descending
  cache.events.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
  cache.lastUpdated = Date.now();
  saveCache(cache);
  console.log(`[INDEXER] Backfill complete. Total events: ${cache.events.length}`);
}

// ── POLL ────────────────────────────────────────────────────────────────────
// Poll each event type from its LAST cursor, not a shared one.

async function pollEvents() {
  const cache = loadCache();

  for (const eventType of EVENT_TYPES) {
    try {
      const lastCursor = cache.cursors[eventType];

      const response = await client.queryEvents({
        query: { MoveEventType: eventType },
        cursor: lastCursor || undefined,
        limit: 50,
        order: 'descending',
      });

      if (response.data.length > 0) {
        const existingKeys = new Set(cache.events.map(e => `${e.id.txDigest}-${e.id.eventSeq}`));
        const newEvents = response.data.filter(e => !existingKeys.has(`${e.id.txDigest}-${e.id.eventSeq}`));

        cache.events.unshift(...newEvents);
        cache.cursors[eventType] = response.nextCursor || lastCursor;
        cache.lastUpdated = Date.now();

        console.log(`[INDEXER] [${eventType.split('::').pop()}] +${newEvents.length} events`);
      }
    } catch (err) {
      console.error(`[INDEXER] Failed to poll ${eventType}:`, err);
    }
  }

  // Cap at 1000 events
  if (cache.events.length > 1000) {
    cache.events = cache.events.slice(0, 1000);
  }

  saveCache(cache);
}

// ── EXPORTS ────────────────────────────────────────────────────────────────

export function getEventsForWallet(wallet: string): SuiEvent[] {
  const cache = loadCache();
  return cache.events.filter(e => {
    const parsed = e.parsedJson as any;
    return parsed?.wallet === wallet ||
           parsed?.team_id === wallet ||
           parsed?.member === wallet ||
           parsed?.admin === wallet;
  });
}

export function getEventsByType(eventType: string): SuiEvent[] {
  const cache = loadCache();
  return cache.events.filter(e => e.type === eventType);
}

export function getAllEvents(limit: number = 100): SuiEvent[] {
  const cache = loadCache();
  return cache.events.slice(0, limit);
}

export function getStats(): { totalEvents: number; lastUpdated: number; eventTypes: Record<string, number> } {
  const cache = loadCache();
  const types: Record<string, number> = {};
  cache.events.forEach(e => {
    types[e.type] = (types[e.type] || 0) + 1;
  });
  return {
    totalEvents: cache.events.length,
    lastUpdated: cache.lastUpdated,
    eventTypes: types,
  };
}

// ── START ────────────────────────────────────────────────────────────────────

export async function startIndexer() {
  console.log('[INDEXER] Starting...');
  await backfillEvents();
  await pollEvents();
  setInterval(pollEvents, POLL_INTERVAL);
}

// CLI mode
if (require.main === module) {
  startIndexer();
  console.log('[INDEXER] Polling every 30s. Press Ctrl+C to stop.');
}
