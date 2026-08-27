import { env } from '../config/index.js';
import { handleDockFailure } from '../docking/dock-failure-service.js';
import type { ReassignmentOutcome } from '../docking/dock-failure-service.js';
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
import type { DockScheduleResponse, Pagination } from '../types/api.js';
import type { AlertCreatedPayload } from '../websocket/events.js';
import { createAlert } from './alert-service.js';
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  COMMITTED_ASSIGNMENT_STATUSES,
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

// --- Availability command (Phase 7, cascade in Phase 8) ----------------

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
   * The committed assignments the door was holding when the command arrived.
   * Reported as they were *before* the cascade ran; where each of those trucks
   * ended up is `reassignments`.
   */
  affectedAssignments: Awaited<ReturnType<typeof findDockRow>>['assignments'];
  /** The `DOCK_UNAVAILABLE` alert, when the door went down holding something. */
  alert: AlertCreatedPayload | null;
  /** One entry per affected truck: where it moved, or why it could not (§10). */
  reassignments: ReassignmentOutcome[];
}

/**
 * `PATCH /api/v1/docks/:dockId/status`. The frontend sends a status and nothing
 * else; the backend owns every consequence (§2, §8).
 *
 * Taking down a door that holds committed assignments raises one
 * `DOCK_UNAVAILABLE` alert and then hands the affected trucks to
 * `handleDockFailure`, which moves each of them or says `NO_DOCK_AVAILABLE`.
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
      reassignments: [],
    };
  }

  // Earliest-slot-first, matching the order `handleDockFailure` resolves them
  // in, so the alert names the same truck the cascade deals with first. The
  // default `assignmentRecencyOrder` is newest-first, which on a multi-booking
  // door would point at a different truck than the timeline that follows.
  const affected = [...dock.assignments].sort((a, b) => {
    const left = a.scheduledStart?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const right = b.scheduledStart?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.id.localeCompare(b.id);
  });

  const held = affected[0] ?? null;

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
        // Deliberately says nothing about what happens next: this alert is
        // written before the cascade runs, and promising a reassignment here
        // would be a lie on the no-dock path. The alert that follows says where
        // each truck actually ended up.
        message: `${dock.code} is unavailable (${nextReason}). ${affected
          .map((row) => row.truck.reference)
          .join(', ')} was assigned to it.`,
        dockDoorId: dock.id,
        truckId: held?.truck.id ?? null,
        shipmentId: held?.shipmentId ?? null,
        metadata: {
          reason: nextReason,
          affectedAssignments: affected.map((row) => row.id),
          affectedTrucks: affected.map((row) => row.truck.reference),
        },
      });

      alert = alertCreatedPayload(record);
      sink.emit({ type: 'ALERT_CREATED', data: alert });
    } catch (error) {
      logger.error(`Failed to write DOCK_UNAVAILABLE alert for ${dock.code}`, error);
    }
  }

  // Phase 8: the backend, not the frontend, decides where those trucks go (§2).
  // This runs *after* the door is already UNAVAILABLE in the database, which is
  // what makes the ordinary hard filter exclude it from its own trucks' options.
  const reassignments =
    status === 'UNAVAILABLE' && dock.assignments.length > 0
      ? await handleDockFailure(
          { id: dock.id, code: dock.code, reason: nextReason },
          affected,
          now,
        )
      : [];

  return {
    // Re-read last: the cascade may have freed this door's `availableFrom`.
    dock: await getDockById(dock.id),
    changed: true,
    affectedAssignments: dock.assignments,
    alert,
    reassignments,
  };
}

// --- Dock-door assignment schedule (problem statement §7 output) -------

const scheduleAssignmentSelect = {
  id: true,
  status: true,
  score: true,
  reasons: true,
  scheduledStart: true,
  scheduledEnd: true,
  truck: { select: { id: true, reference: true, trailerId: true } },
  shipment: { select: { reference: true, priority: true, loadType: true } },
} as const;

export interface DockScheduleFilters {
  from?: Date | undefined;
  to?: Date | undefined;
  includeRecommended?: boolean | undefined;
}

/**
 * A forward-looking, per-dock timeline — as opposed to `getDockById`, which is
 * a single door's *history* ordered by recency. Defaults to committed
 * (`ASSIGNED`) rows only, matching every other read on this door: a
 * `RECOMMENDED` row is a proposal, never a booking on the board.
 */
export async function getDockSchedule(
  filters: DockScheduleFilters = {},
  now = new Date(),
): Promise<DockScheduleResponse> {
  const from = filters.from ?? now;
  const to = filters.to ?? new Date(now.getTime() + env.ARRIVAL_HORIZON_MINUTES * 60_000);
  const includeRecommended = filters.includeRecommended ?? false;

  const statuses = includeRecommended ? ACTIVE_ASSIGNMENT_STATUSES : COMMITTED_ASSIGNMENT_STATUSES;

  const docks = await prisma.dockDoor.findMany({
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      zone: true,
      status: true,
      assignments: {
        where: {
          status: { in: statuses },
          // A null scheduledStart/End is not "no window" — `dockStillTakes` in
          // the assignment engine treats it as occupying the door outright, so
          // the schedule must show it too, or a booked door reads as free here.
          OR: [
            { scheduledStart: { lte: to }, scheduledEnd: { gte: from } },
            { scheduledStart: null },
            { scheduledEnd: null },
          ],
        },
        orderBy: { scheduledStart: 'asc' },
        select: scheduleAssignmentSelect,
      },
    },
  });

  return {
    generatedAt: now.toISOString(),
    from: from.toISOString(),
    to: to.toISOString(),
    includeRecommended,
    docks: docks.map((dock) => ({
      dockId: dock.id,
      dockCode: dock.code,
      dockName: dock.name,
      zone: dock.zone,
      status: dock.status,
      assignments: dock.assignments.map((row) => ({
        id: row.id,
        status: row.status,
        truckId: row.truck.id,
        truckReference: row.truck.reference,
        trailerId: row.truck.trailerId,
        shipmentReference: row.shipment?.reference ?? null,
        priority: row.shipment?.priority ?? null,
        loadType: row.shipment?.loadType ?? null,
        score: row.score,
        reasons: row.reasons,
        scheduledStart: row.scheduledStart?.toISOString() ?? null,
        scheduledEnd: row.scheduledEnd?.toISOString() ?? null,
      })),
    })),
  };
}
