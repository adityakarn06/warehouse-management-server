import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocationSnapshotReason } from '../src/generated/prisma/enums.js';
import { calculateEta, distanceTravelledKm } from '../src/eta/eta-engine.js';
import type { LiveTruckState } from '../src/simulation/live-state.js';
import { toLiveTruckView } from '../src/simulation/live-state.js';
import {
  buildRouteProfile,
  clearRouteProfileCache,
  pointAtProgress,
  progressAfterKm,
  remainingKm,
} from '../src/simulation/route-engine.js';
import { SimulationManager } from '../src/simulation/simulation-manager.js';
import type { SimulationEvent, SimulationEventSink } from '../src/simulation/simulation-events.js';
import type { SimulationStore, SimulationTruckRow } from '../src/simulation/simulation-store.js';

/**
 * Pure engine tests: no database, no real timers. The manager takes every
 * dependency by injection, so these drive the real simulation code against
 * in-memory fakes and a hand-advanced clock.
 *
 * `tests/read-api.test.ts` is the suite that talks to Postgres; nothing here
 * touches it.
 */

// A straight ~4-point route. Declared distance is 100 km so progress maths is
// easy to reason about: 1 km travelled == 1% progress.
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
    id: 'TRK-TEST',
    reference: 'TRK-TEST',
    status: 'IN_TRANSIT',
    activeDelay: 'NORMAL',
    currentLatitude: 20,
    currentLongitude: 80,
    progress: 0,
    speedKmph: 60,
    eta: null,
    arrivedAt: null,
    route: ROUTE,
    shipment: { id: 'SHP-TEST' },
    ...overrides,
  };
}

interface PersistCall {
  truckId: string;
  progress: number;
  status: string;
  reason: LocationSnapshotReason | null;
}

class FakeStore implements SimulationStore {
  loadCount = 0;
  readonly persisted: PersistCall[] = [];

  constructor(private readonly rows: SimulationTruckRow[]) {}

  async loadTrucks(): Promise<SimulationTruckRow[]> {
    this.loadCount += 1;
    // A real load awaits the database; the yield here is what makes the
    // concurrent-start test exercise the window between the guard and the
    // interval being installed.
    await Promise.resolve();
    return this.rows.map((row) => ({ ...row }));
  }

  async persist(state: LiveTruckState, reason: LocationSnapshotReason | null): Promise<void> {
    this.persisted.push({
      truckId: state.truckId,
      progress: state.progress,
      status: state.status,
      reason,
    });
  }
}

class FakeSink implements SimulationEventSink {
  readonly events: SimulationEvent[] = [];

  emit(event: SimulationEvent): void {
    this.events.push(event);
  }

  ofType<T extends SimulationEvent['type']>(type: T): Extract<SimulationEvent, { type: T }>[] {
    return this.events.filter(
      (event): event is Extract<SimulationEvent, { type: T }> => event.type === type,
    );
  }
}

const TICK_MS = 2000;

interface Harness {
  manager: SimulationManager;
  store: FakeStore;
  sink: FakeSink;
  /** Advance the clock by `ms` and run one tick. */
  advance: (ms?: number) => Promise<void>;
}

function harness(rows: SimulationTruckRow[] = [truckRow()], checkpointStep = 5): Harness {
  const store = new FakeStore(rows);
  const sink = new FakeSink();
  let clock = 1_700_000_000_000;

  const manager = new SimulationManager({
    store,
    sink,
    now: () => clock,
    tickMs: TICK_MS,
    speedMultiplier: 1,
    arrivingProgress: 95,
    checkpointStep,
  });

  return {
    manager,
    store,
    sink,
    advance: async (ms = TICK_MS) => {
      clock += ms;
      await manager.tick();
    },
  };
}

/** Progress on this fixture only moves ~0.03% per 2s tick, so lean on big jumps. */
const ONE_HOUR = 3_600_000;

