import { env } from '../config/index.js';
import type {
  AssignmentStatus,
  DockStatus,
  LoadType,
  Priority,
  TruckStatus,
} from '../generated/prisma/enums.js';
import { HttpError } from '../lib/http-error.js';
import { prisma } from '../lib/prisma.js';
import { assignmentRecencyOrder, committedAssignmentWhere } from '../services/selects.js';
import { dockingSink, dockStatusChangedEvent } from './docking-events.js';
import { scoreDocks } from './dock-scoring.js';
import type { DockScore, ExcludedDock, ScoringContext, ScoringDock } from './dock-scoring.js';

/**
 * The dock assignment engine's write side (CLAUDE.md §9, §19).
 *
 * Not to be confused with `src/services/dock-assignment-service.ts`, which is
 * the read side (`GET /api/v1/dock-assignments`). This module owns every
 * consequence of a recommendation being *taken*: the assignment rows, the dock
 * door's own status, and the realtime events that follow.
 *
 * `reassignDock()` is deliberately absent — automatic reassignment after a dock
 * failure is Phase 8, and a stub here would only pretend otherwise.
 */

const MS_PER_MINUTE = 60_000;

// --- Loading the scoring context ---------------------------------------

const truckContextSelect = {
  id: true,
  reference: true,
  status: true,
  eta: true,
  progress: true,
  shipment: {
    select: {
      id: true,
      reference: true,
      priority: true,
      loadType: true,
      appointment: {
        select: {
          id: true,
          reference: true,
          windowStart: true,
          windowEnd: true,
          expectedDurationMinutes: true,
        },
      },
    },
  },
} as const;

const dockCandidateSelect = {
  id: true,
  code: true,
  name: true,
  zone: true,
  status: true,
  supportedLoadTypes: true,
  availableFrom: true,
  unavailableReason: true,
  assignments: {
    where: committedAssignmentWhere,
    select: { id: true, truckId: true, scheduledStart: true, scheduledEnd: true },
  },
} as const;

const assignmentSelect = {
  id: true,
  status: true,
  score: true,
  reasons: true,
  scheduledStart: true,
  scheduledEnd: true,
  assignedAt: true,
  releasedAt: true,
  reassignedAt: true,
  createdAt: true,
  truckId: true,
  shipmentId: true,
  dockDoorId: true,
  dockDoor: { select: { id: true, code: true, name: true, zone: true, status: true } },
} as const;

/** Id-first, then human reference — the convention every detail lookup follows. */
async function findTruck(idOrReference: string) {
  const byId = await prisma.truck.findUnique({
    where: { id: idOrReference },
    select: truckContextSelect,
  });
  if (byId) return byId;

  const byReference = await prisma.truck.findUnique({
    where: { reference: idOrReference },
    select: truckContextSelect,
  });
  if (byReference) return byReference;

  throw HttpError.notFound(`Truck ${idOrReference} was not found`);
}

async function findDock(idOrCode: string) {
  const byId = await prisma.dockDoor.findUnique({
    where: { id: idOrCode },
    select: dockCandidateSelect,
  });
  if (byId) return byId;

  const byCode = await prisma.dockDoor.findUnique({
    where: { code: idOrCode },
    select: dockCandidateSelect,
  });
  if (byCode) return byCode;

  throw HttpError.notFound(`Dock door ${idOrCode} was not found`);
}

type TruckContext = Awaited<ReturnType<typeof findTruck>>;
type DockCandidate = Awaited<ReturnType<typeof findDock>>;

function laterOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * The slot the truck is being scored for: it cannot start before it arrives,
 * and it cannot start before its booked window opens.
 */
function slotFor(truck: TruckContext, now: Date): { start: Date; end: Date; minutes: number } {
  const appointment = truck.shipment?.appointment ?? null;
  const arrival = truck.eta ?? now;
  const start = appointment ? laterOf(arrival, appointment.windowStart) : arrival;
  const minutes = appointment?.expectedDurationMinutes ?? env.DOCK_DEFAULT_DURATION_MINUTES;

  return { start, end: new Date(start.getTime() + minutes * MS_PER_MINUTE), minutes };
}

