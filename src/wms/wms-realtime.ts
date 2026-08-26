import type { TruckStatus } from '../generated/prisma/enums.js';
import { logger } from '../lib/logger.js';
import type {
  RealtimeEvent,
  TruckPositionPayload,
  TruckStatusPayload,
} from '../websocket/events.js';
import { tryGetRealtimeService } from '../websocket/index.js';

/**
 * The WMS layer's realtime seam (CLAUDE.md §14).
 *
 * Mirrors `src/docking/docking-events.ts`, including the property that makes it
 * free to wire: the default sink resolves the service per event through
 * `tryGetRealtimeService()`, which returns `null` rather than throwing when no
 * websocket exists — so the endpoints work under supertest, and `server.ts`
 * needs no change.
 *
 * Unlike the docking sink this is typed over the *whole* `RealtimeEvent` union,
 * because a WMS feed moves both trucks and doors. It adds no new event names:
 * §13 fixes the contract at seven, and ingestion reuses them.
 */
export type WmsRealtimeEvent = RealtimeEvent;

export interface WmsRealtimeSink {
  emit(event: WmsRealtimeEvent): void;
}

export const realtimeWmsSink: WmsRealtimeSink = {
  emit(event) {
    tryGetRealtimeService()?.emit(event);
    logger.debug(`wms -> ${event.type}`);
  },
};

let sink: WmsRealtimeSink = realtimeWmsSink;

export function wmsSink(): WmsRealtimeSink {
  return sink;
}

/** Swapped by the tests for a recording sink; production never calls this. */
export function setWmsSink(next: WmsRealtimeSink): void {
  sink = next;
}

export function resetWmsSink(): void {
  sink = realtimeWmsSink;
}

// --- Payload builders for trucks the engine is not simulating --------------
//
// `SimulationManager` emits its own events for every truck in the live store,
// using the route profile to compute interpolation targets. These two builders
// cover the other case: a truck parked in the yard (`ARRIVED`/`DOCKED`/
// `COMPLETED` are never loaded) or a stopped loop. Such a truck is standing
// still, so its interpolation target is its own position — that is the honest
// answer, not a degraded one.

/** The columns both builders read. Narrow on purpose — never a whole row (§24). */
export interface WmsTruckSnapshot {
  id: string;
  reference: string;
  status: TruckStatus;
  activeDelay: WmsTruckActiveDelay;
  currentLatitude: number;
  currentLongitude: number;
  progress: number;
  speedKmph: number;
  eta: Date | null;
  shipmentId: string | null;
}

type WmsTruckActiveDelay = TruckStatusPayload['activeDelay'];

export function truckPositionPayloadFor(
  truck: WmsTruckSnapshot,
  sequenceNumber: number,
  at: Date,
  previous?: { latitude: number; longitude: number },
): TruckPositionPayload {
  return {
    truckId: truck.id,
    reference: truck.reference,
    shipmentId: truck.shipmentId,
    latitude: truck.currentLatitude,
    longitude: truck.currentLongitude,
    // Omitted, not undefined — exactOptionalPropertyTypes.
    ...(previous === undefined
      ? {}
      : { previousLatitude: previous.latitude, previousLongitude: previous.longitude }),
    targetLatitude: truck.currentLatitude,
    targetLongitude: truck.currentLongitude,
    progress: truck.progress,
    speedKmph: truck.speedKmph,
    eta: truck.eta?.toISOString() ?? null,
    status: truck.status,
    serverTimestamp: at.toISOString(),
    sequenceNumber,
  };
}

export function truckStatusPayloadFor(
  truck: WmsTruckSnapshot,
  previousStatus: TruckStatus,
  sequenceNumber: number,
  at: Date,
): TruckStatusPayload {
  return {
    truckId: truck.id,
    reference: truck.reference,
    shipmentId: truck.shipmentId,
    previousStatus,
    status: truck.status,
    activeDelay: truck.activeDelay,
    progress: truck.progress,
    speedKmph: truck.speedKmph,
    eta: truck.eta?.toISOString() ?? null,
    serverTimestamp: at.toISOString(),
    sequenceNumber,
  };
}
