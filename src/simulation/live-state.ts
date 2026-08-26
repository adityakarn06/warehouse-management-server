import type { DelayScenario, TruckStatus } from '../generated/prisma/enums.js';

/**
 * The authoritative in-memory state of one moving truck (CLAUDE.md §5).
 *
 * This is the source of truth between database checkpoints. Nothing here is
 * written to PostgreSQL every tick — `sequenceNumber`, `previous*` and
 * `lastPersistedProgress` never touch the database at all.
 */
export interface LiveTruckState {
  truckId: string;
  reference: string;
  routeId: string;
  /** The shipment riding on this truck, so its status can be mirrored on arrival. */
  shipmentId: string | null;

  latitude: number;
  longitude: number;
  /** Where the truck was on the previous tick — the frontend interpolates from it. */
  previousLatitude?: number;
  previousLongitude?: number;

  /** 0-100 along the route. */
  progress: number;
  /** Effective ground speed — the base speed after the active delay multiplier. */
  speedKmph: number;
  /**
   * The truck's undelayed speed. There is no column for it: it is recovered at
   * load time from the persisted `speedKmph` and `activeDelay`, and it is what
   * clearing a delay restores. See `delay-scenarios.ts`.
   */
  baseSpeedKmph: number;
  eta: Date | null;

  status: TruckStatus;
  activeDelay: DelayScenario;
  arrivedAt: Date | null;

  lastUpdatedAt: Date;
  /** Monotonic per truck, so the frontend can drop out-of-order updates. */
  sequenceNumber: number;

  /** Progress at the last database write — drives the checkpoint cadence. */
  lastPersistedProgress: number;
  /** Set when memory has moved on from the persisted row. */
  dirty: boolean;
}

/**
 * The public shape of a live truck — `LiveTruckState` minus the engine's own
 * bookkeeping. `lastPersistedProgress` and `dirty` describe when the engine
 * next touches the database; they are not part of the API contract.
 */
export type LiveTruckView = Omit<LiveTruckState, 'lastPersistedProgress' | 'dirty'>;

export function toLiveTruckView(state: LiveTruckState): LiveTruckView {
  const { lastPersistedProgress: _persisted, dirty: _dirty, ...view } = state;
  return view;
}

/** Statuses the simulation actually advances. The rest are terminal or dock-owned. */
export const MOVING_STATUSES: TruckStatus[] = ['IN_TRANSIT', 'DELAYED', 'ARRIVING'];

export function isMoving(status: TruckStatus): boolean {
  return MOVING_STATUSES.includes(status);
}

/**
 * The live map. Keyed by truck id, with a secondary reference index so
 * `/simulation/trucks/TRK-101` resolves the same way the read APIs do.
 */
export class LiveStateStore {
  private readonly byId = new Map<string, LiveTruckState>();
  private readonly idByReference = new Map<string, string>();

  set(state: LiveTruckState): void {
    this.byId.set(state.truckId, state);
    this.idByReference.set(state.reference, state.truckId);
  }

  get(idOrReference: string): LiveTruckState | undefined {
    const direct = this.byId.get(idOrReference);
    if (direct) return direct;

    const id = this.idByReference.get(idOrReference);
    return id === undefined ? undefined : this.byId.get(id);
  }

  all(): LiveTruckState[] {
    return [...this.byId.values()];
  }

  clear(): void {
    this.byId.clear();
    this.idByReference.clear();
  }

  get size(): number {
    return this.byId.size;
  }
}
