import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { yardLockIdle } from '../src/docking/dock-lock.js';
import { disconnectPrisma, prisma } from '../src/lib/prisma.js';
import { beginShutdown, resetShutdownState } from '../src/lib/shutdown-state.js';
import { simulationManager } from '../src/simulation/simulation-manager.js';
import type {
  ClientToServerEvents,
  LiveTruckWireView,
  RealtimeEventType,
  ServerToClientEvents,
  SubscribeAck,
} from '../src/websocket/events.js';
import {
  closeWebsocket,
  initWebsocket,
  realtimeSimulationSink,
} from '../src/websocket/index.js';
import type { FleetSnapshot, YardSnapshot } from './docking-fixtures.js';
import { restoreFleet, restoreYard, snapshotFleet, snapshotYard } from './docking-fixtures.js';

/**
 * Phase 10 — the end-to-end integration suite.
 *
 * Every other suite cuts one seam to stay fast: the docking and WMS suites swap
 * a `RecordingSink` in for Socket.IO, and `realtime.test.ts` runs a real server
 * against a fake store and stub snapshots. Each half is well covered and the
 * join between them is not, so this file deliberately runs **all** of it at
 * once: the seeded Postgres, a real `createApp()`, a real Socket.IO server on
 * an ephemeral port, and real `socket.io-client` connections.
 *
 * What that buys is the wiring itself — that `realtimeDockingSink` resolves
 * through `tryGetRealtimeService()`, that `roomsFor` puts a reassignment in the
 * truck's *and* the shipment's room, that subscribing by `TRK-101` reaches the
 * same room as subscribing by its canonical id. None of that is exercised by
 * synthetic payloads.
 *
 * It writes to the seeded database and restores both the yard and the fleet in
 * `afterEach`, exactly as the Phase 8 and 9 suites do. `pnpm db:seed` remains
 * the reset of last resort.
 *
 * Two things are set up by hand that `src/server.ts` normally does, because
 * importing `server.ts` would bind a port and start a loop:
 *  - `initWebsocket()` on our own HTTP server, and
 *  - `simulationManager.setSink(realtimeSimulationSink())`, since the singleton
 *    is constructed with `loggerEventSink` at import time.
 * The docking and WMS sinks are deliberately left at their realtime defaults —
 * they are what this suite exists to test.
 */

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

/** A received event, kept in arrival order so room routing can be asserted. */
interface Seen {
  type: RealtimeEventType;
  data: Record<string, unknown>;
}

const REALTIME_EVENTS: RealtimeEventType[] = [
  'TRUCK_POSITION_UPDATED',
  'TRUCK_ETA_UPDATED',
  'TRUCK_STATUS_CHANGED',
  'ALERT_CREATED',
  'DOCK_STATUS_CHANGED',
  'DOCK_ASSIGNED',
  'DOCK_REASSIGNED',
];

let app: Express;
let httpServer: HttpServer;
let url: string;
let yard: YardSnapshot;
let fleet: FleetSnapshot;

const clients: TestClient[] = [];

beforeAll(async () => {
  app = createApp();
  httpServer = createServer(app);
  initWebsocket(httpServer);
  simulationManager.setSink(realtimeSimulationSink());

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  yard = await snapshotYard();
  fleet = await snapshotFleet();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  // The loop and the yard queue both outlive a single test, and either could
  // still be writing while we restore.
  await simulationManager.stop();
  await yardLockIdle();
  await restoreYard(yard);
  await restoreFleet(fleet);
  // The database is only half the world: `LiveStateStore` is the source of
  // truth between writes and survives a stop, so a truck this test delayed
  // would still be DELAYED in memory for the next one. `reset()` on a stopped
  // engine reloads from the rows we just put back.
  await simulationManager.reset();
});

afterAll(async () => {
  await closeWebsocket();
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  await disconnectPrisma();
});

// --- helpers ----------------------------------------------------------------

async function connect(): Promise<TestClient> {
  const client: TestClient = createClient(url, { transports: ['websocket'] });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.on('connect', () => resolve());
    client.on('connect_error', reject);
  });
  return client;
}

