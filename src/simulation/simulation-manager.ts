import { env } from '../config/index.js';
import { calculateEta } from '../eta/eta-engine.js';
import type {
  DelayScenario,
  LocationSnapshotReason,
  TruckStatus,
} from '../generated/prisma/enums.js';
import { HttpError } from '../lib/http-error.js';
import { logger } from '../lib/logger.js';
import type { ActiveDelayScenario, DelayMultipliers } from './delay-scenarios.js';
import {
  DELAY_LABEL,
  DELAY_SEVERITY,
  baseSpeedKmphFrom,
  delayMultipliersFromEnv,
  effectiveSpeedKmph,
  multiplierFor,
} from './delay-scenarios.js';
import type { LiveTruckState, LiveTruckView } from './live-state.js';
import { LiveStateStore, isMoving, toLiveTruckView } from './live-state.js';
import type { RouteProfile } from './route-engine.js';
import {
  buildRouteProfile,
  clearRouteProfileCache,
  pointAtProgress,
  remainingKm,
} from './route-engine.js';
import type {
  AlertCreatedPayload,
  SimulationEventSink,
  SimulationEventType,
} from './simulation-events.js';
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
  /** Speed multiplier per delay scenario (CLAUDE.md §7). */
  delayMultipliers: DelayMultipliers;
}

/**
 * What a delay command answers with: the authoritative resulting state, so the
 * frontend never has to guess or re-read (CLAUDE.md §2).
 */
export interface DelayResult {
  truck: LiveTruckView;
  /** The alert the activation raised. Clearing a delay raises none. */
  alert: AlertCreatedPayload | null;
}

/**
 * An authoritative fact from outside the engine (CLAUDE.md §15). Every field is
 * optional: the WMS reports what it knows and nothing else. `eta: null` is
 * meaningfully different from an absent `eta` — it clears the estimate, where
 * absence means "recompute it from the reported position".
 */
export interface ExternalTruckUpdate {
  latitude?: number;
  longitude?: number;
  progress?: number;
  speedKmph?: number;
  status?: TruckStatus;
  activeDelay?: DelayScenario;
  eta?: Date | null;
  arrivedAt?: Date | null;
}

/**
 * What an external update actually did. `emitted` is reported rather than
 * reconstructed by the caller: only the engine knows which of the three events
 * its comparison against *live* state raised, and a caller re-deriving that from
 * a database row would be wrong in both directions (the row lags between
 * checkpoints) and would miss `TRUCK_ETA_UPDATED` entirely.
 */
export interface ExternalUpdateResult {
  truck: LiveTruckView;
  emitted: SimulationEventType[];
}

/**
 * The loop's own state, as returned by `health()`. It is the body of the three
 * lifecycle endpoints *and* of the read-only `GET /api/v1/simulation/status`.
 * `lastTickError` means "is it broken *now*": per-truck tick failures are
 * swallowed so one unusable truck cannot silence the rest (CLAUDE.md §22),
 * which would otherwise make a wedged engine look identical to a healthy one
 * from outside.
 */
export interface SimulationHealth {
  running: boolean;
  truckCount: number;
  tickMs: number;
  lastTickAt: string | null;
  lastTickError: string | null;
}

interface TrackedTruck {
  state: LiveTruckState;
  profile: RouteProfile;
  /** Clock reading at this truck's last advance. */
  lastTickAt: number;
}

export class SimulationManager {
  private deps: SimulationManagerDeps;
  private readonly live = new LiveStateStore();
  private readonly profiles = new Map<string, RouteProfile>();
  private readonly lastTickAt = new Map<string, number>();
  /**
   * Highest sequence number ever emitted per truck. Deliberately survives
   * `reset()` and the `live.clear()` inside it: clients drop any update whose
   * sequence is below the last one they applied, so a counter that restarted at
   * 0 under a still-connected dashboard would make it discard every update
   * until the count climbed back.
   */
  private readonly lastSequence = new Map<string, number>();
  /**
   * The world as it looked the first time it was loaded — the seeded state on a
   * freshly booted server. `reset()` writes this back to the database before
   * reloading, which is the whole of what makes reset a rewind: the rows the
   * loop has been checkpointing since boot describe the *current* world, so
   * reloading them would restore exactly the state being reset away from.
   */
  private baseline: SimulationTruckRow[] | null = null;