function toScoringDock(dock: DockCandidate, truckId: string): ScoringDock {
  // A door this truck already holds is not blocked *for this truck*: both its
  // `availableFrom` and its booked window are that truck's own reservation, and
  // scoring them as a clash would make re-picking the same dock impossible.
  const heldBySelf = dock.assignments.some((row) => row.truckId === truckId);

  return {
    id: dock.id,
    code: dock.code,
    name: dock.name,
    zone: dock.zone,
    status: dock.status,
    supportedLoadTypes: [...dock.supportedLoadTypes],
    availableFrom: heldBySelf ? null : dock.availableFrom,
    unavailableReason: dock.unavailableReason,
    bookedWindows: dock.assignments
      .filter((row) => row.truckId !== truckId && row.scheduledStart && row.scheduledEnd)
      .map((row) => ({ start: row.scheduledStart as Date, end: row.scheduledEnd as Date })),
  };
}

export interface RecommendationTruckView {
  id: string;
  reference: string;
  status: TruckStatus;
  eta: Date | null;
  progress: number;
}

export interface RecommendationShipmentView {
  id: string;
  reference: string;
  priority: Priority;
  loadType: LoadType;
}

export interface RecommendationAppointmentView {
  id: string;
  reference: string;
  windowStart: Date;
  windowEnd: Date;
  expectedDurationMinutes: number;
}

export interface CurrentAssignmentView {
  id: string;
  dockDoorId: string;
  dockCode: string;
  status: AssignmentStatus;
}

export interface RecommendationResult {
  truck: RecommendationTruckView;
  shipment: RecommendationShipmentView | null;
  appointment: RecommendationAppointmentView | null;
  /** The slot the docks were scored against: ETA vs appointment, plus dock time. */
  requestedWindow: { start: Date; end: Date; minutes: number };
  currentAssignment: CurrentAssignmentView | null;
  recommendations: DockScore[];
  excluded: ExcludedDock[];
}

interface LoadedContext {
  truck: TruckContext;
  ctx: ScoringContext;
  slot: { start: Date; end: Date; minutes: number };
  docks: DockCandidate[];
  scored: { recommendations: DockScore[]; excluded: ExcludedDock[] };
  current: Awaited<ReturnType<typeof currentAssignmentFor>>;
}

async function currentAssignmentFor(truckId: string) {
  return prisma.dockAssignment.findFirst({
    where: { truckId, ...committedAssignmentWhere },
    orderBy: assignmentRecencyOrder,
    select: assignmentSelect,
  });
}

async function loadContext(idOrReference: string, now: Date): Promise<LoadedContext> {
  const truck = await findTruck(idOrReference);
  const shipment = truck.shipment;
  const slot = slotFor(truck, now);

  const [docks, current] = await Promise.all([
    prisma.dockDoor.findMany({ orderBy: { code: 'asc' }, select: dockCandidateSelect }),
    currentAssignmentFor(truck.id),
  ]);

  const ctx: ScoringContext = {
    loadType: shipment?.loadType ?? 'GENERAL',
    priority: shipment?.priority ?? 'MEDIUM',
    windowStart: slot.start,
    windowEnd: slot.end,
    appointment: shipment?.appointment
      ? {
          windowStart: shipment.appointment.windowStart,
          windowEnd: shipment.appointment.windowEnd,
          expectedDurationMinutes: shipment.appointment.expectedDurationMinutes,
        }
      : null,
  };

  const scored = scoreDocks(
    docks.map((dock) => toScoringDock(dock, truck.id)),
    ctx,
  );

  return { truck, ctx, slot, docks, scored, current };
}