describe('route engine', () => {
  beforeEach(() => clearRouteProfileCache());

  it('places a truck at the origin, midpoint and destination', () => {
    const profile = buildRouteProfile(ROUTE);

    expect(pointAtProgress(profile, 0)).toEqual({ latitude: 20, longitude: 80 });
    expect(pointAtProgress(profile, 100)).toEqual({ latitude: 23, longitude: 80 });

    const middle = pointAtProgress(profile, 50);
    expect(middle.latitude).toBeCloseTo(21.5, 3);
    expect(middle.longitude).toBeCloseTo(80, 6);
  });

  it('moves monotonically along the polyline and clamps out-of-range progress', () => {
    const profile = buildRouteProfile(ROUTE);

    let previous = -Infinity;
    for (let progress = 0; progress <= 100; progress += 5) {
      const { latitude } = pointAtProgress(profile, progress);
      expect(latitude).toBeGreaterThanOrEqual(previous);
      previous = latitude;
    }

    expect(pointAtProgress(profile, -20)).toEqual(pointAtProgress(profile, 0));
    expect(pointAtProgress(profile, 500)).toEqual(pointAtProgress(profile, 100));
  });

  it('converts kilometres to progress against the declared road distance', () => {
    const profile = buildRouteProfile(ROUTE);

    expect(progressAfterKm(profile, 0, 25)).toBeCloseTo(25, 6);
    expect(progressAfterKm(profile, 90, 25)).toBe(100); // clamped
    expect(remainingKm(profile, 62)).toBeCloseTo(38, 6);
  });

  it('rejects malformed geometry rather than simulating into nowhere', () => {
    expect(() => buildRouteProfile({ ...ROUTE, id: 'BAD', geometry: 'nope' })).toThrow(
      /geometry/i,
    );
  });

  it('parses and measures each route only once', () => {
    const first = buildRouteProfile(ROUTE);
    const second = buildRouteProfile(ROUTE);
    expect(second).toBe(first);
  });
});

describe('eta engine', () => {
  const now = new Date('2026-08-26T12:00:00.000Z');

  it('returns no ETA for a stationary truck', () => {
    expect(calculateEta({ remainingKm: 50, speedKmph: 0, now })).toBeNull();
  });

  it('halving the speed doubles the remaining time', () => {
    const fast = calculateEta({ remainingKm: 120, speedKmph: 60, now });
    const slow = calculateEta({ remainingKm: 120, speedKmph: 30, now });

    expect(fast?.getTime()).toBe(now.getTime() + 2 * ONE_HOUR);
    expect(slow?.getTime()).toBe(now.getTime() + 4 * ONE_HOUR);
  });

  it('derives distance from elapsed time, not from a step count', () => {
    expect(distanceTravelledKm(60, ONE_HOUR)).toBeCloseTo(60, 6);
    expect(distanceTravelledKm(60, TICK_MS)).toBeCloseTo(60 / 1800, 6);
    expect(distanceTravelledKm(0, ONE_HOUR)).toBe(0);
  });
});