/** Records every event of the contract, so a test can assert on absence too. */
function collect(client: TestClient): Seen[] {
  const seen: Seen[] = [];
  for (const type of REALTIME_EVENTS) {
    // The event map is keyed per event; one untyped listener per name is far
    // less noise than seven typed ones that all push the same shape.
    (client as unknown as { on(name: string, fn: (data: unknown) => void): void }).on(
      type,
      (data) => seen.push({ type, data: data as Record<string, unknown> }),
    );
  }
  return seen;
}

const typesOf = (seen: Seen[]): RealtimeEventType[] => seen.map((event) => event.type);
const only = (seen: Seen[], type: RealtimeEventType): Seen[] =>
  seen.filter((event) => event.type === type);

function subscribeOperations(client: TestClient): Promise<SubscribeAck<LiveTruckWireView[]>> {
  return new Promise((resolve) => client.emit('subscribe:operations', resolve));
}

function subscribeTruck(
  client: TestClient,
  truckId: string,
): Promise<SubscribeAck<LiveTruckWireView | null>> {
  return new Promise((resolve) => client.emit('subscribe:truck', { truckId }, resolve));
}

function subscribeShipment(client: TestClient, shipmentId: string): Promise<SubscribeAck<unknown>> {
  return new Promise((resolve) =>
    client.emit('subscribe:shipment', { shipmentId }, resolve as never),
  );
}

/** Socket.IO delivery is asynchronous; give a broadcast a chance to land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

/** Starts the loop and drives exactly `count` ticks by hand — no real timers. */
async function runTicks(count: number, stepMs = simulationManager.tickMs): Promise<void> {
  await simulationManager.start();
  let now = Date.now();
  for (let i = 0; i < count; i += 1) {
    now += stepMs;
    await simulationManager.tick(now);
  }
}

// --- 1. Server, database, seed ----------------------------------------------

describe('the server, the database and the seed', () => {
  it('answers /health without touching the database', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('answers /api/v1/health/db against a live connection', async () => {
    const res = await request(app).get('/api/v1/health/db').expect(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.latencyMs).toBe('number');
  });

  it('serves the seeded demo fleet through the read API', async () => {
    const res = await request(app).get('/api/v1/trucks?limit=50').expect(200);
    expect(res.body.meta.total).toBe(12);

    const references = res.body.data.map((truck: { reference: string }) => truck.reference);
    expect(references).toContain('TRK-101');
  });

  it('serves the seeded yard overview', async () => {
    const res = await request(app).get('/api/v1/yard/overview').expect(200);
    expect(res.body.data.docks.length).toBe(8);
  });
});

// --- 2. Movement, ETA, and the wire -----------------------------------------

describe('trucks move and the movement reaches a subscriber', () => {
  it('advances progress and broadcasts positions to the operations room', async () => {
    const ops = await connect();
    await subscribeOperations(ops);
    const seen = collect(ops);

    const before = simulationManager.getTruckState('TRK-101');
    await runTicks(3);
    await settle();

    const after = simulationManager.getTruckState('TRK-101');
    expect(after).toBeDefined();
    expect(after!.progress).toBeGreaterThan(before?.progress ?? 0);

    const positions = only(seen, 'TRUCK_POSITION_UPDATED');
    expect(positions.length).toBeGreaterThan(0);
    // Every moving truck, not just the one we asked about — this is the
    // dashboard feed.
    expect(new Set(positions.map((event) => event.data.truckId)).size).toBeGreaterThan(1);
  });

  it('keeps ETA authoritative and sequence numbers strictly increasing', async () => {
    const ops = await connect();
    await subscribeOperations(ops);
    const seen = collect(ops);

    await runTicks(4);
    await settle();

    const mine = only(seen, 'TRUCK_POSITION_UPDATED').filter(
      (event) => event.data.truckId === 'TRK-101',
    );
    expect(mine.length).toBeGreaterThanOrEqual(2);

    const sequences = mine.map((event) => event.data.sequenceNumber as number);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
    }

    // ETA is an absolute instant, so what counts down is the time remaining.
    for (const event of mine) expect(typeof event.data.eta).toBe('string');
    const state = simulationManager.getTruckState('TRK-101');
    expect(state?.eta).toBeInstanceOf(Date);
  });

  it('does not write a row to the database for every tick (§24)', async () => {
    const before = await prisma.locationHistory.count();
    await runTicks(3);
    const after = await prisma.locationHistory.count();

    // Three ticks over nine moving trucks would be 27 rows if every tick wrote.
    expect(after - before).toBeLessThan(9);
  });
});