function recommendationView(loaded: LoadedContext): RecommendationResult {
  const { truck, slot, scored, current } = loaded;

  return {
    truck: {
      id: truck.id,
      reference: truck.reference,
      status: truck.status,
      eta: truck.eta,
      progress: truck.progress,
    },
    shipment: truck.shipment
      ? {
          id: truck.shipment.id,
          reference: truck.shipment.reference,
          priority: truck.shipment.priority,
          loadType: truck.shipment.loadType,
        }
      : null,
    appointment: truck.shipment?.appointment ?? null,
    requestedWindow: slot,
    currentAssignment: current
      ? {
          id: current.id,
          dockDoorId: current.dockDoorId,
          dockCode: current.dockDoor.code,
          status: current.status,
        }
      : null,
    recommendations: scored.recommendations,
    excluded: scored.excluded,
  };
}

// --- Public API --------------------------------------------------------

/**
 * Ranked, explainable dock options for one truck. Deliberately side-effect
 * free: a `GET` must not write `RECOMMENDED` rows, so operations can review
 * the list as often as they like before committing to anything.
 */
export async function recommendDocks(
  truckIdOrReference: string,
  now = new Date(),
): Promise<RecommendationResult> {
  return recommendationView(await loadContext(truckIdOrReference, now));
}

/** A door handed back to the yard as a side effect of moving a truck. */
interface FreedDock {
  id: string;
  code: string;
  status: DockStatus;
  unavailableReason: string | null;
  previousStatus: DockStatus;
}

export interface AssignmentResult extends RecommendationResult {
  /** False when the truck already held this dock — pressing the button twice is a no-op. */
  created: boolean;
  assignment: Awaited<ReturnType<typeof currentAssignmentFor>>;
  /** The row this assignment superseded, if the operator moved the truck. */
  previousAssignment: { id: string; dockDoorId: string; dockCode: string } | null;
}

/**
 * Commits a dock to a truck. `dockIdOrCode` is optional: omitting it takes the
 * top-ranked recommendation, which is what the demo's one-click flow uses.
 *
 * A dock the engine filtered out is refused with a 400 quoting the reason — the
 * backend is the source of truth (§2), so an operator cannot park a
 * refrigerated load on a door that cannot take it.
 */
