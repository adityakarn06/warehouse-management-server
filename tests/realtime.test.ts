import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as createClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocationSnapshotReason } from '../src/generated/prisma/enums.js';
import type { AlertRecord, CreateAlertInput } from '../src/services/alert-service.js';
import { delayMultipliersFromEnv } from '../src/simulation/delay-scenarios.js';
import type { LiveTruckState } from '../src/simulation/live-state.js';
import { clearRouteProfileCache } from '../src/simulation/route-engine.js';
import { SimulationManager } from '../src/simulation/simulation-manager.js';
import type { SimulationStore, SimulationTruckRow } from '../src/simulation/simulation-store.js';
import type {
  ClientToServerEvents,
  RealtimeEvent,
  ServerToClientEvents,
  ShipmentSnapshot,
  SubscribeAck,
  TruckPositionPayload,
} from '../src/websocket/index.js';
import {
  OPERATIONS_ROOM,
  RealtimeService,
  closeWebsocket,
  getRealtimeService,
  initWebsocket,
  shipmentRoom,
  truckRoom,
} from '../src/websocket/index.js';
import type {
  LiveTruckWireView,
  RealtimeEmitter,
  SnapshotProvider,
} from '../src/websocket/index.js';

/**
 * Phase 5 realtime tests. Three layers, none of which touch Postgres:
 *
 *  1. room routing, against a recording emitter;
 *  2. the simulation -> sink -> service seam, driving the real engine with a
 *     fake store and a hand-advanced clock (same harness shape as
 *     `simulation.test.ts`);
 *  3. an end-to-end socket test over a real Socket.IO server and two real
 *     clients on an ephemeral port, with an injected snapshot provider.
 */

// ---------------------------------------------------------------------------
// Fixtures

function positionPayload(overrides: Partial<TruckPositionPayload> = {}): TruckPositionPayload {
  return {
    truckId: 'TRK-A',
    reference: 'TRK-A',
    shipmentId: 'SHP-A',
    latitude: 20,
    longitude: 80,
    targetLatitude: 20.1,
    targetLongitude: 80,
    progress: 10,
    speedKmph: 60,
    eta: '2026-08-26T18:40:00.000Z',
    status: 'IN_TRANSIT',
    serverTimestamp: '2026-08-26T18:16:00.000Z',
    sequenceNumber: 1,
    ...overrides,
  };
}

function truckView(overrides: Partial<LiveTruckWireView> = {}): LiveTruckWireView {
  return {
    truckId: 'TRK-A',
    reference: 'TRK-A',
    routeId: 'RTE-1',
    shipmentId: 'SHP-A',
    baseSpeedKmph: 60,
    latitude: 20,
    longitude: 80,
    progress: 10,
    speedKmph: 60,
    eta: null,
    status: 'IN_TRANSIT',
    activeDelay: 'NORMAL',
    arrivedAt: null,
    lastUpdatedAt: '2026-08-26T18:16:00.000Z',
    sequenceNumber: 1,
    ...overrides,
  };
}

interface Emission {
  rooms: string[];
  event: string;
  payload: unknown;
}

class RecordingEmitter implements RealtimeEmitter {
  readonly emissions: Emission[] = [];

  to(rooms: string[]) {
    return {
      emit: (event: string, payload: unknown) => {
        this.emissions.push({ rooms, event, payload });
      },
    };
  }
}

// ---------------------------------------------------------------------------