// --- 3. Room routing against seeded rows ------------------------------------

describe('room routing', () => {
  it('resolves a human reference to the same room as the canonical id', async () => {
    const byReference = await connect();
    const ack = await subscribeTruck(byReference, 'TRK-101');

    expect(ack.ok).toBe(true);
    if (!ack.ok) throw new Error('expected the truck subscribe to succeed');
    // The seed uses the human reference as the primary key, so both spellings
    // resolve to the same canonical id — and therefore the same room.
    expect(ack.room).toBe('truck:TRK-101');
    expect(ack.data?.truckId).toBe('TRK-101');
  });

  it('opens a tracking subscription with a shipment snapshot', async () => {
    const customer = await connect();
    const ack = await subscribeShipment(customer, 'SHP-1001');

    expect(ack.ok).toBe(true);
    if (!ack.ok) throw new Error('expected the shipment subscribe to succeed');
    expect(ack.room).toBe('shipment:SHP-1001');
  });

  it('refuses a subscription to a truck that does not exist, through the ack', async () => {
    const client = await connect();
    const ack = await subscribeTruck(client, 'TRK-DOES-NOT-EXIST');

    expect(ack.ok).toBe(false);
    // Answered through the ack, never by throwing — a socket handler that threw
    // would take the connection down instead of returning an error.
    expect(client.connected).toBe(true);
  });

  it('gives the customer only their own truck while operations sees the fleet', async () => {
    const ops = await connect();
    const customer = await connect();
    await subscribeOperations(ops);
    await subscribeShipment(customer, 'SHP-1001');

    const opsSeen = collect(ops);
    const customerSeen = collect(customer);

    await runTicks(2);
    await settle();

    const opsTrucks = new Set(
      only(opsSeen, 'TRUCK_POSITION_UPDATED').map((event) => event.data.truckId),
    );
    const customerTrucks = new Set(
      only(customerSeen, 'TRUCK_POSITION_UPDATED').map((event) => event.data.truckId),
    );

    expect(opsTrucks.size).toBeGreaterThan(1);
    // The tracking feed is a strict subset: TRK-101 and nothing else.
    expect([...customerTrucks]).toEqual(['TRK-101']);
  });
});

// --- 4. Delay scenarios over HTTP, observed on the wire ---------------------

describe('delay scenarios (Scenarios B and C)', () => {
  const delay = (type: string) =>
    request(app).post('/api/v1/simulation/trucks/TRK-101/delay').send({ type });

  it('slows the truck, pushes the ETA out and raises one alert', async () => {
    const ops = await connect();
    await subscribeOperations(ops);
    const seen = collect(ops);

    await runTicks(1);
    const before = simulationManager.getTruckState('TRK-101')!;

    const res = await delay('RAIN').expect(200);
    await settle();

    expect(res.body.data.truck).toMatchObject({ status: 'DELAYED', activeDelay: 'RAIN' });
    expect(res.body.data.truck.speedKmph).toBeLessThan(before.speedKmph);
    // Slower over the same remaining distance means a later arrival.
    expect(new Date(res.body.data.truck.eta).getTime()).toBeGreaterThan(before.eta!.getTime());

    expect(res.body.data.alert).toMatchObject({ type: 'TRUCK_DELAYED', severity: 'WARNING' });

    const alerts = await prisma.alert.findMany({
      where: { type: 'TRUCK_DELAYED', truckId: 'TRK-101' },
    });
    expect(alerts).toHaveLength(1);

    // All three events reach the wire, not just the response.
    expect(typesOf(seen)).toEqual(
      expect.arrayContaining(['TRUCK_ETA_UPDATED', 'TRUCK_STATUS_CHANGED', 'ALERT_CREATED']),
    );
  });

  it('slows a traffic delay harder than a rain delay', async () => {
    await runTicks(1);
    const base = simulationManager.getTruckState('TRK-101')!.speedKmph;

    const rain = await delay('RAIN').expect(200);
    const traffic = await delay('TRAFFIC').expect(200);

    expect(rain.body.data.truck.speedKmph).toBeLessThan(base);
    expect(traffic.body.data.truck.speedKmph).toBeLessThan(rain.body.data.truck.speedKmph);
  });

  it('delivers the delay alert to the customer tracking room', async () => {
    const customer = await connect();
    await subscribeShipment(customer, 'SHP-1001');
    const seen = collect(customer);

    await runTicks(1);
    await delay('TRAFFIC').expect(200);
    await settle();

    const alerts = only(seen, 'ALERT_CREATED');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ type: 'TRUCK_DELAYED', shipmentId: 'SHP-1001' });
  });

  it('restores normal running when the delay is cleared', async () => {
    await runTicks(1);
    const base = simulationManager.getTruckState('TRK-101')!.speedKmph;

    await delay('ROAD_CLOSURE').expect(200);
    const cleared = await request(app)
      .post('/api/v1/simulation/trucks/TRK-101/clear-delay')
      .expect(200);

    expect(cleared.body.data.truck).toMatchObject({ status: 'IN_TRANSIT', activeDelay: 'NORMAL' });
    expect(cleared.body.data.truck.speedKmph).toBeCloseTo(base, 5);
    // Clearing raises no alert — only the activation is a business event.
    expect(cleared.body.data.alert).toBeNull();
  });

  it('rejects an unknown delay scenario', async () => {
    await runTicks(1);
    await delay('SNOW').expect(400);
  });
});

