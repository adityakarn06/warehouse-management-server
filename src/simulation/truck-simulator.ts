import { calculateEta, distanceTravelledKm } from '../eta/eta-engine.js';
import type { LiveTruckState } from './live-state.js';
import { isMoving } from './live-state.js';
import type { RouteProfile } from './route-engine.js';
import { pointAtProgress, progressAfterKm, remainingKm } from './route-engine.js';

/**
 * One truck, one tick — a pure function. No I/O, no clock of its own, no
 * mutation of the shared state object: it returns a fresh `LiveTruckState`.
 * Everything that makes the engine testable lives in this shape.
 */

export interface AdvanceInput {
  state: LiveTruckState;
  profile: RouteProfile;
  /** Real milliseconds since this truck's last tick. */
  elapsedMs: number;
  now: Date;
  speedMultiplier: number;
  /** Progress % at which IN_TRANSIT / DELAYED becomes ARRIVING. */
  arrivingProgress: number;
}

export interface AdvanceResult {
  state: LiveTruckState;
  moved: boolean;
  statusChanged: boolean;
  previousStatus: LiveTruckState['status'];
  arrived: boolean;
  etaChanged: boolean;
}

const etaMinute = (eta: Date | null): number | null =>
  eta === null ? null : Math.floor(eta.getTime() / 60_000);

function unchanged(state: LiveTruckState): AdvanceResult {
  return {
    state,
    moved: false,
    statusChanged: false,
    previousStatus: state.status,
    arrived: false,
    etaChanged: false,
  };
}

export function advanceTruck(input: AdvanceInput): AdvanceResult {
  const { state, profile, elapsedMs, now, speedMultiplier, arrivingProgress } = input;

  // ARRIVED / DOCKED / COMPLETED are terminal here. DOCKED and COMPLETED belong
  // to the dock-assignment and WMS phases; the simulation never sets them.
  if (!isMoving(state.status) || elapsedMs <= 0) {
    return unchanged(state);
  }

  // Elapsed time, not a coordinate index: a slow or skipped tick still advances
  // the truck by exactly the distance the wall clock says it covered.
  const km = distanceTravelledKm(state.speedKmph, elapsedMs, speedMultiplier);

  // A stationary truck that is still flagged IN_TRANSIT (speed 0, or a tick so
  // short it covers no ground) has nothing to report. Without this it would
  // emit a position update every 2 seconds forever, walk its sequence number,
  // and stay permanently dirty so every stop() re-flushed it.
  if (km <= 0) {
    return unchanged(state);
  }

  const progress = progressAfterKm(profile, state.progress, km);
  const position = pointAtProgress(profile, progress);

  const arrived = progress >= 100;
  const speedKmph = arrived ? 0 : state.speedKmph;
  const eta = arrived
    ? now
    : calculateEta({
        remainingKm: remainingKm(profile, progress),
        speedKmph,
        now,
        speedMultiplier,
      });

  let status = state.status;
  if (arrived) {
    status = 'ARRIVED';
  } else if (
    progress >= arrivingProgress &&
    status !== 'ARRIVING' &&
    // A delayed truck stays DELAYED all the way to ARRIVED. Without this guard
    // the ladder would silently overwrite the operator's scenario the moment the
    // truck crossed 95%, and clearing the delay would have nothing to restore.
    state.activeDelay === 'NORMAL'
  ) {
    status = 'ARRIVING';
  }

  const next: LiveTruckState = {
    ...state,
    latitude: position.latitude,
    longitude: position.longitude,
    previousLatitude: state.latitude,
    previousLongitude: state.longitude,
    progress,
    speedKmph,
    eta,
    status,
    // Arriving ends the scenario: the truck is off the road, so there is no
    // speed left for a multiplier to act on. Leaving it set would strand the
    // row as ARRIVED-and-delayed — `changeDelay` refuses a truck that is not
    // moving, so nothing could ever clear it, and it would keep showing up
    // under `GET /api/v1/trucks?activeDelay=true`.
    activeDelay: arrived ? 'NORMAL' : state.activeDelay,
    arrivedAt: arrived ? (state.arrivedAt ?? now) : state.arrivedAt,
    lastUpdatedAt: now,
    sequenceNumber: state.sequenceNumber + 1,
    dirty: true,
  };

  return {
    state: next,
    moved: true,
    statusChanged: status !== state.status,
    previousStatus: state.status,
    arrived: arrived && state.status !== 'ARRIVED',
    etaChanged: etaMinute(eta) !== etaMinute(state.eta),
  };
}

/**
 * Where the truck is projected to be one tick from now, at its current speed.
 * The frontend animates from `previous` through `current` toward this point,
 * which is what keeps 2-second updates looking continuous.
 */
export function projectNextPosition(
  state: LiveTruckState,
  profile: RouteProfile,
  tickMs: number,
  speedMultiplier: number,
): { latitude: number; longitude: number } {
  const km = distanceTravelledKm(state.speedKmph, tickMs, speedMultiplier);
  return pointAtProgress(profile, progressAfterKm(profile, state.progress, km));
}