describe('realtime room routing', () => {
  it('sends a truck position to operations, its truck room and its shipment room', () => {
    const emitter = new RecordingEmitter();
    new RealtimeService(emitter).emit({
      type: 'TRUCK_POSITION_UPDATED',
      data: positionPayload(),
    });

    expect(emitter.emissions).toHaveLength(1);
    expect(emitter.emissions[0]?.rooms).toEqual([
      OPERATIONS_ROOM,
      truckRoom('TRK-A'),
      shipmentRoom('SHP-A'),
    ]);
  });

  it('uses the event type as the wire event name', () => {
    const emitter = new RecordingEmitter();
    const service = new RealtimeService(emitter);

    const events: RealtimeEvent[] = [
      { type: 'TRUCK_POSITION_UPDATED', data: positionPayload() },
      {
        type: 'TRUCK_ETA_UPDATED',
        data: {
          truckId: 'TRK-A',
          reference: 'TRK-A',
          shipmentId: 'SHP-A',
          eta: null,
          progress: 10,
          speedKmph: 60,
          serverTimestamp: '2026-08-26T18:16:00.000Z',
          sequenceNumber: 2,
        },
      },
      {
        type: 'TRUCK_STATUS_CHANGED',
        data: {
          truckId: 'TRK-A',
          reference: 'TRK-A',
          shipmentId: 'SHP-A',
          previousStatus: 'IN_TRANSIT',
          status: 'ARRIVING',
          activeDelay: 'NORMAL',
          progress: 96,
          speedKmph: 60,
          eta: null,
          serverTimestamp: '2026-08-26T18:16:00.000Z',
          sequenceNumber: 3,
        },
      },
    ];
    for (const event of events) service.emit(event);

    expect(emitter.emissions.map((e) => e.event)).toEqual([
      'TRUCK_POSITION_UPDATED',
      'TRUCK_ETA_UPDATED',
      'TRUCK_STATUS_CHANGED',
    ]);
  });

  it('omits the shipment room for a truck carrying no shipment', () => {
    const emitter = new RecordingEmitter();
    new RealtimeService(emitter).emit({
      type: 'TRUCK_POSITION_UPDATED',
      data: positionPayload({ shipmentId: null }),
    });

    expect(emitter.emissions[0]?.rooms).toEqual([OPERATIONS_ROOM, truckRoom('TRK-A')]);
  });

  it('keeps a dock status change in the operations room', () => {
    const emitter = new RecordingEmitter();
    new RealtimeService(emitter).emit({
      type: 'DOCK_STATUS_CHANGED',
      data: {
        dockDoorId: 'D2',
        code: 'D2',
        previousStatus: 'AVAILABLE',
        status: 'UNAVAILABLE',
        serverTimestamp: '2026-08-26T18:16:00.000Z',
      },
    });

    expect(emitter.emissions[0]?.rooms).toEqual([OPERATIONS_ROOM]);
  });

  it('carries a reassignment to the truck and its customer, not just the yard', () => {
    const emitter = new RecordingEmitter();
    new RealtimeService(emitter).emit({
      type: 'DOCK_REASSIGNED',
      data: {
        assignmentId: 'DA-NEW',
        truckId: 'TRK-A',
        shipmentId: 'SHP-A',
        dockDoorId: 'D4',
        dockCode: 'D4',
        status: 'ASSIGNED',
        score: 87,
        reasons: ['Compatible with refrigerated load'],
        previousAssignmentId: 'DA-OLD',
        previousDockDoorId: 'D2',
        previousDockCode: 'D2',
        reason: 'D2 taken out of service: Hydraulic fault',
        serverTimestamp: '2026-08-26T18:16:00.000Z',
      },
    });

    // The dock going down is yard-only news; being *moved* is the truck's and
    // the customer's business too.
    expect(emitter.emissions[0]?.rooms).toEqual([
      OPERATIONS_ROOM,
      truckRoom('TRK-A'),
      shipmentRoom('SHP-A'),
    ]);
    expect(emitter.emissions[0]?.event).toBe('DOCK_REASSIGNED');
  });

  it('routes an alert to whichever entities it names', () => {
    const emitter = new RecordingEmitter();
    const service = new RealtimeService(emitter);

    const base = {
      alertId: 'ALT-1',
      type: 'DOCK_UNAVAILABLE',
      severity: 'WARNING',
      title: 'D2 unavailable',
      message: 'D2 was taken out of service',
      createdAt: '2026-08-26T18:16:00.000Z',
    } as const;

    service.emit({
      type: 'ALERT_CREATED',
      data: { ...base, truckId: null, shipmentId: null, dockDoorId: 'D2' },
    });
    service.emit({
      type: 'ALERT_CREATED',
      data: { ...base, truckId: 'TRK-A', shipmentId: 'SHP-A', dockDoorId: 'D2' },
    });

    expect(emitter.emissions[0]?.rooms).toEqual([OPERATIONS_ROOM]);
    expect(emitter.emissions[1]?.rooms).toEqual([
      OPERATIONS_ROOM,
      truckRoom('TRK-A'),
      shipmentRoom('SHP-A'),
    ]);
  });
});

// ---------------------------------------------------------------------------