// --- 5. Scenario D: dock failure and automatic reassignment -----------------

describe('Scenario D — dock failure and automatic reassignment', () => {
  it('moves TRK-101 from D2 to D4 and tells every relevant room', async () => {
    const ops = await connect();
    const customer = await connect();
    await subscribeOperations(ops);
    await subscribeShipment(customer, 'SHP-1001');

    const opsSeen = collect(ops);
    collect(customer);

    const res = await request(app)
      .patch('/api/v1/docks/D2/status')
      .send({ status: 'UNAVAILABLE', reason: 'Hydraulic fault' })
      .expect(200);
    await settle();

    // The backend picked the replacement, not the frontend (§2).
    expect(res.body.data.reassignments).toHaveLength(1);
    expect(res.body.data.reassignments[0]).toMatchObject({
      truckReference: 'TRK-101',
      outcome: 'REASSIGNED',
      previousDockCode: 'D2',
      newDockCode: 'D4',
    });

    // The old row is superseded and chained, not cancelled.
    const previous = await prisma.dockAssignment.findUniqueOrThrow({ where: { id: 'DA-3002' } });
    expect(previous.status).toBe('REASSIGNED');
    const replacement = await prisma.dockAssignment.findFirstOrThrow({
      where: { previousAssignmentId: 'DA-3002' },
    });
    expect(replacement).toMatchObject({ dockDoorId: 'D4', status: 'ASSIGNED' });

    // Operations sees the yard news and the move; the alert order is fixed.
    expect(typesOf(opsSeen)).toEqual(
      expect.arrayContaining(['DOCK_STATUS_CHANGED', 'DOCK_REASSIGNED', 'ALERT_CREATED']),
    );
    expect(only(opsSeen, 'ALERT_CREATED').map((event) => event.data.type)).toEqual([
      'DOCK_UNAVAILABLE',
      'DOCK_REASSIGNMENT',
    ]);
  });

  it('keeps a door outage in operations but sends the move to the tracking room', async () => {
    const customer = await connect();
    await subscribeShipment(customer, 'SHP-1001');
    const seen = collect(customer);

    await request(app).patch('/api/v1/docks/D2/status').send({ status: 'UNAVAILABLE' }).expect(200);
    await settle();

    // `roomsFor`: a dock going down is yard news and stays in `operations`; the
    // customer learns about it through the reassignment that follows.
    expect(typesOf(seen)).not.toContain('DOCK_STATUS_CHANGED');
    expect(typesOf(seen)).toContain('DOCK_REASSIGNED');

    const moved = only(seen, 'DOCK_REASSIGNED')[0]!;
    expect(moved.data).toMatchObject({ truckId: 'TRK-101', shipmentId: 'SHP-1001', dockCode: 'D4' });
  });

  it('recommends the replacement it went on to choose', async () => {
    const before = await request(app)
      .get('/api/v1/trucks/TRK-101/dock-recommendations')
      .expect(200);

    // Explainable, and the same ranking the cascade uses (§9). D2 is the door
    // TRK-101 already holds, so it is offered rather than filtered out — but D4
    // is outright AVAILABLE and carries the status bonus, so it ranks first.
    const beforeCodes = before.body.data.recommendations.map(
      (row: { dockCode: string }) => row.dockCode,
    );
    expect(beforeCodes).toContain('D2');
    expect(beforeCodes).toContain('D4');
    expect(before.body.data.recommendations[0].reasons.length).toBeGreaterThan(0);

    await request(app).patch('/api/v1/docks/D2/status').send({ status: 'UNAVAILABLE' }).expect(200);

    const after = await request(app).get('/api/v1/trucks/TRK-101/dock-recommendations').expect(200);
    const codes = after.body.data.recommendations.map((row: { dockCode: string }) => row.dockCode);
    expect(codes).not.toContain('D2');
  });
});