describe('simulation manager', () => {
  beforeEach(() => clearRouteProfileCache());

  it('advances progress on every tick', async () => {
    const h = harness();
    await h.manager.start();

    const readings: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await h.advance(ONE_HOUR / 6); // 10 km at 60 km/h => +10% progress
      readings.push(h.manager.getTruckState('TRK-TEST')?.progress ?? 0);
    }

    expect(readings).toEqual([...readings].sort((a, b) => a - b));
    expect(readings[0]).toBeCloseTo(10, 4);
    expect(readings[3]).toBeCloseTo(40, 4);

    await h.manager.stop();
  });

  it('moves the truck and reports the previous position for interpolation', async () => {
    const h = harness();
    await h.manager.start();

    await h.advance(ONE_HOUR / 6);
    const first = h.manager.getTruckState('TRK-TEST');
    expect(first?.latitude).toBeGreaterThan(20);
    // The very first tick has a previous position too: the loaded snapshot.
    expect(first?.previousLatitude).toBe(20);

    await h.advance(ONE_HOUR / 6);
    const second = h.manager.getTruckState('TRK-TEST');
    expect(second?.latitude).toBeGreaterThan(first?.latitude ?? 0);
    expect(second?.previousLatitude).toBe(first?.latitude);
    expect(second?.sequenceNumber).toBe((first?.sequenceNumber ?? 0) + 1);

    const positions = h.sink.ofType('TRUCK_POSITION_UPDATED');
    expect(positions).toHaveLength(2);
    // Every payload carries an interpolation target ahead of the current point.
    expect(positions[1]?.data.targetLatitude).toBeGreaterThan(positions[1]?.data.latitude ?? 0);
    // …and nothing heavy: no route geometry on the wire.
    expect(JSON.stringify(positions)).not.toContain('geometry');

    await h.manager.stop();
  });

  it('counts the ETA down while holding the arrival time steady', async () => {
    const h = harness();
    await h.manager.start();

    await h.advance(ONE_HOUR / 6);
    const first = h.manager.getTruckState('TRK-TEST');
    await h.advance(ONE_HOUR / 6);
    const second = h.manager.getTruckState('TRK-TEST');

    expect(first?.eta).toBeInstanceOf(Date);
    expect(second?.eta).toBeInstanceOf(Date);

    // Time *remaining* shrinks every tick...
    const firstRemaining = first!.eta!.getTime() - first!.lastUpdatedAt.getTime();
    const secondRemaining = second!.eta!.getTime() - second!.lastUpdatedAt.getTime();
    expect(secondRemaining).toBeLessThan(firstRemaining);

    // ...while the absolute arrival instant holds, because the truck is keeping
    // to the speed the ETA was calculated from. A wandering ETA under constant
    // speed would mean the engine was guessing.
    expect(second!.eta!.getTime()).toBe(first!.eta!.getTime());
    // Only the first tick emits: it turned the loaded row's null ETA into a
    // real one. A steady ETA afterwards produces no further noise.
    expect(h.sink.ofType('TRUCK_ETA_UPDATED')).toHaveLength(1);

    await h.manager.stop();
  });

  it('recalculates the ETA from the speed actually being driven', async () => {
    // Same route, half the speed: twice the journey, so an arrival time an hour
    // later than the fast truck's.
    const fast = harness([truckRow({ speedKmph: 60 })]);
    const slow = harness([truckRow({ speedKmph: 30 })]);
    await fast.manager.start();
    await slow.manager.start();

    await fast.advance(TICK_MS);
    await slow.advance(TICK_MS);

    const fastState = fast.manager.getTruckState('TRK-TEST');
    const slowState = slow.manager.getTruckState('TRK-TEST');
    const fastRemaining = fastState!.eta!.getTime() - fastState!.lastUpdatedAt.getTime();
    const slowRemaining = slowState!.eta!.getTime() - slowState!.lastUpdatedAt.getTime();

    // 100 km at 60 km/h is 1h40m, less the sliver already driven in one tick.
    expect(fastRemaining).toBeCloseTo((100 / 60) * ONE_HOUR, -4);
    expect(slowRemaining / fastRemaining).toBeCloseTo(2, 2);

    await fast.manager.stop();
    await slow.manager.stop();
  });

  it('eventually reaches the destination and then stays put', async () => {
    const h = harness();
    await h.manager.start();

    // 1 km (== 1% here) per step, so the truck passes through the ARRIVING band
    // rather than jumping over it.
    for (let i = 0; i < 200 && h.manager.getTruckState('TRK-TEST')?.status !== 'ARRIVED'; i += 1) {
      await h.advance(ONE_HOUR / 60);
    }

    const arrived = h.manager.getTruckState('TRK-TEST');
    expect(arrived?.status).toBe('ARRIVED');
    expect(arrived?.progress).toBe(100);
    expect(arrived?.speedKmph).toBe(0);
    expect(arrived?.arrivedAt).toBeInstanceOf(Date);
    expect(arrived?.latitude).toBeCloseTo(23, 6);

    // It passed through ARRIVING on the way, and both transitions were persisted.
    const reasons = h.store.persisted.map((call) => call.reason);
    expect(reasons).toContain('ARRIVING');
    expect(reasons).toContain('ARRIVED');

    const statuses = h.sink.ofType('TRUCK_STATUS_CHANGED').map((event) => event.data.status);
    expect(statuses).toEqual(['ARRIVING', 'ARRIVED']);

    // Arrival collapses the ETA to "now", which is an ETA change worth emitting.
    expect(h.sink.ofType('TRUCK_ETA_UPDATED').length).toBeGreaterThan(0);

    // Further ticks are no-ops — a terminal truck is never advanced again.
    const sequenceAtArrival = arrived?.sequenceNumber;
    const writesAtArrival = h.store.persisted.length;
    await h.advance(ONE_HOUR);
    await h.advance(ONE_HOUR);
    expect(h.manager.getTruckState('TRK-TEST')?.sequenceNumber).toBe(sequenceAtArrival);
    expect(h.store.persisted).toHaveLength(writesAtArrival);

    await h.manager.stop();
  });

  it('never writes a row per tick', async () => {
    // 5% checkpoint step; each tick covers 0.03% at 60 km/h on a 100 km route.
    const h = harness([truckRow()], 5);
    await h.manager.start();

    for (let i = 0; i < 30; i += 1) await h.advance();

    expect(h.store.persisted).toHaveLength(0);
    expect(h.manager.getTruckState('TRK-TEST')?.progress).toBeGreaterThan(0);

    await h.manager.stop();
  });

  it('checkpoints once the truck has covered the checkpoint step', async () => {
    const h = harness([truckRow()], 5);
    await h.manager.start();

    await h.advance(ONE_HOUR / 6); // +10% — past the 5% step
    expect(h.store.persisted).toHaveLength(1);
    expect(h.store.persisted[0]?.reason).toBe('PERIODIC');

    await h.advance(TICK_MS); // a hair of progress — no write
    expect(h.store.persisted).toHaveLength(1);

    await h.manager.stop();
  });

  it('flushes unpersisted movement on stop', async () => {
    const h = harness([truckRow()], 5);
    await h.manager.start();

    await h.advance(TICK_MS);
    expect(h.store.persisted).toHaveLength(0);

    await h.manager.stop();
    expect(h.store.persisted).toHaveLength(1);
    expect(h.store.persisted[0]?.reason).toBeNull();
  });

  it('leaves terminal trucks alone', async () => {
    const h = harness([
      truckRow({ id: 'TRK-DONE', reference: 'TRK-DONE', status: 'COMPLETED', progress: 100, speedKmph: 0 }),
      truckRow(),
    ]);
    await h.manager.start();

    await h.advance(ONE_HOUR);

    const done = h.manager.getTruckState('TRK-DONE');
    expect(done?.progress).toBe(100);
    expect(done?.sequenceNumber).toBe(0);
    expect(h.store.persisted.map((call) => call.truckId)).not.toContain('TRK-DONE');

    await h.manager.stop();
  });

it('does not install a second loop when two starts race', async () => {
    const h = harness();
    const spy = vi.spyOn(globalThis, 'setInterval');

    try {
      // Both callers pass the "already running?" check before either has
      // finished loading. Only one may end up owning an interval — a second
      // would be unreachable by stop() and would double every truck's speed.
      await Promise.all([h.manager.start(), h.manager.start(), h.manager.start()]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }

    expect(h.store.loadCount).toBe(1);
    await h.advance(ONE_HOUR / 6);
    expect(h.sink.ofType('TRUCK_POSITION_UPDATED')).toHaveLength(1);

    await h.manager.stop();
    expect(h.manager.isRunning()).toBe(false);
  });

  it('does not bill a truck for the time the simulation was paused', async () => {
    const h = harness();
    await h.manager.start();

    await h.advance(TICK_MS);
    const beforePause = h.manager.getTruckState('TRK-TEST')!.progress;

    await h.manager.stop();
    await h.advance(ONE_HOUR); // an hour passes; a stopped loop must not advance
    expect(h.manager.getTruckState('TRK-TEST')!.progress).toBe(beforePause);

    await h.manager.start();
    await h.advance(TICK_MS);

    // One tick's worth of movement, not an hour's: the truck must not teleport
    // (far enough down a real route, straight to ARRIVED and into the database).
    const afterResume = h.manager.getTruckState('TRK-TEST')!.progress;
    expect(afterResume - beforePause).toBeCloseTo(beforePause, 4);
    expect(h.manager.getTruckState('TRK-TEST')?.status).toBe('IN_TRANSIT');

    await h.manager.stop();
  });

  it('says nothing about a truck that has not moved', async () => {
    const h = harness([truckRow({ speedKmph: 0 })]);
    await h.manager.start();

    for (let i = 0; i < 5; i += 1) await h.advance();

    // Still flagged IN_TRANSIT but stationary: no events, no sequence churn,
    // and nothing to flush.
    expect(h.sink.events).toHaveLength(0);
    expect(h.manager.getTruckState('TRK-TEST')?.sequenceNumber).toBe(0);

    await h.manager.stop();
    expect(h.store.persisted).toHaveLength(0);
  });

  it('loads the rest of the fleet when one route is unusable', async () => {
    const h = harness([
      truckRow({ id: 'TRK-BAD', reference: 'TRK-BAD', route: { ...ROUTE, id: 'RTE-BAD', geometry: null } }),
      truckRow(),
    ]);
    await h.manager.start();

    // The bad truck is skipped, not fatal — a half-loaded world would stay that
    // way, since start() only reloads when the map is empty.
    expect(h.manager.getTruckState('TRK-BAD')).toBeUndefined();
    expect(h.manager.truckCount).toBe(1);

    await h.advance(ONE_HOUR / 6);
    expect(h.manager.getTruckState('TRK-TEST')?.progress).toBeCloseTo(10, 4);

    await h.manager.stop();
  });

  it('keeps engine bookkeeping out of the public view', async () => {
    const h = harness();
    await h.manager.start();
    await h.advance(TICK_MS);

    const view = toLiveTruckView(h.manager.getTruckState('TRK-TEST')!);
    expect(view).not.toHaveProperty('lastPersistedProgress');
    expect(view).not.toHaveProperty('dirty');
    // …while everything the frontend needs survives.
    expect(view).toMatchObject({
      truckId: 'TRK-TEST',
      reference: 'TRK-TEST',
      routeId: 'RTE-TEST-01',
      status: 'IN_TRANSIT',
    });
    expect(view.sequenceNumber).toBeGreaterThan(0);
    expect(view.eta).toBeInstanceOf(Date);

    await h.manager.stop();
  });

  it('resolves live state by id or by human reference', async () => {
    const h = harness([truckRow({ id: 'ckq123', reference: 'TRK-777' })]);
    await h.manager.start();

    expect(h.manager.getTruckState('ckq123')?.reference).toBe('TRK-777');
    expect(h.manager.getTruckState('TRK-777')?.truckId).toBe('ckq123');
    expect(h.manager.getTruckState('nope')).toBeUndefined();

    await h.manager.stop();
  });
});

