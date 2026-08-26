import type {
  DelayScenario,
  LocationSnapshotReason,
  ShipmentStatus,
  TruckStatus,
} from '../generated/prisma/enums.js';
import { prisma } from '../lib/prisma.js';
import type { LiveTruckState } from './live-state.js';
import { MOVING_STATUSES } from './live-state.js';
import type { RouteInput } from './route-engine.js';

/**
 * The database seam. The manager talks to this interface only, so tests can
 * drive the whole engine with an in-memory fake and never touch Postgres.
 */

export interface SimulationTruckRow {
  id: string;
  reference: string;
  status: TruckStatus;
  activeDelay: DelayScenario;
  currentLatitude: number;
  currentLongitude: number;
  progress: number;
  speedKmph: number;
  eta: Date | null;
  arrivedAt: Date | null;
  route: RouteInput;
  shipment: { id: string } | null;
}

export interface SimulationStore {
  /** Every truck the simulation should advance, with its route geometry. */
  loadTrucks(): Promise<SimulationTruckRow[]>;
  /**
   * Persist one meaningful state change. `reason === null` writes the truck
   * snapshot without a LocationHistory row.
   */
  persist(state: LiveTruckState, reason: LocationSnapshotReason | null): Promise<void>;
}

/**
 * Snapshot reason -> the shipment status that mirrors it.
 *
 * Keyed on the *reason* rather than the truck's current status, because only a
 * transition writes one of these. Keying on status would re-assert ARRIVING on
 * every periodic checkpoint between 95% and 100% — and once Phase 7/9 moves a
 * shipment on to DOCKED/DELIVERED, the next checkpoint would drag it back.
 */
const SHIPMENT_STATUS_FOR: Partial<Record<LocationSnapshotReason, ShipmentStatus>> = {
  ARRIVING: 'ARRIVING',
  ARRIVED: 'ARRIVED',
};

export const prismaSimulationStore: SimulationStore = {
  async loadTrucks() {
    return prisma.truck.findMany({
      // MOVING_STATUSES is a mutable array on purpose — Prisma's filter types
      // reject `readonly` arrays (same reason as `activeAssignmentWhere`).
      where: { status: { in: MOVING_STATUSES } },
      orderBy: { reference: 'asc' },
      select: {
        id: true,
        reference: true,
        status: true,
        activeDelay: true,
        currentLatitude: true,
        currentLongitude: true,
        progress: true,
        speedKmph: true,
        eta: true,
        arrivedAt: true,
        // The one place outside GET /routes/:id that reads geometry — a service
        // read, never an API response, so the §24 rule still holds.
        route: {
          select: {
            id: true,
            distanceKm: true,
            averageSpeedKmph: true,
            geometry: true,
          },
        },
        shipment: { select: { id: true } },
      },
    });
  },

  async persist(state, reason) {
    const shipmentStatus = reason === null ? undefined : SHIPMENT_STATUS_FOR[reason];

    // One transaction so the truck snapshot, its history row and the mirrored
    // shipment status can never disagree (§18).
    await prisma.$transaction(async (tx) => {
      await tx.truck.update({
        where: { id: state.truckId },
        data: {
          currentLatitude: state.latitude,
          currentLongitude: state.longitude,
          progress: state.progress,
          speedKmph: state.speedKmph,
          eta: state.eta,
          status: state.status,
          arrivedAt: state.arrivedAt,
          lastUpdatedAt: state.lastUpdatedAt,
        },
      });

      if (reason !== null) {
        await tx.locationHistory.create({
          data: {
            truckId: state.truckId,
            latitude: state.latitude,
            longitude: state.longitude,
            progress: state.progress,
            speedKmph: state.speedKmph,
            status: state.status,
            eta: state.eta,
            reason,
            recordedAt: state.lastUpdatedAt,
          },
        });
      }

      if (shipmentStatus !== undefined && state.shipmentId !== null) {
        await tx.shipment.update({
          where: { id: state.shipmentId },
          data: { status: shipmentStatus },
        });
      }
    });
  },
};