const ROUTE = {
  id: 'RTE-TEST-01',
  distanceKm: 100,
  averageSpeedKmph: 60,
  geometry: [
    { latitude: 20, longitude: 80 },
    { latitude: 21, longitude: 80 },
    { latitude: 22, longitude: 80 },
    { latitude: 23, longitude: 80 },
  ],
};

function truckRow(overrides: Partial<SimulationTruckRow> = {}): SimulationTruckRow {
  return {
    id: 'TRK-A',
    reference: 'TRK-A',
    status: 'IN_TRANSIT',
    activeDelay: 'NORMAL',
    currentLatitude: 20,
    currentLongitude: 80,
    progress: 0,
    speedKmph: 60,
    eta: null,
    arrivedAt: null,
    route: ROUTE,
    shipment: { id: 'SHP-A' },
    ...overrides,
  };
}

/**
 * `createAlert` returns a Prisma row; the fakes only need something shaped like
 * one. Ids are sequential so a test can assert two distinct alerts.
 */
let alertSeq = 0;
function fakeAlertRecord(input: CreateAlertInput): AlertRecord {
  alertSeq += 1;
  return {
    id: `ALERT-${alertSeq}`,
    type: input.type,
    severity: input.severity,
    title: input.title,
    message: input.message,
    truckId: input.truckId ?? null,
    shipmentId: input.shipmentId ?? null,
    dockDoorId: input.dockDoorId ?? null,
    metadata: (input.metadata ?? null) as AlertRecord['metadata'],
    acknowledged: false,
    acknowledgedAt: null,
    createdAt: new Date('2026-08-26T18:16:00.000Z'),
  };
}

class NoopStore implements SimulationStore {
  constructor(private readonly rows: SimulationTruckRow[]) {}

