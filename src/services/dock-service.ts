import {
  alertCreatedPayload,
  dockingSink,
  dockStatusChangedEvent,
} from '../docking/docking-events.js';
import type { DockStatus, LoadType } from '../generated/prisma/enums.js';
import { HttpError } from '../lib/http-error.js';
import { logger } from '../lib/logger.js';
import { compact } from '../lib/object.js';
import { prisma } from '../lib/prisma.js';
import type { Pagination } from '../types/api.js';
import type { AlertCreatedPayload } from '../websocket/events.js';
import { createAlert } from './alert-service.js';
import {
  assignmentRecencyOrder,
  committedAssignmentWhere,
  truckSummarySelect,
} from './selects.js';

export interface DockListFilters extends Pagination {
  status?: DockStatus | undefined;
  zone?: string | undefined;
  loadType?: LoadType | undefined;
}

// Committed-only: a RECOMMENDED row is a proposal, and reporting one here
// would show an AVAILABLE door as occupied.
const currentAssignmentSelect = {
  where: committedAssignmentWhere,
  orderBy: assignmentRecencyOrder,
  take: 1,
  select: {
    id: true,
    status: true,
    score: true,
    reasons: true,
    scheduledStart: true,
    scheduledEnd: true,
    assignedAt: true,
    truck: {
      select: { id: true, reference: true, trailerId: true, status: true, eta: true },
    },
    shipment: { select: { id: true, reference: true, priority: true, loadType: true } },
  },
} as const;

export async function listDocks(filters: DockListFilters) {
  const where = compact({
    status: filters.status,
    zone: filters.zone,
    // `supportedLoadTypes` is a scalar list — `has` matches docks that support it.
    supportedLoadTypes: filters.loadType ? { has: filters.loadType } : undefined,
  });

  const [items, total] = await prisma.$transaction([
    prisma.dockDoor.findMany({
      where,
      orderBy: { code: 'asc' },
      skip: filters.offset,
      take: filters.limit,
      select: {
        id: true,
        code: true,
        name: true,
        zone: true,
        status: true,
        supportedLoadTypes: true,
        latitude: true,
        longitude: true,
        availableFrom: true,
        unavailableReason: true,
        assignments: currentAssignmentSelect,
      },
    }),
    prisma.dockDoor.count({ where }),
  ]);

  return { items, total };
}

const ALERT_LIMIT = 10;
const ASSIGNMENT_HISTORY_LIMIT = 20;

const dockDetailSelect = {
  id: true,
  code: true,
  name: true,
  zone: true,
  status: true,
  supportedLoadTypes: true,
  latitude: true,
  longitude: true,
  availableFrom: true,
  unavailableReason: true,
  createdAt: true,
  updatedAt: true,
  assignments: {
    orderBy: assignmentRecencyOrder,
    take: ASSIGNMENT_HISTORY_LIMIT,
    select: {
      id: true,
      status: true,
      score: true,
      reasons: true,
      scheduledStart: true,
      scheduledEnd: true,
      assignedAt: true,
      releasedAt: true,
      reassignedAt: true,
      truck: { select: truckSummarySelect },
      shipment: { select: { id: true, reference: true, priority: true, loadType: true } },
    },
  },
  alerts: {
    where: { acknowledged: false },
    orderBy: { createdAt: 'desc' },
    take: ALERT_LIMIT,
    select: {
      id: true,
      type: true,
      severity: true,
      title: true,
      message: true,
      createdAt: true,
    },
  },
} as const;

/** Looks up by primary key, then falls back to `code` (see `getTruckById`). */
export async function getDockById(idOrCode: string) {
  const byId = await prisma.dockDoor.findUnique({
    where: { id: idOrCode },
    select: dockDetailSelect,
  });
  if (byId) return byId;

  const byCode = await prisma.dockDoor.findUnique({
    where: { code: idOrCode },
    select: dockDetailSelect,
  });
  if (byCode) return byCode;

  throw HttpError.notFound(`Dock door ${idOrCode} was not found`);
}

// --- Availability command (Phase 7) ------------------------------------

/** Only these two are operator-settable; RESERVED/OCCUPIED are engine-owned. */
export type DockAvailabilityStatus = Extract<DockStatus, 'AVAILABLE' | 'UNAVAILABLE'>;

const DEFAULT_UNAVAILABLE_REASON = 'Marked unavailable by operations';

const dockCommandSelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  availableFrom: true,
  unavailableReason: true,
  assignments: {
    where: committedAssignmentWhere,
    orderBy: assignmentRecencyOrder,
    select: {
      id: true,
      scheduledStart: true,
      scheduledEnd: true,
      shipmentId: true,
      truck: { select: { id: true, reference: true, status: true, eta: true } },
    },
  },
} as const;