// --- 6. Scenario E: no replacement exists -----------------------------------

describe('Scenario E — no compatible replacement', () => {
  it('raises NO_DOCK_AVAILABLE in the truck and shipment rooms, inventing nothing', async () => {
    const customer = await connect();
    await subscribeShipment(customer, 'SHP-1001');
    const seen = collect(customer);

    // D7 is seeded out of service, so dropping D4 leaves no reefer door at all.
    await request(app).patch('/api/v1/docks/D4/status').send({ status: 'UNAVAILABLE' }).expect(200);
    const res = await request(app)
      .patch('/api/v1/docks/D2/status')
      .send({ status: 'UNAVAILABLE' })
      .expect(200);
    await settle();

    expect(res.body.data.reassignments[0]).toMatchObject({
      truckReference: 'TRK-101',
      outcome: 'NO_DOCK_AVAILABLE',
      newDockCode: null,
    });

    // The truck is left genuinely unassigned, not parked on a dead door (§10).
    expect(
      await prisma.dockAssignment.count({ where: { truckId: 'TRK-101', status: 'ASSIGNED' } }),
    ).toBe(0);

    const alerts = only(seen, 'ALERT_CREATED').filter(
      (event) => event.data.type === 'NO_DOCK_AVAILABLE',
    );
    expect(alerts).toHaveLength(1);
    // No door to point at, so the room set comes purely from truck and shipment.
    expect(alerts[0]!.data).toMatchObject({
      severity: 'CRITICAL',
      truckId: 'TRK-101',
      shipmentId: 'SHP-1001',
      dockDoorId: null,
    });
  });
});

// --- 7. Concurrency ---------------------------------------------------------