export async function assignDock(
  truckIdOrReference: string,
  dockIdOrCode?: string,
  now = new Date(),
): Promise<AssignmentResult> {
  const loaded = await loadContext(truckIdOrReference, now);
  const { truck, slot, scored, current } = loaded;

  let chosen: DockScore | undefined;

  if (dockIdOrCode) {
    // 404 before 400: an unknown dock is a different mistake from a bad one.
    const dock = await findDock(dockIdOrCode);
    chosen = scored.recommendations.find((row) => row.dockId === dock.id);

    if (!chosen) {
      const excluded = scored.excluded.find((row) => row.dockId === dock.id);
      throw HttpError.badRequest(
        `Dock ${dock.code} cannot take ${truck.reference}: ${excluded?.reason ?? 'it is not a valid option for this truck'}`,
      );
    }
  } else {
    chosen = scored.recommendations[0];
    if (!chosen) {
      // Phase 8 turns this into a NO_DOCK_AVAILABLE alert; for now it is a
      // plain conflict — we never invent a dock (§10).
      throw HttpError.conflict(`No compatible dock is available for ${truck.reference}`);
    }
  }

  if (current && current.dockDoorId === chosen.dockId) {
    return { ...recommendationView(loaded), created: false, assignment: current, previousAssignment: null };
  }

  const previousDock = current
    ? loaded.docks.find((dock) => dock.id === current.dockDoorId) ?? null
    : null;

  // One transaction: superseding the old row, freeing its door, creating the
  // new row and reserving its door must not be observable half-done (§18).
  const { assignment, freedDockStatus } = await prisma.$transaction(async (tx) => {
    let freed: FreedDock | null = null;

    if (current && previousDock) {
      await tx.dockAssignment.update({
        where: { id: current.id },
        // Manual re-pick, not a dock failure: REASSIGNED + previousAssignmentId
        // stays reserved for Phase 8's failure chain.
        data: { status: 'CANCELLED', releasedAt: now },
      });

      // Only release the door if nothing else still holds it.
      const stillHeld = await tx.dockAssignment.count({
        where: { dockDoorId: previousDock.id, ...committedAssignmentWhere, id: { not: current.id } },
      });

      if (stillHeld === 0 && previousDock.status === 'RESERVED') {
        const updated = await tx.dockDoor.update({
          where: { id: previousDock.id },
          data: { status: 'AVAILABLE', availableFrom: null },
          select: { id: true, code: true, status: true, unavailableReason: true },
        });
        freed = { ...updated, previousStatus: previousDock.status };
      }
    }

    const created = await tx.dockAssignment.create({
      data: {
        truckId: truck.id,
        shipmentId: truck.shipment?.id ?? null,
        dockDoorId: chosen.dockId,
        status: 'ASSIGNED',
        score: chosen.score,
        reasons: chosen.reasons,
        scheduledStart: slot.start,
        scheduledEnd: slot.end,
        assignedAt: now,
      },
      select: assignmentSelect,
    });

    // AVAILABLE -> RESERVED. OCCUPIED is the WMS's transition (a truck that has
    // physically backed in), so an already-occupied door keeps its status.
    if (chosen.status === 'AVAILABLE') {
      await tx.dockDoor.update({
        where: { id: chosen.dockId },
        data: { status: 'RESERVED', availableFrom: slot.end },
      });
    }

    return { assignment: created, freedDockStatus: freed };
  });

  const sink = dockingSink();

  if (freedDockStatus) {
    sink.emit(
      dockStatusChangedEvent(
        {
          id: freedDockStatus.id,
          code: freedDockStatus.code,
          status: freedDockStatus.status,
          unavailableReason: freedDockStatus.unavailableReason,
        },
        freedDockStatus.previousStatus,
        now,
      ),
    );
  }

  if (chosen.status === 'AVAILABLE') {
    sink.emit(
      dockStatusChangedEvent(
        { id: chosen.dockId, code: chosen.dockCode, status: 'RESERVED', unavailableReason: null },
        'AVAILABLE',
        now,
      ),
    );
  }

  sink.emit({
    type: 'DOCK_ASSIGNED',
    data: {
      assignmentId: assignment.id,
      truckId: truck.id,
      shipmentId: truck.shipment?.id ?? null,
      dockDoorId: assignment.dockDoorId,
      dockCode: assignment.dockDoor.code,
      status: assignment.status,
      score: assignment.score,
      reasons: assignment.reasons,
      serverTimestamp: now.toISOString(),
    },
  });

  return {
    ...recommendationView(loaded),
    created: true,
    assignment,
    previousAssignment: current
      ? { id: current.id, dockDoorId: current.dockDoorId, dockCode: current.dockDoor.code }
      : null,
  };
}

export interface ReleaseResult {
  dockDoorId: string;
  dockCode: string;
  status: DockStatus;
  releasedAssignmentId: string | null;
}

/**
 * Completes whatever committed assignment holds a door and hands the door back
 * to the yard. Used when a truck finishes, and by operations to clear a door
 * that is stuck holding a stale booking.
 */
export async function releaseDock(dockIdOrCode: string, now = new Date()): Promise<ReleaseResult> {
  const dock = await findDock(dockIdOrCode);
  const held = dock.assignments[0] ?? null;

  const updated = await prisma.$transaction(async (tx) => {
    if (held) {
      await tx.dockAssignment.update({
        where: { id: held.id },
        data: { status: 'COMPLETED', releasedAt: now },
      });
    }

    // A door that is out of service stays out of service — releasing a booking
    // does not silently put a broken dock back into rotation.
    if (dock.status === 'UNAVAILABLE') {
      return { id: dock.id, code: dock.code, status: dock.status, unavailableReason: dock.unavailableReason };
    }

    return tx.dockDoor.update({
      where: { id: dock.id },
      data: { status: 'AVAILABLE', availableFrom: null },
      select: { id: true, code: true, status: true, unavailableReason: true },
    });
  });

  if (updated.status !== dock.status) {
    dockingSink().emit(dockStatusChangedEvent(updated, dock.status, now));
  }

  return {
    dockDoorId: updated.id,
    dockCode: updated.code,
    status: updated.status,
    releasedAssignmentId: held?.id ?? null,
  };
}