describe('simulation lifecycle', () => {
  beforeEach(() => clearRouteProfileCache());

  it('is safe to start and stop repeatedly', async () => {
    const h = harness();

    await h.manager.start();
    expect(h.manager.isRunning()).toBe(true);

    await h.manager.stop();
    expect(h.manager.isRunning()).toBe(false);

    await h.manager.stop(); // second stop is a no-op
    expect(h.manager.isRunning()).toBe(false);

    await h.manager.start();
    expect(h.manager.isRunning()).toBe(true);
    await h.manager.stop();
  });

  it('does not create a second loop on a duplicate start', async () => {
    const h = harness();

    await h.manager.start();
    await h.manager.start();
    await h.manager.start();

    // The database was read once; a second loop would have reloaded it.
    expect(h.store.loadCount).toBe(1);
    expect(h.manager.truckCount).toBe(1);

    // One tick still produces exactly one position event per truck.
    await h.advance(ONE_HOUR / 6);
    expect(h.sink.ofType('TRUCK_POSITION_UPDATED')).toHaveLength(1);

    // And a single stop() really stops it.
    await h.manager.stop();
    expect(h.manager.isRunning()).toBe(false);
  });

  it('serialises lifecycle operations that overlap', async () => {
    const h = harness();
    await h.manager.start();
    await h.advance(TICK_MS);

    // start/stop/reset all await the database, so overlapping calls must queue
    // rather than interleave — a stop must not flush over a world a start has
    // just rebuilt, and reset's stop-wipe-start must not be torn apart.
    await Promise.all([h.manager.stop(), h.manager.start(), h.manager.stop()]);
    expect(h.manager.isRunning()).toBe(false);

    await Promise.all([h.manager.start(), h.manager.reset(), h.manager.start()]);
    expect(h.manager.isRunning()).toBe(true);
    expect(h.manager.truckCount).toBe(1);

    // And the surviving loop is a single one.
    const before = h.manager.getTruckState('TRK-TEST')!.sequenceNumber;
    await h.advance(TICK_MS);
    expect(h.manager.getTruckState('TRK-TEST')?.sequenceNumber).toBe(before + 1);

    await h.manager.stop();
  });

  it('reloads the world on reset', async () => {
    const h = harness();
    await h.manager.start();
    await h.advance(ONE_HOUR / 6);
    expect(h.manager.getTruckState('TRK-TEST')?.progress).toBeCloseTo(10, 4);

    const sequenceBefore = h.manager.getTruckState('TRK-TEST')!.sequenceNumber;
    expect(sequenceBefore).toBeGreaterThan(0);

    await h.manager.reset();

    expect(h.store.loadCount).toBe(2);
    expect(h.manager.isRunning()).toBe(true);
    // Back to whatever the store reports — the fake still hands out progress 0.
    expect(h.manager.getTruckState('TRK-TEST')?.progress).toBe(0);
    // The sequence counter is per-run bookkeeping a connected client uses to
    // drop stale updates, so a reset must not rewind it under that client.
    expect(h.manager.getTruckState('TRK-TEST')?.sequenceNumber).toBe(sequenceBefore);

    await h.manager.stop();
  });

  it('a reset of a stopped simulation reloads without starting the loop', async () => {
    const h = harness();
    await h.manager.start();
    await h.advance(ONE_HOUR / 6);
    await h.manager.stop();

    await h.manager.reset();

    expect(h.manager.isRunning()).toBe(false);
    expect(h.store.loadCount).toBe(2);
    // Reloaded from the store even though the loop stays stopped.
    expect(h.manager.getTruckState('TRK-TEST')?.progress).toBe(0);
  });
});