describe('two concurrent assignments never share a door', () => {
  it('commits exactly one of two simultaneous requests for the same slot', async () => {
    // Two REFRIGERATED trucks, so D4 is a valid door for both — but the seed
    // puts them nine hours apart, and a door holding two bookings that do not
    // overlap is a calendar, not a double-booking. The requested slot starts at
    // the truck's ETA, so move TRK-108's ETA and window onto TRK-101's to make
    // them genuinely contend. `restoreFleet` puts both back.
    const truck = await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-101' } });
    const window = await prisma.appointment.findUniqueOrThrow({ where: { id: 'APT-2001' } });

    await prisma.truck.update({ where: { id: 'TRK-108' }, data: { eta: truck.eta } });
    await prisma.appointment.update({
      where: { id: 'APT-2008' },
      data: { windowStart: window.windowStart, windowEnd: window.windowEnd },
    });

    const [first, second] = await Promise.allSettled([
      request(app).post('/api/v1/trucks/TRK-101/dock-assignment').send({ dockId: 'D4' }),
      request(app).post('/api/v1/trucks/TRK-108/dock-assignment').send({ dockId: 'D4' }),
    ]);

    const codes = [first, second].map((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value.status : 0,
    );

    // One wins; the loser is refused rather than silently double-booking. Which
    // one wins is a scheduling detail — that only one does is the guarantee, and
    // it is the yard lock in `src/docking/dock-lock.ts` that provides it: under
    // READ COMMITTED both `dockStillTakes` rechecks would otherwise run before
    // either INSERT committed, and both would see the door free.
    expect(codes.filter((code) => code === 201)).toHaveLength(1);
    expect(codes.some((code) => code === 400 || code === 409)).toBe(true);

    const live = await prisma.dockAssignment.findMany({
      where: { dockDoorId: 'D4', status: 'ASSIGNED' },
      select: { truckId: true },
    });
    expect(live).toHaveLength(1);
  });

  it('lets two trucks share a door at non-overlapping times', async () => {
    // The seeded windows are nine hours apart, so this is a booking calendar,
    // not a conflict — the lock serialises the writes without refusing them.
    const [first, second] = await Promise.all([
      request(app).post('/api/v1/trucks/TRK-101/dock-assignment').send({ dockId: 'D4' }),
      request(app).post('/api/v1/trucks/TRK-108/dock-assignment').send({ dockId: 'D4' }),
    ]);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(
      await prisma.dockAssignment.count({ where: { dockDoorId: 'D4', status: 'ASSIGNED' } }),
    ).toBe(2);
  });
});

// --- 8. Simulation lifecycle ------------------------------------------------

describe('simulation lifecycle', () => {
  const state = () => request(app).get('/api/v1/simulation/state');

  it('starts, reports health, and is idempotent', async () => {
    await request(app).post('/api/v1/simulation/start').expect(200);
    const again = await request(app).post('/api/v1/simulation/start').expect(200);

    // A second start must not install a second interval (§22).
    expect(again.body.data).toMatchObject({ running: true });
    expect(again.body.data.truckCount).toBe(9);
    expect(simulationManager.isRunning()).toBe(true);
  });

  it('exposes loop health on the lifecycle endpoints', async () => {
    await runTicks(1);

    // Health lives on start/stop/reset, not on GET /state — that one returns the
    // per-truck list.
    const health = await request(app).post('/api/v1/simulation/start').expect(200);
    expect(health.body.data.lastTickAt).not.toBeNull();
    expect(health.body.data.lastTickError).toBeNull();
    expect(health.body.data.tickMs).toBe(2000);
  });

  it('lists every simulated truck on GET /state', async () => {
    await runTicks(1);
    const res = await state().expect(200);

    expect(res.body.meta.total).toBe(9);
    expect(res.body.data.map((truck: { reference: string }) => truck.reference)).toContain(
      'TRK-101',
    );
  });

  it('stops, flushes, and refuses to advance afterwards', async () => {
    await runTicks(2);
    const moved = simulationManager.getTruckState('TRK-101')!.progress;

    const stopped = await request(app).post('/api/v1/simulation/stop').expect(200);
    expect(stopped.body.data.running).toBe(false);

    // A tick after stop() is ignored however it is called.
    await simulationManager.tick(Date.now() + 60_000);
    expect(simulationManager.getTruckState('TRK-101')!.progress).toBe(moved);

    // The flush wrote what memory had moved past.
    const persisted = await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-101' } });
    expect(persisted.progress).toBeCloseTo(moved, 5);
  });

  it('refuses a delay command while the loop is stopped', async () => {
    await request(app).post('/api/v1/simulation/stop').expect(200);
    await request(app).post('/api/v1/simulation/trucks/TRK-101/delay').send({ type: 'RAIN' }).expect(409);
  });

  it('absorbs a WMS fact while stopped without desyncing memory from the row', async () => {
    // The regression this guards: `stop()` does not clear `live`, and `start()`
    // only reloads when the map is empty. An external update that bailed out
    // here would send the handler down its direct-Prisma branch, leaving memory
    // saying IN_TRANSIT over a row that says ARRIVED — and the next start would
    // resume from the stale snapshot and persist it back over the arrival.
    await runTicks(1);
    await request(app).post('/api/v1/simulation/stop').expect(200);

    await request(app)
      .post('/api/v1/wms/events')
      .send({ eventType: 'TRAILER_ARRIVED', trailerId: 'TRL-102' })
      .expect(200);

    // Memory and the row agree.
    expect(simulationManager.getTruckState('TRK-102')?.status).toBe('ARRIVED');
    expect((await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-102' } })).status).toBe(
      'ARRIVED',
    );

    // And a restart does not undo it.
    await runTicks(2);
    expect((await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-102' } })).status).toBe(
      'ARRIVED',
    );
  });

  it('reset restores the world from the database', async () => {
    await runTicks(3);
    await request(app).post('/api/v1/simulation/reset').expect(200);

    const res = await request(app).get('/api/v1/simulation/state').expect(200);
    expect(res.body.meta.total).toBe(9);
  });
});

describe('releasing a door that is out of service', () => {
  // Note this does *not* reproduce the stale-read race `runReleaseDock` guards
  // against — that needs the door to flip between `findDock()` and the
  // transaction opening, which is not deterministically reachable from a test.
  // What it does pin down is the observable rule either way: releasing a broken
  // door repairs nothing and announces nothing.
  it('does not repair the door, and does not re-announce the outage', async () => {
    const ops = await connect();
    await subscribeOperations(ops);

    // Take D1 down (it is seeded OCCUPIED, holding DA-3001 for TRK-110), which
    // emits its own DOCK_STATUS_CHANGED.
    await request(app).patch('/api/v1/docks/D1/status').send({ status: 'UNAVAILABLE' }).expect(200);
    await settle();

    const seen = collect(ops);
    const res = await request(app).post('/api/v1/docks/D1/release').expect(200);
    await settle();

    // A door that is out of service stays out of service — releasing a booking
    // does not repair a broken dock...
    expect(res.body.data.status).toBe('UNAVAILABLE');
    // ...and the release must not re-announce the outage `setDockStatus` already
    // broadcast.
    expect(only(seen, 'DOCK_STATUS_CHANGED')).toHaveLength(0);
  });
});

describe('the shutdown command gate', () => {
  afterEach(() => resetShutdownState());

  it('refuses commands but keeps answering reads once shutdown begins', async () => {
    // `httpServer.close()` only refuses new *connections*; a client already
    // holding a keep-alive can still land one more request. If that request were
    // `POST /simulation/start` it would install a fresh interval after the loop
    // had stopped and flushed. This is the gate that actually prevents it.
    await request(app).post('/api/v1/simulation/start').expect(200);

    beginShutdown();

    await request(app).post('/api/v1/simulation/start').expect(503);
    await request(app)
      .patch('/api/v1/docks/D2/status')
      .send({ status: 'UNAVAILABLE' })
      .expect(503);

    // Reads are harmless on the way down and stay open.
    await request(app).get('/api/v1/trucks/TRK-101').expect(200);
    await request(app).get('/health').expect(200);
  });
});

// --- 9. The WMS feed, end to end --------------------------------------------

describe('the WMS feed reaches the same subscribers', () => {
  it('lands a trailer and mirrors it onto the shipment', async () => {
    const ops = await connect();
    await subscribeOperations(ops);
    const seen = collect(ops);

    await request(app)
      .post('/api/v1/wms/events')
      .send({ eventType: 'TRAILER_ARRIVED', trailerId: 'TRL-102' })
      .expect(200);
    await settle();

    const truck = await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-102' } });
    expect(truck.status).toBe('ARRIVED');
    // The handler mirrors the shipment on both branches, so the answer does not
    // depend on whether the loop happened to be running.
    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: 'SHP-1002' } });
    expect(shipment.status).toBe('ARRIVED');

    expect(typesOf(seen)).toContain('TRUCK_STATUS_CHANGED');
  });

  it('treats a repeated fact as a success without a second alert', async () => {
    const send = () =>
      request(app)
        .post('/api/v1/wms/events')
        .send({ eventType: 'TRAILER_ARRIVED', trailerId: 'TRL-102' })
        .expect(200);

    const first = await send();
    const second = await send();

    expect(first.body.data.applied).toBe(true);
    expect(second.body.data.applied).toBe(false);
  });

  it('rejects a malformed event at the schema', async () => {
    await request(app)
      .post('/api/v1/wms/events')
      .send({ eventType: 'TRAILER_TELEPORTED', trailerId: 'TRL-102' })
      .expect(400);
  });

  it('replays a deterministic demo scenario through the real handler', async () => {
    const res = await request(app).post('/api/v1/wms/simulate').send({}).expect(200);
    expect(res.body.data.steps.length).toBeGreaterThan(0);
    expect(res.body.data.steps.every((step: { error?: string }) => !step.error)).toBe(true);
  });
});