  async loadTrucks(): Promise<SimulationTruckRow[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  async persist(_state: LiveTruckState, _reason: LocationSnapshotReason | null): Promise<void> {
    // The realtime tests do not care where rows land.
  }

  async restoreTrucks(_rows: SimulationTruckRow[]): Promise<void> {
    // Nor where a reset puts them back.
  }

  async createAlert(input: CreateAlertInput): Promise<AlertRecord> {
    return fakeAlertRecord(input);
  }
}

describe('simulation -> realtime sink', () => {
  beforeEach(() => {
    clearRouteProfileCache();
  });

  it('emits one position event per moving truck per tick, through the service', async () => {
    const emitter = new RecordingEmitter();
    const service = new RealtimeService(emitter);

    let clock = 1_700_000_000_000;
    const manager = new SimulationManager({
      store: new NoopStore([truckRow(), truckRow({ id: 'TRK-B', reference: 'TRK-B', shipment: null })]),
      sink: service.asSimulationEventSink(),
      now: () => clock,
      tickMs: 2000,
      speedMultiplier: 1,
      arrivingProgress: 95,
      checkpointStep: 5,
  delayMultipliers: delayMultipliersFromEnv,
    });

    await manager.start();
    clock += 2000;
    await manager.tick();
    clock += 2000;
    await manager.tick();
    await manager.stop();

    const positions = emitter.emissions.filter((e) => e.event === 'TRUCK_POSITION_UPDATED');
    expect(positions).toHaveLength(4);
    expect(positions.filter((e) => e.rooms.includes(truckRoom('TRK-A')))).toHaveLength(2);
    expect(positions.filter((e) => e.rooms.includes(truckRoom('TRK-B')))).toHaveLength(2);
    // TRK-B carries no shipment, so no shipment room is involved for it.
    expect(positions.filter((e) => e.rooms.includes(shipmentRoom('SHP-A')))).toHaveLength(2);
  });

  it('keeps realtime payloads lean — no route geometry on the wire', async () => {
    const emitter = new RecordingEmitter();
    const service = new RealtimeService(emitter);

    let clock = 1_700_000_000_000;
    const manager = new SimulationManager({
      store: new NoopStore([truckRow()]),
      sink: service.asSimulationEventSink(),
      now: () => clock,
      tickMs: 2000,
      speedMultiplier: 1,
      arrivingProgress: 95,
      checkpointStep: 5,
  delayMultipliers: delayMultipliersFromEnv,
    });

    await manager.start();
    clock += 2000;
    await manager.tick();
    await manager.stop();

    const payloads = JSON.stringify(emitter.emissions.map((e) => e.payload));
    expect(payloads).not.toContain('geometry');
    expect(payloads).not.toContain('driverName');
  });

  it('emits nothing for a stationary truck', async () => {
    const emitter = new RecordingEmitter();
    const service = new RealtimeService(emitter);

    let clock = 1_700_000_000_000;
    const manager = new SimulationManager({
      store: new NoopStore([truckRow({ speedKmph: 0 })]),
      sink: service.asSimulationEventSink(),
      now: () => clock,
      tickMs: 2000,
      speedMultiplier: 1,
      arrivingProgress: 95,
      checkpointStep: 5,
  delayMultipliers: delayMultipliersFromEnv,
    });

    await manager.start();
    clock += 2000;
    await manager.tick();
    await manager.stop();

    expect(emitter.emissions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

const TRUCKS: Record<string, LiveTruckWireView> = {
  'TRK-A': truckView(),
  'TRK-B': truckView({ truckId: 'TRK-B', reference: 'TRK-B', shipmentId: 'SHP-B' }),
};

// A truck reachable by a second name, the way a runtime cuid id and its
// `TRK-…` reference both resolve to one truck.
const TRUCK_ALIASES: Record<string, string> = { 'trk-a-cuid': 'TRK-A' };

const stubSnapshots: SnapshotProvider = {
  async operations() {
    return Object.values(TRUCKS);
  },
  async truck(idOrReference) {
    return TRUCKS[TRUCK_ALIASES[idOrReference] ?? idOrReference] ?? null;
  },
  async shipment(idOrReference) {
    const truck = Object.values(TRUCKS).find((t) => t.shipmentId === idOrReference);
    return truck === undefined ? null : { shipmentId: idOrReference, truck };
  },
};

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

describe('socket server end to end', () => {
  let httpServer: HttpServer;
  let url: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    httpServer = createServer();
    initWebsocket(httpServer, { snapshots: stubSnapshots });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    await closeWebsocket();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  async function connect(): Promise<TestClient> {
    const client: TestClient = createClient(url, { transports: ['websocket'] });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });
    return client;
  }

  function collect(client: TestClient): TruckPositionPayload[] {
    const seen: TruckPositionPayload[] = [];
    client.on('TRUCK_POSITION_UPDATED', (data) => seen.push(data));
    return seen;
  }

  /** Resolves after both clients have had a chance to receive a broadcast. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('lets two clients connect and subscribe to different feeds', async () => {
    const ops = await connect();
    const tracker = await connect();

    const opsAck = await new Promise<SubscribeAck<LiveTruckWireView[]>>((resolve) => {
      ops.emit('subscribe:operations', resolve);
    });
    const trackerAck = await new Promise<SubscribeAck<LiveTruckWireView | null>>((resolve) => {
      tracker.emit('subscribe:truck', { truckId: 'TRK-A' }, resolve);
    });

    expect(opsAck.ok).toBe(true);
    expect(trackerAck.ok).toBe(true);
    expect(ops.id).not.toBe(tracker.id);
  });

  it('answers a subscribe with the current state immediately', async () => {
    const ops = await connect();

    const ack = await new Promise<SubscribeAck<LiveTruckWireView[]>>((resolve) => {
      ops.emit('subscribe:operations', resolve);
    });

    expect(ack).toMatchObject({ ok: true, room: OPERATIONS_ROOM });
    if (!ack.ok) throw new Error('expected the operations subscribe to succeed');
    expect(ack.data.map((t) => t.truckId).sort()).toEqual(['TRK-A', 'TRK-B']);
  });

  it('gives operations every truck and a tracking client only its own', async () => {
    const ops = await connect();
    const tracker = await connect();

    await new Promise((resolve) => ops.emit('subscribe:operations', resolve));
    await new Promise((resolve) => tracker.emit('subscribe:truck', { truckId: 'TRK-A' }, resolve));

    const opsSeen = collect(ops);
    const trackerSeen = collect(tracker);

    const service = getRealtimeService();
    service.emit({ type: 'TRUCK_POSITION_UPDATED', data: positionPayload() });
    service.emit({
      type: 'TRUCK_POSITION_UPDATED',
      data: positionPayload({ truckId: 'TRK-B', reference: 'TRK-B', shipmentId: 'SHP-B' }),
    });
    await settle();

    expect(opsSeen.map((p) => p.truckId).sort()).toEqual(['TRK-A', 'TRK-B']);
    expect(trackerSeen.map((p) => p.truckId)).toEqual(['TRK-A']);
  });

  it('delivers one copy to a client subscribed to two overlapping rooms', async () => {
    const client = await connect();
    await new Promise((resolve) => client.emit('subscribe:operations', resolve));
    await new Promise((resolve) => client.emit('subscribe:truck', { truckId: 'TRK-A' }, resolve));

    const seen = collect(client);
    getRealtimeService().emit({ type: 'TRUCK_POSITION_UPDATED', data: positionPayload() });
    await settle();

    expect(seen).toHaveLength(1);
  });

  it('subscribes a customer by shipment and returns that shipment snapshot', async () => {
    const tracker = await connect();

    const ack = await new Promise<SubscribeAck<ShipmentSnapshot>>((resolve) => {
      tracker.emit('subscribe:shipment', { shipmentId: 'SHP-A' }, resolve);
    });

    expect(ack).toMatchObject({ ok: true, room: shipmentRoom('SHP-A') });
    if (!ack.ok) throw new Error('expected the shipment subscribe to succeed');
    expect(ack.data.truck?.truckId).toBe('TRK-A');

    const seen = collect(tracker);
    getRealtimeService().emit({ type: 'TRUCK_POSITION_UPDATED', data: positionPayload() });
    getRealtimeService().emit({
      type: 'TRUCK_POSITION_UPDATED',
      data: positionPayload({ truckId: 'TRK-B', reference: 'TRK-B', shipmentId: 'SHP-B' }),
    });
    await settle();

    expect(seen.map((p) => p.truckId)).toEqual(['TRK-A']);
  });

  it('stops delivering after unsubscribe', async () => {
    const tracker = await connect();
    await new Promise((resolve) => tracker.emit('subscribe:truck', { truckId: 'TRK-A' }, resolve));

    const seen = collect(tracker);
    getRealtimeService().emit({ type: 'TRUCK_POSITION_UPDATED', data: positionPayload() });
    await settle();
    expect(seen).toHaveLength(1);

    await new Promise((resolve) => tracker.emit('unsubscribe:truck', { truckId: 'TRK-A' }, resolve));
    getRealtimeService().emit({ type: 'TRUCK_POSITION_UPDATED', data: positionPayload() });
    await settle();

    expect(seen).toHaveLength(1);
  });

  it('unsubscribes from the room it joined, even when the id no longer resolves', async () => {
    const tracker = await connect();

    // Joined by alias, so the socket is in `truck:TRK-A`, not `truck:trk-a-cuid`.
    const ack = await new Promise<SubscribeAck<LiveTruckWireView | null>>((resolve) => {
      tracker.emit('subscribe:truck', { truckId: 'trk-a-cuid' }, resolve);
    });
    expect(ack).toMatchObject({ ok: true, room: truckRoom('TRK-A') });

    // The lookup stops working — a resolved-at-unsubscribe room would now be
    // `truck:trk-a-cuid` and the socket would silently stay subscribed.
    delete TRUCK_ALIASES['trk-a-cuid'];
    try {
      const leave = await new Promise<SubscribeAck<null>>((resolve) => {
        tracker.emit('unsubscribe:truck', { truckId: 'trk-a-cuid' }, resolve);
      });
      expect(leave).toMatchObject({ ok: true, room: truckRoom('TRK-A') });
    } finally {
      TRUCK_ALIASES['trk-a-cuid'] = 'TRK-A';
    }

    const seen = collect(tracker);
    getRealtimeService().emit({ type: 'TRUCK_POSITION_UPDATED', data: positionPayload() });
    await settle();

    expect(seen).toHaveLength(0);
  });

  it('rejects an unknown truck and an invalid payload without dropping the socket', async () => {
    const client = await connect();

    const unknown = await new Promise<SubscribeAck<LiveTruckWireView | null>>((resolve) => {
      client.emit('subscribe:truck', { truckId: 'TRK-NOPE' }, resolve);
    });
    expect(unknown).toEqual({ ok: false, error: 'Truck TRK-NOPE was not found' });

    const invalid = await new Promise<SubscribeAck<LiveTruckWireView | null>>((resolve) => {
      // A frontend that forgets the payload must get an ack, not a dead socket.
      client.emit('subscribe:truck', {} as { truckId: string }, resolve);
    });
    expect(invalid).toEqual({ ok: false, error: 'truckId is required' });

    expect(client.connected).toBe(true);
  });
});
