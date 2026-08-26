import type { TruckStatus } from '../generated/prisma/enums.js';
import { logger } from '../lib/logger.js';

/**
 * The seam between domain logic and realtime transport (CLAUDE.md §14).
 *
 * The simulation engine emits plain domain events into a `SimulationEventSink`
 * and knows nothing about Socket.IO. Phase 5 supplies a sink that fans these
 * out to the `operations`, `truck:{id}` and `shipment:{id}` rooms; until then
 * the default sink just logs at debug level.
 *
 * Payloads stay small on purpose (§24): no route geometry, no full database
 * records, only what the frontend needs to interpolate.
 */

export interface TruckPositionPayload {
  truckId: string;
  reference: string;
  shipmentId: string | null;

  latitude: number;
  longitude: number;
  /** Previous authoritative position — the start of the frontend's interpolation. */
  previousLatitude?: number;
  previousLongitude?: number;
  /** Where the truck is projected to be at the next tick — the interpolation target. */
  targetLatitude: number;
  targetLongitude: number;

  progress: number;
  speedKmph: number;
  eta: string | null;
  status: TruckStatus;

  serverTimestamp: string;
  sequenceNumber: number;
}

export interface TruckEtaPayload {
  truckId: string;
  reference: string;
  shipmentId: string | null;
  eta: string | null;
  progress: number;
  speedKmph: number;
  serverTimestamp: string;
  sequenceNumber: number;
}

export interface TruckStatusPayload {
  truckId: string;
  reference: string;
  shipmentId: string | null;
  previousStatus: TruckStatus;
  status: TruckStatus;
  progress: number;
  eta: string | null;
  serverTimestamp: string;
  sequenceNumber: number;
}

export type SimulationEvent =
  | { type: 'TRUCK_POSITION_UPDATED'; data: TruckPositionPayload }
  | { type: 'TRUCK_ETA_UPDATED'; data: TruckEtaPayload }
  | { type: 'TRUCK_STATUS_CHANGED'; data: TruckStatusPayload };

export type SimulationEventType = SimulationEvent['type'];

export interface SimulationEventSink {
  emit(event: SimulationEvent): void;
}

/**
 * Default sink. Position updates are debug-level because there are ~9 of them
 * every 2 seconds; status changes are worth an info line.
 */
export const loggerEventSink: SimulationEventSink = {
  emit(event) {
    if (event.type === 'TRUCK_STATUS_CHANGED') {
      const { reference, previousStatus, status } = event.data;
      logger.info(`${reference}: ${previousStatus} -> ${status}`);
      return;
    }
    logger.debug(`${event.type} ${event.data.reference}`, event.data);
  },
};