  private timer: NodeJS.Timeout | null = null;
  /** In-flight tick() *or* stop()'s flush, so callers queue instead of racing. */
  private inFlight: Promise<void> | null = null;
  /**
   * Loop health, surfaced on `GET /api/v1/simulation/state`. A tick failure is
   * swallowed per truck so the interval survives, which means a wedged engine
   * would otherwise look identical to a healthy one from outside.
   */
  private lastTickAtMs: number | null = null;
  private lastTickError: string | null = null;
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

  /**
   * Swaps the realtime sink. The singleton below is constructed at import time,
   * before the Socket.IO server exists, so `server.ts` attaches the
   * Socket.IO-backed sink here once `initWebsocket()` has returned. The engine
   * still never imports Socket.IO (§14) — it only ever sees a `SimulationEventSink`.
   */
  setSink(sink: SimulationEventSink): void {
    this.deps = { ...this.deps, sink };
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

  get delayMultipliers(): DelayMultipliers {
    return this.deps.delayMultipliers;
  }

  /**
   * What the loop is actually doing, for the dashboard and for the demo
   * operator. This is the body of `POST /api/v1/simulation/start|stop|reset` —
   * *not* `GET /simulation/state`, which returns the per-truck list.
   * `lastTickError` holds the most recent per-truck failure and is cleared by
   * the first clean tick after it.
   */
  health(): SimulationHealth {
    return {
      running: this.isRunning(),
      truckCount: this.truckCount,
      tickMs: this.deps.tickMs,
      lastTickAt: this.lastTickAtMs === null ? null : new Date(this.lastTickAtMs).toISOString(),
      lastTickError: this.lastTickError,
    };
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

  /**
   * `flushDirty: false` is reset's path: it drains an in-flight tick and clears
   * the interval, but deliberately does *not* write memory back. Flushing there
   * would persist the very progress being discarded, and the reload that
   * follows would read it straight back — a reset that resets nothing.
   */
  private async runStop(flushDirty = true): Promise<void> {
    const wasRunning = this.timer !== null;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Let a tick or a command that is mid-persist finish first. Flushing
    // underneath one would write the older snapshot last, and in shutdown its
    // transaction would outlive stop() and race disconnectPrisma().
    while (this.inFlight !== null) {
      await this.inFlight;
    }

    // Then flush *while still holding the barrier*. Releasing it first would let
    // a command parked in `applyExternalUpdate`'s own `while (this.inFlight !==
    // null)` loop claim the slot between the drain and the flush and persist
    // behind it — leaving its fresh state unwritten, and at shutdown issuing a
    // transaction that outlives stop(). Nothing awaits between the loop above
    // and the assignment below, which is what makes the claim safe (the same
    // reasoning `changeDelay` relies on).
    const flushing = flushDirty ? this.flush() : Promise.resolve(0);
    // The barrier must never reject: tick() and stop() await it.
    this.inFlight = flushing.then(
      () => undefined,
      () => undefined,
    );

    // Flush even when the loop was already stopped. A stopped engine can still
    // hold dirty state — an external update absorbed while stopped, or a
    // checkpoint whose write failed — and returning early here would drop it on
    // the floor at shutdown, where there is no later checkpoint to retry it.
    let flushed = 0;
    try {
      flushed = await flushing;
    } finally {
      this.inFlight = null;
    }

    if (wasRunning) {
      logger.info(`Simulation stopped: ${this.live.size} truck(s), ${flushed} snapshot(s) flushed`);
    } else {
      logger.debug(`Simulation stop() called while not running; ${flushed} snapshot(s) flushed`);
    }
  }

  /**
   * Stop, drop the in-memory world, reload it from the database, start again.
   * Note this restores whatever the database currently holds — a full demo
   * rewind is `pnpm db:seed`.
   */
  async reset(): Promise<void> {
    return this.enqueue(async () => {
      logger.info('Resetting simulation');
      // Reset restores state; it does not decide whether the loop runs. An
      // operator who stopped the simulation and then reset it must not find the
      // trucks moving again.
      const wasRunning = this.timer !== null;
      // The statuses the world is being rewound *from*, so the
      // `TRUCK_STATUS_CHANGED` below reports a real transition rather than
      // claiming each truck changed from the status it just landed on.
      const previousStatuses = new Map(
        this.live.all().map((state) => [state.truckId, state.status] as const),
      );

      // `false`: do not flush. The dirty state being discarded is exactly what
      // the rewind exists to throw away, and flushing it would write it to the
      // rows the reload then reads back.
      await this.runStop(false);
      this.live.clear();
      this.profiles.clear();
      this.lastTickAt.clear();
      clearRouteProfileCache();

      // Put the boot snapshot back before reloading. Without this the reload
      // returns the checkpoints this run has been writing since boot — the
      // current world — and reset is a no-op the operator can see nothing of.
      if (this.baseline !== null) {
        try {
          await this.deps.store.restoreTrucks(this.baseline);
        } catch (error) {
          // A failed rewind must still leave a loaded, consistent world rather
          // than an empty one, so the reload below runs either way.
          logger.error('Failed to restore the simulation baseline', error);
        }
      }

      if (wasRunning) {
        await this.runStart();
      } else {
        // Still reload, so `GET /simulation/state` reflects the database.
        await this.load();
      }

      // Every dashboard is now holding a world that no longer exists. The
      // client that sent the command re-hydrates by re-subscribing, but every
      // other one only ever learns about a truck through these events — so the
      // rewind is broadcast like any other authoritative change.
      this.emitRewind(previousStatuses);
    });
  }

  /** Announce the post-reset world to every subscriber. */
  private emitRewind(previousStatuses: Map<string, TruckStatus>): void {
    for (const state of this.live.all()) {
      const profile = this.profiles.get(state.truckId);
      if (!profile) continue;

      // Past the high-water mark, or clients that survived the reset would drop
      // the rewind as a stale update — the counter deliberately does not restart.
      const next: LiveTruckState = { ...state, sequenceNumber: this.nextSequence(state.truckId) };
      this.live.set(next);

      this.emitPosition(next, profile);
      this.emitEta(next);
      this.emitStatus(next, previousStatuses.get(next.truckId) ?? next.status);
    }
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
    const now = new Date(nowMs);

    // Per truck, not per tick: one unusable truck must not silence the rest of
    // the fleet for that interval. `lastTickAt` is advanced inside advanceOne
    // before anything can throw, so a failure costs events, never distance.
    let failure: string | null = null;

    for (const tracked of this.tracked()) {
      try {
        await this.advanceOne(tracked, now, nowMs);
      } catch (error) {
        // A failed truck must never kill the interval.
        logger.error(`Simulation tick failed for ${tracked.state.reference}`, error);
        failure = `${tracked.state.reference}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    this.lastTickAtMs = nowMs;
    // Cleared by the first clean tick, so the field reads as "is it broken now",
    // not "has it ever been broken".
    this.lastTickError = failure;
  }

  // --- Delay scenarios (CLAUDE.md §7) --------------------------------------

  /**
   * Activate a delay scenario on one truck. The frontend sends only the scenario
   * name; every consequence — effective speed, ETA, status, the alert, the
   * realtime events, the persisted business event — is decided here (§2).
   */
  async applyDelay(idOrReference: string, scenario: ActiveDelayScenario): Promise<DelayResult> {
    return this.changeDelay(idOrReference, scenario);
  }

  /** Clear the active scenario and restore the truck's base speed. */
  async clearDelay(idOrReference: string): Promise<DelayResult> {
    return this.changeDelay(idOrReference, 'NORMAL');
  }

  /**
   * A delay command occupies the same slot a tick does. Waiting for an in-flight
   * tick is not enough on its own: the command keeps awaiting (the alert write,
   * then `persist`) *after* it has written the new state, and a tick firing in
   * that window would advance the truck only for `persist` to write the
   * pre-command snapshot back over it — rolling the position back and regressing
   * `sequenceNumber` below the high-water mark, which makes dashboards drop the
   * next update. Taking `inFlight` for the whole command closes that window, and
   * makes two rapid commands queue instead of clobbering each other.
   */
  private async changeDelay(
    idOrReference: string,
    scenario: DelayScenario,
  ): Promise<DelayResult> {
    // A loop: after awaiting, another caller may have taken the slot. The claim
    // below is safe because nothing awaits between the check and the assignment.
    while (this.inFlight !== null) {
      await this.inFlight;
    }

    const run = this.runChangeDelay(idOrReference, scenario);
    // `inFlight` is a barrier that tick() and stop() await — it must never
    // reject, or a rejected command would surface as an unhandled failure there.
    this.inFlight = run.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  private async runChangeDelay(
    idOrReference: string,
    scenario: DelayScenario,
  ): Promise<DelayResult> {
    // A stopped loop is not advancing anyone: applying a scenario would write a
    // business event and an alert for a truck standing still, and hand back an
    // ETA computed at the stopped instant that goes stale the moment the loop
    // restarts and rebases its clock.
    if (this.timer === null) {
      throw HttpError.conflict('Simulation is not running');
    }

    const state = this.live.get(idOrReference);
    if (!state) {
      throw HttpError.notFound(`Truck ${idOrReference} is not being simulated`);
    }

    // ARRIVED / DOCKED / COMPLETED trucks are not on the road any more, so there
    // is no speed for a scenario to act on.
    if (!isMoving(state.status)) {
      throw HttpError.conflict(
        `Truck ${state.reference} is ${state.status} and cannot change delay scenario`,
      );
    }

    // Pressing the same button twice is a no-op, not a second alert.
    if (state.activeDelay === scenario) {
      return { truck: toLiveTruckView(state), alert: null };
    }

    const profile = this.profiles.get(state.truckId);
    if (!profile) {
      throw HttpError.internal(`No route profile loaded for ${state.reference}`);
    }

    const now = new Date(this.deps.now());
    const speedKmph = effectiveSpeedKmph(
      state.baseSpeedKmph,
      scenario,
      this.deps.delayMultipliers,
    );

    // The same authoritative call the tick makes: distance still to drive over
    // the new effective speed. Never a hardcoded countdown (§6).
    const eta = calculateEta({
      remainingKm: remainingKm(profile, state.progress),
      speedKmph,
      now,
      speedMultiplier: this.deps.speedMultiplier,
    });

    const status =
      scenario === 'NORMAL'
        ? // Restore the status the ladder would have reached on its own.
          state.progress >= this.deps.arrivingProgress
          ? 'ARRIVING'
          : 'IN_TRANSIT'
        : 'DELAYED';

    const next: LiveTruckState = {
      ...state,
      speedKmph,
      eta,
      status,
      activeDelay: scenario,
      lastUpdatedAt: now,
      // Bump past the high-water mark rather than the state's own counter, so a
      // dashboard that drops out-of-order updates still applies this one.
      sequenceNumber: (this.lastSequence.get(state.truckId) ?? state.sequenceNumber) + 1,
      dirty: true,
    };

    this.live.set(next);
    this.lastSequence.set(next.truckId, next.sequenceNumber);

    this.emitEta(next);
    // Also on a scenario switch that leaves the status alone (RAIN -> TRAFFIC
    // is DELAYED either way): `TRUCK_STATUS_CHANGED` is the only payload
    // carrying `activeDelay`, so without this every dashboard except the one
    // that sent the command keeps rendering the old scenario forever.
    if (next.status !== state.status || next.activeDelay !== state.activeDelay) {
      this.emitStatus(next, state.status);
    }

    const alert =
      scenario === 'NORMAL' ? null : await this.raiseDelayAlert(next, state, scenario);

    await this.persist(next, scenario === 'NORMAL' ? 'DELAY_CLEARED' : 'DELAY_ACTIVATED');

    logger.info(
      `${next.reference}: delay ${state.activeDelay} -> ${scenario} ` +
        `(${state.speedKmph} -> ${speedKmph} km/h)`,
    );

    // Re-read: persist() rewrites the entry with its checkpoint bookkeeping.
    return { truck: toLiveTruckView(this.live.get(next.truckId) ?? next), alert };
  }

  /**
   * A delay is a real operational event, so it gets a persisted alert (§11) —
   * unlike a position update, which never touches the database.
   */
  private async raiseDelayAlert(
    next: LiveTruckState,
    previous: LiveTruckState,
    scenario: ActiveDelayScenario,
  ): Promise<AlertCreatedPayload | null> {
    const label = DELAY_LABEL[scenario];
    const etaShiftMinutes =
      next.eta === null || previous.eta === null
        ? null
        : Math.round((next.eta.getTime() - previous.eta.getTime()) / 60_000);

    try {
      const alert = await this.deps.store.createAlert({
        type: 'TRUCK_DELAYED',
        severity: DELAY_SEVERITY[scenario],
        title: `${label} delay on ${next.reference}`,
        message:
          `${next.reference} slowed from ${round(previous.speedKmph)} to ` +
          `${round(next.speedKmph)} km/h due to ${label.toLowerCase()}` +
          (etaShiftMinutes === null ? '.' : `; ETA pushed out by ${etaShiftMinutes} min.`),
        truckId: next.truckId,
        shipmentId: next.shipmentId,
        metadata: {
          delayType: scenario,
          speedKmph: round(next.speedKmph),
          previousSpeedKmph: round(previous.speedKmph),
          baseSpeedKmph: round(next.baseSpeedKmph),
          multiplier: multiplierFor(scenario, this.deps.delayMultipliers),
          ...(etaShiftMinutes === null ? {} : { etaShiftMinutes }),
        },
      });

      const payload: AlertCreatedPayload = {
        alertId: alert.id,
        type: alert.type,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        truckId: alert.truckId,
        shipmentId: alert.shipmentId,
        dockDoorId: alert.dockDoorId,
        createdAt: alert.createdAt.toISOString(),
      };

      this.deps.sink.emit({ type: 'ALERT_CREATED', data: payload });
      return payload;
    } catch (error) {
      // The delay itself has already taken effect in memory. Losing the audit
      // row must not fail the command or leave the engine half-changed.
      logger.error(`Failed to raise delay alert for ${next.reference}`, error);
      return null;
    }
  }

  /**
   * `TRUCK_ARRIVING` (CLAUDE.md §11). The WMS feed already raises this on
   * `TRAILER_STATUS_UPDATED`; this is the mirror for a truck that reaches
   * `ARRIVING` by simulation ticks rather than an external report, so the
   * demo's "ETA alerts" output has a trigger on the normal happy path too.
   * Fires once, on the tick `advanceTruck` flips the status — never on a
   * later tick that merely holds `ARRIVING`.
   */
  private async raiseArrivingAlert(next: LiveTruckState): Promise<void> {
    try {
      const etaMinutes =
        next.eta === null ? null : Math.round((next.eta.getTime() - this.deps.now()) / 60_000);

      const alert = await this.deps.store.createAlert({
        type: 'TRUCK_ARRIVING',
        severity: 'INFO',
        title: `${next.reference} is arriving`,
        message:
          etaMinutes === null
            ? `${next.reference} is arriving now.`
            : `${next.reference} is arriving in about ${etaMinutes} min.`,
        truckId: next.truckId,
        shipmentId: next.shipmentId,
        metadata: { progress: round(next.progress), ...(etaMinutes === null ? {} : { etaMinutes }) },
      });

      const payload: AlertCreatedPayload = {
        alertId: alert.id,
        type: alert.type,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        truckId: alert.truckId,
        shipmentId: alert.shipmentId,
        dockDoorId: alert.dockDoorId,
        createdAt: alert.createdAt.toISOString(),
      };

      this.deps.sink.emit({ type: 'ALERT_CREATED', data: payload });
    } catch (error) {
      // Same rule as the delay alert: a lost audit row must not fail the tick.
      logger.error(`Failed to raise arriving alert for ${next.reference}`, error);
    }
  }

  // --- External facts: the WMS feed (CLAUDE.md §15) -------------------------

  /**
   * The next sequence number for a truck, whether or not the live store is
   * tracking it. The WMS handler builds payloads by hand for trucks parked in
   * the yard (`ARRIVED`/`DOCKED`/`COMPLETED` are never loaded), and those
   * events still have to clear the high-water mark clients drop updates below.
   */
  nextSequence(truckId: string): number {
    const next = (this.lastSequence.get(truckId) ?? 0) + 1;
    this.lastSequence.set(truckId, next);
    return next;
  }

  /**
   * Absorb an authoritative fact from outside the engine — the WMS feed saying
   * where a trailer actually is, or what it is actually doing.
   *
   * Returns `null` when the truck is not being simulated: a stopped loop, or a
   * truck parked in the yard. Unlike `changeDelay` this never throws for those
   * cases — a WMS fact is true whether or not we happen to be simulating, and
   * the caller writes Prisma directly instead.
   *
   * Takes the `inFlight` barrier for exactly the reason `changeDelay` does: a
   * tick firing mid-command would advance the truck and then `persist` the
   * pre-command snapshot back over it, rolling the position back and regressing
   * `sequenceNumber` below the mark dashboards drop updates against.
   */
  async applyExternalUpdate(
    idOrReference: string,
    update: ExternalTruckUpdate,
    reason: LocationSnapshotReason | null = null,
  ): Promise<ExternalUpdateResult | null> {
    while (this.inFlight !== null) {
      await this.inFlight;
    }

    // Deliberately *not* gated on the loop running. `stop()` does not clear
    // `live`, and `start()` only reloads when the map is empty, so bailing here
    // would send the handler down its direct-Prisma branch and leave memory
    // disagreeing with the row it just wrote — and the next start would resume
    // from the stale snapshot and persist it back over the arrival. A WMS fact
    // is true whether or not the engine happens to be ticking, so it is
    // absorbed either way; the barrier above is what keeps it clear of a flush.
    const run = this.runExternalUpdate(idOrReference, update, reason);
    // The barrier tick() and stop() await must never reject.
    this.inFlight = run.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  private async runExternalUpdate(
    idOrReference: string,
    update: ExternalTruckUpdate,
    reason: LocationSnapshotReason | null,
  ): Promise<ExternalUpdateResult | null> {
    const state = this.live.get(idOrReference);
    // Not an error: the yard is full of trucks the engine never loads.
    if (!state) return null;

    const now = new Date(this.deps.now());
    const profile = this.profiles.get(state.truckId);

    const progress = update.progress ?? state.progress;
    const speedKmph = update.speedKmph ?? state.speedKmph;
    const status = update.status ?? state.status;

    // An explicit `eta` wins — including an explicit null. Otherwise recompute
    // it from the reported position, so a resync never leaves a stale arrival
    // time standing next to a new position (§6).
    const eta =
      update.eta !== undefined
        ? update.eta
        : profile && speedKmph > 0 && isMoving(status)
          ? calculateEta({
              remainingKm: remainingKm(profile, progress),
              speedKmph,
              now,
              speedMultiplier: this.deps.speedMultiplier,
            })
          : state.eta;

    const moved =
      update.latitude !== undefined ||
      update.longitude !== undefined ||
      update.progress !== undefined;

    const next: LiveTruckState = {
      ...state,
      ...(moved
        ? { previousLatitude: state.latitude, previousLongitude: state.longitude }
        : {}),
      latitude: update.latitude ?? state.latitude,
      longitude: update.longitude ?? state.longitude,
      progress,
      speedKmph,
      status,
      activeDelay: update.activeDelay ?? state.activeDelay,
      eta,
      // `!== undefined`, not `??`: an explicit null clears the arrival, the way
      // an explicit null clears the ETA two fields up.
      arrivedAt: update.arrivedAt !== undefined ? update.arrivedAt : state.arrivedAt,
      lastUpdatedAt: now,
      sequenceNumber: (this.lastSequence.get(state.truckId) ?? state.sequenceNumber) + 1,
      dirty: true,
    };

    this.live.set(next);
    this.lastSequence.set(next.truckId, next.sequenceNumber);
    // The engine's own clock for this truck: without it the next tick would
    // bill the whole gap since the last tick against the position the WMS just
    // corrected, undoing the resync.
    this.lastTickAt.set(next.truckId, this.deps.now());

    const emitted: SimulationEventType[] = [];

    if (moved && profile) {
      this.emitPosition(next, profile);
      emitted.push('TRUCK_POSITION_UPDATED');
    }
    if ((eta?.getTime() ?? null) !== (state.eta?.getTime() ?? null)) {
      this.emitEta(next);
      emitted.push('TRUCK_ETA_UPDATED');
    }
    // Also on a scenario change that leaves the status alone: TRUCK_STATUS_CHANGED
    // is the only payload carrying `activeDelay` (same rule as `changeDelay`).
    if (next.status !== state.status || next.activeDelay !== state.activeDelay) {
      this.emitStatus(next, state.status);
      emitted.push('TRUCK_STATUS_CHANGED');
    }

    await this.persist(next, reason);

    // Re-read: persist() rewrites the entry with its checkpoint bookkeeping.
    return { truck: toLiveTruckView(this.live.get(next.truckId) ?? next), emitted };
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
    const loaded: { row: SimulationTruckRow; state: LiveTruckState; profile: RouteProfile }[] = [];
    const skipped: string[] = [];

    for (const row of rows) {
      try {
        loaded.push({
          row,
          // Resume this truck's counter rather than restarting it at 0.
          state: toLiveState(
            row,
            loadedAt,
            this.lastSequence.get(row.id) ?? 0,
            this.deps.delayMultipliers,
          ),
          profile: buildRouteProfile(row.route),
        });
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

    // The first load of the process is the baseline `reset()` rewinds to: on a
    // freshly seeded demo it is the seeded world, and after that it is whatever
    // the operator booted with. Captured after the skip filter so a truck with
    // unusable geometry is not written back by a rewind that cannot load it.
    this.baseline ??= loaded.map(({ row }) => row);

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

    // Stamped before anything can throw: `elapsedMs` is already captured above,
    // and a truck whose advance fails must not be billed twice for the same
    // interval on the next tick (see the per-truck catch in runTick).
    this.lastTickAt.set(state.truckId, nowMs);

    const result = advanceTruck({
      state,
      profile,
      elapsedMs: nowMs - lastTickAt,
      now,
      speedMultiplier: this.deps.speedMultiplier,
      arrivingProgress: this.deps.arrivingProgress,
    });

    if (!result.moved) return;

    const next = result.state;
    this.live.set(next);
    this.lastSequence.set(next.truckId, next.sequenceNumber);

    this.emitPosition(next, profile);
    if (result.etaChanged) this.emitEta(next);
    if (result.statusChanged) this.emitStatus(next, result.previousStatus);
    if (result.statusChanged && next.status === 'ARRIVING') {
      await this.raiseArrivingAlert(next);
    }

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
        activeDelay: state.activeDelay,
        progress: state.progress,
        speedKmph: state.speedKmph,
        eta: state.eta?.toISOString() ?? null,
        serverTimestamp: state.lastUpdatedAt.toISOString(),
        sequenceNumber: state.sequenceNumber,
      },
    });
  }
}

/** Speeds are display values in alert copy — two decimals is plenty. */
const round = (value: number): number => Math.round(value * 100) / 100;

export function toLiveState(
  row: SimulationTruckRow,
  loadedAt: Date,
  sequenceNumber = 0,
  delayMultipliers: DelayMultipliers = delayMultipliersFromEnv,
): LiveTruckState {
  return {
    truckId: row.id,
    reference: row.reference,
    routeId: row.route.id,
    shipmentId: row.shipment?.id ?? null,
    latitude: row.currentLatitude,
    longitude: row.currentLongitude,
    progress: row.progress,
    speedKmph: row.speedKmph,
    // No column for this: the stored speed is already the effective one, so the
    // scenario that produced it is what divides back out to the base.
    baseSpeedKmph: baseSpeedKmphFrom(row.speedKmph, row.activeDelay, delayMultipliers),
    eta: row.eta,
    status: row.status,
    activeDelay: row.activeDelay,
    arrivedAt: row.arrivedAt,
    lastUpdatedAt: loadedAt,
    sequenceNumber,
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
  delayMultipliers: delayMultipliersFromEnv,
});
