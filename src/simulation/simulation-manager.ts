import { env } from '../config/index.js';
import type { LocationSnapshotReason } from '../generated/prisma/enums.js';
import { logger } from '../lib/logger.js';
import type { LiveTruckState } from './live-state.js';
import { LiveStateStore } from './live-state.js';
import type { RouteProfile } from './route-engine.js';
import { buildRouteProfile, clearRouteProfileCache, pointAtProgress } from './route-engine.js';
import type { SimulationEventSink } from './simulation-events.js';
import { loggerEventSink } from './simulation-events.js';
import type { SimulationStore, SimulationTruckRow } from './simulation-store.js';
import { prismaSimulationStore } from './simulation-store.js';
import { advanceTruck, projectNextPosition } from './truck-simulator.js';

/**
 * The one authoritative simulation loop (CLAUDE.md §3, §22).
 *
 * Owns: the in-memory live state, the single interval, when to touch the
 * database, and when to emit realtime events. Everything it depends on is
 * injected, so the tests run the real engine against in-memory fakes.
 */

export interface SimulationManagerDeps {
  store: SimulationStore;
  sink: SimulationEventSink;
  /** Injectable clock — tests advance it by hand instead of using real timers. */
  now: () => number;
  tickMs: number;
  speedMultiplier: number;
  arrivingProgress: number;
  /** Progress % between periodic database checkpoints. */
  checkpointStep: number;
}

interface TrackedTruck {
  state: LiveTruckState;
  profile: RouteProfile;
  /** Clock reading at this truck's last advance. */
  lastTickAt: number;
}

export class SimulationManager {
  private readonly deps: SimulationManagerDeps;
  private readonly live = new LiveStateStore();
  private readonly profiles = new Map<string, RouteProfile>();
  private readonly lastTickAt = new Map<string, number>();

