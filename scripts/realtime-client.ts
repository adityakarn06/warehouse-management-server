/**
 * Phase 5 verification client.
 *
 *   pnpm realtime:demo [--url http://localhost:4000] [--truck TRK-101] [--seconds 12]
 *
 * Connects two clients against a running server (`pnpm dev`): an operations
 * dashboard subscribed to the whole fleet, and a customer tracking a single
 * truck. Prints both join snapshots, then reports what each one actually
 * received — including the gap between consecutive position updates, which
 * should sit at the backend's 2-second tick.
 */

import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  LiveTruckWireView,
  ServerToClientEvents,
  SubscribeAck,
  TruckPositionPayload,
} from '../src/websocket/events.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const URL = flag('url', 'http://localhost:4000');
const TRUCK = flag('truck', 'TRK-101');
const SECONDS = positiveNumber(flag('seconds', '12'), 'seconds');

function positiveNumber(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

interface Feed {
  label: string;
  client: Client;
  positions: TruckPositionPayload[];
  statuses: number;
  etas: number;
}

/**
 * `subscribe` runs on every `connect`, not just the first. socket.io reconnects
 * with a new socket id and no room membership, so a subscription made once
 * would silently stop delivering after any transport blip.
 */
function connect(label: string, subscribe: (client: Client) => Promise<void>): Promise<Feed> {
  const client: Client = io(URL, { transports: ['websocket'] });
  const feed: Feed = { label, client, positions: [], statuses: 0, etas: 0 };

  client.on('TRUCK_POSITION_UPDATED', (data) => feed.positions.push(data));
  client.on('TRUCK_ETA_UPDATED', () => (feed.etas += 1));
  client.on('TRUCK_STATUS_CHANGED', (data) => {
    feed.statuses += 1;
    console.log(`[${label}] ${data.reference}: ${data.previousStatus} -> ${data.status}`);
  });
  client.on('ALERT_CREATED', (data) => console.log(`[${label}] ALERT ${data.severity}: ${data.title}`));

  return new Promise((resolve, reject) => {
    let ready = false;

    client.on('connect', () => {
      console.log(`[${label}] connected as ${client.id ?? '?'}`);
      subscribe(client).then(
        () => {
          if (ready) return;
          ready = true;
          resolve(feed);
        },
        (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
      );
    });
    client.on('connect_error', (error) => {
      // Only the first connection is fatal; a mid-run blip is what the
      // re-subscribe above exists to survive.
      if (!ready) reject(new Error(`${label}: ${error.message}`));
    });
  });
}

function summarise(feed: Feed, truckId?: string): void {
  const trucks = [...new Set(feed.positions.map((p) => p.truckId))].sort();
  console.log(`\n[${feed.label}]`);
  console.log(`  position events : ${feed.positions.length}`);
  console.log(`  eta events      : ${feed.etas}`);
  console.log(`  status events   : ${feed.statuses}`);
  console.log(`  distinct trucks : ${trucks.length} (${trucks.join(', ') || 'none'})`);

  // Cadence, measured on one truck's own stream — the whole point of §4.
  const target = truckId ?? trucks[0];
  const stamps = feed.positions
    .filter((p) => p.truckId === target)
    .map((p) => Date.parse(p.serverTimestamp));

  if (stamps.length < 2) {
    console.log(`  cadence         : not enough updates for ${target ?? 'any truck'}`);
    return;
  }

  const gaps = stamps.slice(1).map((stamp, index) => stamp - (stamps[index] as number));
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  console.log(
    `  cadence (${target}) : mean ${mean.toFixed(0)}ms, ` +
      `min ${Math.min(...gaps)}ms, max ${Math.max(...gaps)}ms over ${gaps.length} gap(s)`,
  );
}

async function main(): Promise<void> {
  console.log(`Connecting to ${URL} — tracking ${TRUCK} for ${SECONDS}s\n`);

  let trackedTruckId: string | undefined;

  const ops = await connect('operations', async (client) => {
    const ack = await new Promise<SubscribeAck<LiveTruckWireView[]>>((resolve) => {
      client.emit('subscribe:operations', resolve);
    });
    if (!ack.ok) throw new Error(`operations subscribe failed: ${ack.error}`);
    console.log(
      `[operations] joined ${ack.room} with a snapshot of ${ack.data.length} live truck(s): ` +
        ack.data.map((t) => `${t.reference} ${t.progress.toFixed(1)}%`).join(', '),
    );
  });

  const tracker = await connect(`tracking ${TRUCK}`, async (client) => {
    const ack = await new Promise<SubscribeAck<LiveTruckWireView | null>>((resolve) => {
      client.emit('subscribe:truck', { truckId: TRUCK }, resolve);
    });
    if (!ack.ok) throw new Error(`truck subscribe failed: ${ack.error}`);
    trackedTruckId = ack.data?.truckId;
    console.log(
      `[tracking ${TRUCK}] joined ${ack.room} with snapshot: ` +
        (ack.data
          ? `${ack.data.status} at ${ack.data.progress.toFixed(1)}%, seq ${ack.data.sequenceNumber}`
          : 'no live state'),
    );
  });

  console.log(`\nListening for ${SECONDS}s...`);
  await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));

  summarise(ops);
  // Payloads carry the canonical id, which only equals `TRUCK` because seeded
  // rows use their reference as the primary key. Prefer the id from the ack.
  summarise(tracker, trackedTruckId ?? TRUCK);

  const strayTrucks = [...new Set(tracker.positions.map((p) => p.truckId))].filter(
    (id) => id !== TRUCK && id !== trackedTruckId,
  );
  console.log(
    strayTrucks.length === 0
      ? `\nOK: the tracking client only ever saw ${TRUCK}.`
      : `\nFAIL: the tracking client also saw ${strayTrucks.join(', ')}.`,
  );

  ops.client.disconnect();
  tracker.client.disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
