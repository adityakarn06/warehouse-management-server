import type {
  AssignmentStatus,
  DelayScenario,
  DockStatus,
  ShipmentStatus,
  TruckStatus,
} from '../src/generated/prisma/enums.js';
import type { DockingEvent, DockingEventSink } from '../src/docking/docking-events.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Shared fixtures for the two docking suites that **write to the seeded
 * development database**.
 *
 * `read-api.test.ts` asserts exact seeded values, so anything these suites
 * touch has to go back. Phase 8 made that harder: the failure path rewrites
 * seeded assignment rows to `REASSIGNED`/`CANCELLED`, stamps `reassignedAt`,
 * and chains a new row onto them — and `DA-3005` is *seeded* as `REASSIGNED`,
 * so a blanket "reset everything to ASSIGNED" would corrupt the very row the
 * reassignment demo reads. Hence a full field-by-field snapshot rather than a
 * targeted `updateMany`.
 *
 * `pnpm db:seed` is still the reset of last resort if a run is interrupted.
 */

/** Captures what the docking layer emits, in place of a real Socket.IO server. */
export class RecordingSink implements DockingEventSink {
  readonly events: DockingEvent[] = [];

  emit(event: DockingEvent): void {
    this.events.push(event);
  }

  ofType<T extends DockingEvent['type']>(type: T): Extract<DockingEvent, { type: T }>[] {
    return this.events.filter((event): event is Extract<DockingEvent, { type: T }> => event.type === type);
  }
}

interface DockSnapshot {
  id: string;
  status: DockStatus;
  availableFrom: Date | null;
  unavailableReason: string | null;
}

interface AssignmentSnapshot {
  id: string;
  dockDoorId: string;
  status: AssignmentStatus;
  assignedAt: Date | null;
  releasedAt: Date | null;
  reassignedAt: Date | null;
  previousAssignmentId: string | null;
}

export interface YardSnapshot {
  docks: DockSnapshot[];
  assignments: AssignmentSnapshot[];
  alertIds: string[];
}

export async function snapshotYard(): Promise<YardSnapshot> {
  const [docks, assignments, alerts] = await Promise.all([
    prisma.dockDoor.findMany({
      select: { id: true, status: true, availableFrom: true, unavailableReason: true },
    }),
    prisma.dockAssignment.findMany({
      select: {
        id: true,
        dockDoorId: true,
        status: true,
        assignedAt: true,
        releasedAt: true,
        reassignedAt: true,
        previousAssignmentId: true,
      },
    }),
    prisma.alert.findMany({ select: { id: true } }),
  ]);

  return { docks, assignments, alertIds: alerts.map((row) => row.id) };
}

export async function restoreYard(snapshot: YardSnapshot): Promise<void> {
  const seededIds = snapshot.assignments.map((row) => row.id);

  // Rows first: a replacement row still pointing at a seeded one would block
  // restoring that row's own chain, and an assignment on a door blocks its reset.
  await prisma.dockAssignment.deleteMany({ where: { id: { notIn: seededIds } } });
  await prisma.alert.deleteMany({ where: { id: { notIn: snapshot.alertIds } } });

  for (const dock of snapshot.docks) {
    await prisma.dockDoor.update({
      where: { id: dock.id },
      data: {
        status: dock.status,
        availableFrom: dock.availableFrom,
        unavailableReason: dock.unavailableReason,
      },
    });
  }

  for (const assignment of snapshot.assignments) {
    await prisma.dockAssignment.update({
      where: { id: assignment.id },
      data: {
        dockDoorId: assignment.dockDoorId,
        status: assignment.status,
        assignedAt: assignment.assignedAt,
        releasedAt: assignment.releasedAt,
        reassignedAt: assignment.reassignedAt,
        previousAssignmentId: assignment.previousAssignmentId,
      },
    });
  }
}

// --- Fleet snapshot (Phase 9) ----------------------------------------------
//
// `restoreYard` covers doors, assignments and alerts — everything the docking
// suites touch. The WMS feed reaches further: it moves trucks, mirrors
// shipments, rewrites appointment windows and writes location history. Since
// `read-api.test.ts` asserts exact seeded truck and shipment values (TRK-103
// and TRK-106 are the only DELAYED trucks, `summary.delayedTrucks === 2`), a
// WMS suite that skipped this would break it two files later.

interface TruckSnapshot {
  id: string;
  status: TruckStatus;
  activeDelay: DelayScenario;
  currentLatitude: number;
  currentLongitude: number;
  progress: number;
  speedKmph: number;
  eta: Date | null;
  arrivedAt: Date | null;
  lastUpdatedAt: Date;
}

interface AppointmentSnapshot {
  id: string;
  windowStart: Date;
  windowEnd: Date;
  expectedDurationMinutes: number;
  notes: string | null;
}

export interface FleetSnapshot {
  trucks: TruckSnapshot[];
  shipments: { id: string; status: ShipmentStatus }[];
  appointments: AppointmentSnapshot[];
  locationHistoryIds: string[];
}

export async function snapshotFleet(): Promise<FleetSnapshot> {
  const [trucks, shipments, appointments, history] = await Promise.all([
    prisma.truck.findMany({
      select: {
        id: true,
        status: true,
        activeDelay: true,
        currentLatitude: true,
        currentLongitude: true,
        progress: true,
        speedKmph: true,
        eta: true,
        arrivedAt: true,
        lastUpdatedAt: true,
      },
    }),
    prisma.shipment.findMany({ select: { id: true, status: true } }),
    prisma.appointment.findMany({
      select: {
        id: true,
        windowStart: true,
        windowEnd: true,
        expectedDurationMinutes: true,
        notes: true,
      },
    }),
    prisma.locationHistory.findMany({ select: { id: true } }),
  ]);

  return {
    trucks,
    shipments,
    appointments,
    locationHistoryIds: history.map((row) => row.id),
  };
}

export async function restoreFleet(snapshot: FleetSnapshot): Promise<void> {
  await prisma.locationHistory.deleteMany({
    where: { id: { notIn: snapshot.locationHistoryIds } },
  });

  for (const truck of snapshot.trucks) {
    await prisma.truck.update({
      where: { id: truck.id },
      data: {
        status: truck.status,
        activeDelay: truck.activeDelay,
        currentLatitude: truck.currentLatitude,
        currentLongitude: truck.currentLongitude,
        progress: truck.progress,
        speedKmph: truck.speedKmph,
        eta: truck.eta,
        arrivedAt: truck.arrivedAt,
        lastUpdatedAt: truck.lastUpdatedAt,
      },
    });
  }

  for (const shipment of snapshot.shipments) {
    await prisma.shipment.update({ where: { id: shipment.id }, data: { status: shipment.status } });
  }

  for (const appointment of snapshot.appointments) {
    await prisma.appointment.update({
      where: { id: appointment.id },
      data: {
        windowStart: appointment.windowStart,
        windowEnd: appointment.windowEnd,
        expectedDurationMinutes: appointment.expectedDurationMinutes,
        notes: appointment.notes,
      },
    });
  }
}