  private timer: NodeJS.Timeout | null = null;
  /** In-flight tick(), so stop() can wait for it instead of racing it. */
  private inFlight: Promise<void> | null = null;
  /**
   * Lifecycle queue. start/stop/reset all await database work, so without a
   * queue two of them can interleave: concurrent starts each install an
   * interval (orphaning one so stop() can never clear it), a stop can flush
   * stale state over a world a start has just rebuilt, and reset's
   * stop-wipe-start can be torn apart in the middle. Serialising them makes
   * each operation atomic with respect to the others.
   */
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(deps: SimulationManagerDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  getTruckState(idOrReference: string): LiveTruckState | undefined {
    return this.live.get(idOrReference);
  }

  getAllTruckStates(): LiveTruckState[] {
    return this.live.all();
  }

  get truckCount(): number {
    return this.live.size;
  }

  get tickMs(): number {
    return this.deps.tickMs;
  }

  /** Runs `op` after every lifecycle operation already queued. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    // Chain off both outcomes so one failed operation cannot wedge the queue,
    // and keep the stored link non-rejecting for the same reason.
    const next = this.lifecycle.then(op, op);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  /**
   * Idempotent by contract: a second call logs and returns rather than starting
   * a second loop. There is exactly one interval for the whole process.
   */
  async start(): Promise<void> {
    return this.enqueue(() => this.runStart());
  }

  private async runStart(): Promise<void> {
    if (this.timer !== null) {
      logger.warn('Simulation already running — ignoring duplicate start()');
      return;
    }

    if (this.live.size === 0) {
      await this.load();
    }

    // Rebase every truck's tick clock to now. Without this the first tick after
    // a stop/start would bill the truck for the whole paused interval and
    // teleport it down the route.
    const startedAt = this.deps.now();
    for (const state of this.live.all()) {
      this.lastTickAt.set(state.truckId, startedAt);
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.tickMs);
    this.timer.unref?.();

    logger.info(
      `Simulation started: ${this.live.size} truck(s), tick ${this.deps.tickMs}ms, ` +
        `speed x${this.deps.speedMultiplier}`,
    );
  }

  /** Stops the loop and flushes anything memory has moved past. Idempotent. */
  async stop(): Promise<void> {
    return this.enqueue(() => this.runStop());
  }

  private async runStop(): Promise<void> {
    if (this.timer === null) {
      logger.debug('Simulation stop() called while not running');
      return;
    }

    clearInterval(this.timer);
    this.timer = null;

    // Let a tick that is mid-persist finish first. Flushing underneath it would
    // write the older snapshot last, and in shutdown its transaction would
    // outlive stop() and race disconnectPrisma().
    if (this.inFlight !== null) {
      await this.inFlight;
    }

    const flushed = await this.flush();
    logger.info(`Simulation stopped: ${this.live.size} truck(s), ${flushed} snapshot(s) flushed`);
  }

  /**
   * Stop, drop the in-memory world, reload it from the database, start again.
   * Note this restores whatever the database currently holds — a full demo
   * rewind is `pnpm db:seed`.
   */
  async reset(): Promise<void> {
    return this.enqueue(async () => {
      logger.info('Resetting simulation');
      await this.runStop();
      this.live.clear();
      this.profiles.clear();
      this.lastTickAt.clear();
      clearRouteProfileCache();
      await this.runStart();
    });
  }

  /**
   * Advance every truck. Public and awaitable so tests can drive it with a fake
   * clock — no timer mocking anywhere in the suite.
   */
  async tick(nowMs = this.deps.now()): Promise<void> {
    // A stopped simulation does not advance, however it is called. Only the
    // interval drives this in production, but making it explicit is what lets
    // stop() actually mean stopped.
    if (this.timer === null) {
      logger.debug('Ignoring tick: simulation is not running');
      return;
    }

    // A slow persist must not let two ticks interleave over the same state.
    if (this.inFlight !== null) {
      logger.debug('Skipping tick: previous tick still in flight');
      return;
    }

    this.inFlight = this.runTick(nowMs);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runTick(nowMs: number): Promise<void> {
    try {
      const now = new Date(nowMs);

      for (const tracked of this.tracked()) {
        await this.advanceOne(tracked, now, nowMs);
      }
    } catch (error) {
      // A failed tick must never kill the interval.
      logger.error('Simulation tick failed', error);
    }
  }

  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    const rows = await this.deps.store.loadTrucks();
    const startedAt = this.deps.now();
    const loadedAt = new Date(startedAt);

    // Build the world before committing any of it. A truck whose route geometry
    // is unusable is skipped and reported rather than aborting the load — one
    // bad route must not silently leave the fleet half-loaded (and, because
    // start() only loads when the map is empty, permanently so).
    const loaded: { state: LiveTruckState; profile: RouteProfile }[] = [];
    const skipped: string[] = [];

    for (const row of rows) {
      try {
        loaded.push({ state: toLiveState(row, loadedAt), profile: buildRouteProfile(row.route) });
      } catch (error) {
        skipped.push(row.reference);
        logger.error(`Cannot simulate ${row.reference} on route ${row.route.id}`, error);
      }
    }

    for (const { state, profile } of loaded) {
      this.live.set(state);
      this.lastTickAt.set(state.truckId, startedAt);
      this.profiles.set(state.truckId, profile);
    }

    logger.info(`Simulation loaded ${loaded.length} moving truck(s) from the database`);
    if (skipped.length > 0) {
      logger.warn(`Skipped ${skipped.length} truck(s) with unusable routes: ${skipped.join(', ')}`);
    }
  }

  private tracked(): TrackedTruck[] {
    const out: TrackedTruck[] = [];
    for (const state of this.live.all()) {
      const profile = this.profiles.get(state.truckId);
      if (!profile) continue;
      out.push({
        state,
        profile,
        lastTickAt: this.lastTickAt.get(state.truckId) ?? this.deps.now(),
      });
    }
    return out;
  }

  private async advanceOne(tracked: TrackedTruck, now: Date, nowMs: number): Promise<void> {
    const { state, profile, lastTickAt } = tracked;

    const result = advanceTruck({
      state,
      profile,
      elapsedMs: nowMs - lastTickAt,
      now,
      speedMultiplier: this.deps.speedMultiplier,
      arrivingProgress: this.deps.arrivingProgress,
    });

    this.lastTickAt.set(state.truckId, nowMs);
    if (!result.moved) return;

    const next = result.state;
    this.live.set(next);

    this.emitPosition(next, profile);
    if (result.etaChanged) this.emitEta(next);
    if (result.statusChanged) this.emitStatus(next, result.previousStatus);

    const reason = this.snapshotReason(next, result.statusChanged, result.arrived);
    if (reason !== null || result.statusChanged) {
      await this.persist(next, reason);
    }
  }

  /**
   * The "never write every 2 seconds" rule (§24). A row is written only on a
   * status transition or once every `checkpointStep` percent of progress.
   */
  private snapshotReason(
    state: LiveTruckState,
    statusChanged: boolean,
    arrived: boolean,
  ): LocationSnapshotReason | null {
    if (arrived) return 'ARRIVED';
    if (statusChanged && state.status === 'ARRIVING') return 'ARRIVING';
    if (state.progress - state.lastPersistedProgress >= this.deps.checkpointStep) {
      return 'PERIODIC';
    }
    return null;
  }

  /** Returns whether the write landed. */
  private async persist(
    state: LiveTruckState,
    reason: LocationSnapshotReason | null,
  ): Promise<boolean> {
    try {
      await this.deps.store.persist(state, reason);
      this.live.set({ ...state, lastPersistedProgress: state.progress, dirty: false });
      return true;
    } catch (error) {
      // Keep simulating on a write failure; the state stays dirty and the next
      // checkpoint (or stop()) retries it.
      logger.error(`Failed to persist ${state.reference}`, error);
      return false;
    }
  }

  /** Writes every state memory has moved past. Returns how many rows were written. */
  private async flush(): Promise<number> {
    let written = 0;
    for (const state of this.live.all()) {
      if (!state.dirty) continue;
      if (await this.persist(state, null)) written += 1;
    }
    return written;
  }

  private emitPosition(state: LiveTruckState, profile: RouteProfile): void {
    const target =
      state.speedKmph > 0
        ? projectNextPosition(state, profile, this.deps.tickMs, this.deps.speedMultiplier)
        : pointAtProgress(profile, state.progress);

    this.deps.sink.emit({
      type: 'TRUCK_POSITION_UPDATED',
      data: {
        truckId: state.truckId,
        reference: state.reference,
        shipmentId: state.shipmentId,
        latitude: state.latitude,
        longitude: state.longitude,
        // Omitted, not undefined — exactOptionalPropertyTypes.
        ...(state.previousLatitude === undefined
          ? {}
          : { previousLatitude: state.previousLatitude }),
        ...(state.previousLongitude === undefined
          ? {}
          : { previousLongitude: state.previousLongitude }),
        targetLatitude: target.latitude,
        targetLongitude: target.longitude,
        progress: state.progress,
        speedKmph: state.speedKmph,
        eta: state.eta?.toISOString() ?? null,
        status: state.status,
        serverTimestamp: state.lastUpdatedAt.toISOString(),
        sequenceNumber: state.sequenceNumber,
      },
    });
  }

  private emitEta(state: LiveTruckState): void {
    this.deps.sink.emit({
      type: 'TRUCK_ETA_UPDATED',
      data: {
        truckId: state.truckId,
        reference: state.reference,
        shipmentId: state.shipmentId,
        eta: state.eta?.toISOString() ?? null,
        progress: state.progress,
        speedKmph: state.speedKmph,
        serverTimestamp: state.lastUpdatedAt.toISOString(),
        sequenceNumber: state.sequenceNumber,
      },
    });
  }

  private emitStatus(state: LiveTruckState, previousStatus: LiveTruckState['status']): void {
    this.deps.sink.emit({
      type: 'TRUCK_STATUS_CHANGED',
      data: {
        truckId: state.truckId,
        reference: state.reference,
        shipmentId: state.shipmentId,
        previousStatus,
        status: state.status,
        progress: state.progress,
        eta: state.eta?.toISOString() ?? null,
        serverTimestamp: state.lastUpdatedAt.toISOString(),
        sequenceNumber: state.sequenceNumber,
      },
    });
  }
}

export function toLiveState(row: SimulationTruckRow, loadedAt: Date): LiveTruckState {
  return {
    truckId: row.id,
    reference: row.reference,
    routeId: row.route.id,
    shipmentId: row.shipment?.id ?? null,
    latitude: row.currentLatitude,
    longitude: row.currentLongitude,
    progress: row.progress,
    speedKmph: row.speedKmph,
    eta: row.eta,
    status: row.status,
    activeDelay: row.activeDelay,
    arrivedAt: row.arrivedAt,
    lastUpdatedAt: loadedAt,
    sequenceNumber: 0,
    lastPersistedProgress: row.progress,
    dirty: false,
  };
}

/** The process-wide instance. One loop, one live state map (§3). */
export const simulationManager = new SimulationManager({
  store: prismaSimulationStore,
  sink: loggerEventSink,
  now: () => Date.now(),
  tickMs: env.SIMULATION_TICK_MS,
  speedMultiplier: env.SIMULATION_SPEED_MULTIPLIER,
  arrivingProgress: env.SIMULATION_ARRIVING_PROGRESS,
  checkpointStep: env.SIMULATION_CHECKPOINT_PROGRESS_STEP,
});