async function findDockRow(idOrCode: string) {
  const byId = await prisma.dockDoor.findUnique({ where: { id: idOrCode }, select: dockCommandSelect });
  if (byId) return byId;

  const byCode = await prisma.dockDoor.findUnique({ where: { code: idOrCode }, select: dockCommandSelect });
  if (byCode) return byCode;

  throw HttpError.notFound(`Dock door ${idOrCode} was not found`);
}

export interface DockStatusResult {
  dock: Awaited<ReturnType<typeof getDockById>>;
  /** False when the door was already in that state — pressing twice is a no-op success. */
  changed: boolean;
  /**
   * Committed assignments the door is still holding. Phase 7 leaves them where
   * they are and only reports them; automatic reassignment is Phase 8 (§10).
   */
  affectedAssignments: Awaited<ReturnType<typeof findDockRow>>['assignments'];
  alert: AlertCreatedPayload | null;
}

/**
 * `PATCH /api/v1/docks/:dockId/status`. The frontend sends a status and nothing
 * else; the backend owns every consequence (§2, §8).
 */
export async function setDockStatus(
  idOrCode: string,
  status: DockAvailabilityStatus,
  reason?: string,
  now = new Date(),
): Promise<DockStatusResult> {
  const dock = await findDockRow(idOrCode);
  const previousStatus = dock.status;

  // Taking a door out of service is only meaningful once, and putting one back
  // only applies to a door that is actually out of service. Re-stating the
  // reason for a door that is already down is not a no-op, though: the new
  // reason is what every `excluded` sentence will quote from here on.
  const nextReason = reason ?? DEFAULT_UNAVAILABLE_REASON;
  const noop =
    status === 'UNAVAILABLE'
      ? previousStatus === 'UNAVAILABLE' && dock.unavailableReason === nextReason
      : previousStatus !== 'UNAVAILABLE';

  if (noop) {
    return {
      dock: await getDockById(dock.id),
      changed: false,
      affectedAssignments: dock.assignments,
      alert: null,
    };
  }

  const held = dock.assignments[0] ?? null;

  // The door is free again once its *last* booking ends, not its most recently
  // created one — and `scheduledEnd` is nullable, so fall back to whatever the
  // door already claimed rather than asserting it is free now.
  const scheduledEnds = dock.assignments
    .map((row) => row.scheduledEnd)
    .filter((end): end is Date => end !== null);
  const heldUntil = scheduledEnds.length
    ? new Date(Math.max(...scheduledEnds.map((end) => end.getTime())))
    : dock.availableFrom;

  const data =
    status === 'UNAVAILABLE'
      ? { status, unavailableReason: nextReason }
      : held
        ? // A booking survived the outage, so the honest state is RESERVED —
          // reporting AVAILABLE would show a taken door as free.
          { status: 'RESERVED' as const, unavailableReason: null, availableFrom: heldUntil }
        : { status, unavailableReason: null, availableFrom: null };

  const updated = await prisma.dockDoor.update({
    where: { id: dock.id },
    data,
    select: { id: true, code: true, status: true, unavailableReason: true },
  });

  const sink = dockingSink();
  sink.emit(dockStatusChangedEvent(updated, previousStatus, now));

  let alert: AlertCreatedPayload | null = null;

  if (status === 'UNAVAILABLE' && dock.assignments.length > 0) {
    // Losing the audit row must not fail the command — the door is
    // authoritatively out of service either way (same rule as the delay path).
    try {
      const record = await createAlert({
        type: 'DOCK_UNAVAILABLE',
        severity: 'WARNING',
        title: `${dock.code} taken out of service`,
        message: `${dock.code} is unavailable (${nextReason}). ${dock.assignments
          .map((row) => row.truck.reference)
          .join(', ')} still assigned to it.`,
        dockDoorId: dock.id,
        truckId: held?.truck.id ?? null,
        shipmentId: held?.shipmentId ?? null,
        metadata: {
          reason: nextReason,
          affectedAssignments: dock.assignments.map((row) => row.id),
          affectedTrucks: dock.assignments.map((row) => row.truck.reference),
        },
      });

      alert = alertCreatedPayload(record);
      sink.emit({ type: 'ALERT_CREATED', data: alert });
    } catch (error) {
      logger.error(`Failed to write DOCK_UNAVAILABLE alert for ${dock.code}`, error);
    }
  }

  return {
    dock: await getDockById(dock.id),
    changed: true,
    affectedAssignments: dock.assignments,
    alert,
  };
}
