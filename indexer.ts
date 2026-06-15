import { SuiClient, getFullnodeUrl, SuiEvent } from '@mysten/sui/client';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const client = new SuiClient({ url: process.env.SUI_RPC || getFullnodeUrl('testnet') });
const PACKAGE = process.env.PACKAGE_ID!;

const CACHE_FILE = join(process.cwd(), 'events-cache.json');
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

interface CachedEvents {
  lastCursor: string | null;
  events: SuiEvent[];
  lastUpdated: number;
}

function loadCache(): CachedEvents {
  if (!existsSync(CACHE_FILE)) {
    return { lastCursor: null, events: [], lastUpdated: 0 };
  }
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return { lastCursor: null, events: [], lastUpdated: 0 };
  }
}

function saveCache(cache: CachedEvents) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}



async function backfillEvents() {
  console.log('Backfilling historical events...');
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
          order: 'ascending', // oldest first
        });

        if (response.data.length > 0) {
          const existingKeys = new Set(cache.events.map(e => `${e.id.txDigest}-${e.id.eventSeq}`));
          const newEvents = response.data.filter(e => !existingKeys.has(`${e.id.txDigest}-${e.id.eventSeq}`));
          
          cache.events.push(...newEvents);
          console.log(`[${eventType.split('::').pop()}] +${newEvents.length} historical events`);
        }

        hasNext = response.hasNextPage;
        cursor = response.nextCursor;
      }
    } catch (err) {
      console.error(`Failed to backfill ${eventType}:`, err);
    }
  }

  // Sort by timestamp descending
  cache.events.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
  cache.lastUpdated = Date.now();
  saveCache(cache);
  console.log(`Backfill complete. Total events: ${cache.events.length}`);
}


async function pollEvents() {
  const cache = loadCache();
  
  for (const eventType of EVENT_TYPES) {
    try {
      const response = await client.queryEvents({
        query: { MoveEventType: eventType },
        cursor: cache.lastCursor,
        limit: 50,
        order: 'descending',
      });

      if (response.data.length > 0) {
        // Merge new events, deduplicate by tx digest + event seq
        const existingKeys = new Set(cache.events.map(e => `${e.id.txDigest}-${e.id.eventSeq}`));
        const newEvents = response.data.filter(e => !existingKeys.has(`${e.id.txDigest}-${e.id.eventSeq}`));
        
        cache.events.unshift(...newEvents);
        cache.lastCursor = response.nextCursor || cache.lastCursor;
        cache.lastUpdated = Date.now();
        
        console.log(`[${eventType.split('::').pop()}] +${newEvents.length} events`);
      }
    } catch (err) {
      console.error(`Failed to poll ${eventType}:`, err);
    }
  }

  // Keep last 1000 events to prevent unbounded growth
  if (cache.events.length > 1000) {
    cache.events = cache.events.slice(0, 1000);
  }

  saveCache(cache);
}

// Export for use in gateway
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

// Start polling
export async function startIndexer() {
  console.log('Event indexer starting...');
  await backfillEvents(); // backfill first
  pollEvents(); // then start polling
  setInterval(pollEvents, POLL_INTERVAL);
}

// CLI mode
if (require.main === module) {
  startIndexer();
  console.log('Polling every 30s. Press Ctrl+C to stop.');
}
