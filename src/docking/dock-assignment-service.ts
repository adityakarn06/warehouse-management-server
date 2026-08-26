import { env } from '../config/index.js';
import type { Prisma } from '../generated/prisma/client.js';
import type {
  AssignmentStatus,
  DockStatus,
  LoadType,
  Priority,
  TruckStatus,
} from '../generated/prisma/enums.js';
import { HttpError } from '../lib/http-error.js';
import { withYardLock } from './dock-lock.js';
import { prisma } from '../lib/prisma.js';
import { assignmentRecencyOrder, committedAssignmentWhere } from '../services/selects.js';
import { dockingSink, dockReassignedEvent, dockStatusChangedEvent } from './docking-events.js';
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
 * Phase 8 added `reassignDock()`: the same engine, driven by a door going down
 * rather than by an operator picking a dock. It is the only writer of the
 * `REASSIGNED` + `previousAssignmentId` chain — a manual re-pick still cancels.
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
    // `createdAt` alone is not unique (the seed stamps a batch), so without the
    // id tiebreak any `[0]` read here would be non-deterministic.
    orderBy: assignmentRecencyOrder,
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

/** The window a truck is being committed to — shared by both write paths. */
interface Slot {
  start: Date;
  end: Date;
  minutes: number;
}

/**
 * The slot the truck is being scored for: it cannot start before it arrives,
 * and it cannot start before its booked window opens.
 */
function slotFor(truck: TruckContext, now: Date): Slot {
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
  // Only discount it when this truck is the *sole* holder, though — another
  // truck's reservation still has to count against the door.
  const heldBySelf = dock.assignments.some((row) => row.truckId === truckId);
  const heldByOthers = dock.assignments.some((row) => row.truckId !== truckId);

  return {
    id: dock.id,
    code: dock.code,
    name: dock.name,
    zone: dock.zone,
    status: dock.status,
    supportedLoadTypes: [...dock.supportedLoadTypes],
    availableFrom: heldBySelf && !heldByOthers ? null : dock.availableFrom,
    unavailableReason: dock.unavailableReason,
    bookedWindows: dock.assignments
      .filter((row) => row.truckId !== truckId && row.scheduledStart && row.scheduledEnd)
      .map((row) => ({ start: row.scheduledStart as Date, end: row.scheduledEnd as Date })),
  };
}

/** Either the door still takes this truck, or the sentence saying why not. */
type DoorRecheck = { ok: true; status: DockStatus } | { ok: false; reason: string };

/**
 * Can this door still take this truck, *right now, inside the transaction*?
 *
 * `scoreDocks` already ran the same two questions, but it ran them before the
 * write: two operators pressing the button at the same moment would both see a
 * free door, and a door can go out of service in between. Re-asking inside the
 * transaction — against the door's live row, not the scoring snapshot — closes
 * that window. Postgres runs READ COMMITTED, so this narrows the race rather
 * than eliminating it; the only complete fix is an exclusion constraint, which
 * is more migration than a hackathon demo needs (§26).
 *
 * The caller must reserve against the returned `status`, not the scored one:
 * flipping a door that has since gone `UNAVAILABLE` to `RESERVED` would clear
 * the fault from the board while leaving `unavailableReason` behind.
 *
 * The truck's own rows never count against it: it cannot double-book itself.
 */
async function dockStillTakes(
  tx: Prisma.TransactionClient,
  dockDoorId: string,
  truckId: string,
  slot: Slot,
): Promise<DoorRecheck> {
  const dock = await tx.dockDoor.findUnique({
    where: { id: dockDoorId },
    select: { status: true, unavailableReason: true },
  });

  if (!dock) {
    return { ok: false, reason: 'the door no longer exists' };
  }

  if (dock.status === 'UNAVAILABLE') {
    return {
      ok: false,
      reason: dock.unavailableReason
        ? `it went out of service: ${dock.unavailableReason}`
        : 'it went out of service',
    };
  }

  const clashes = await tx.dockAssignment.count({
    where: {
      dockDoorId,
      truckId: { not: truckId },
      ...committedAssignmentWhere,
      // A committed row with no scheduled window counts as a clash rather than
      // as "no overlap": Prisma's comparisons never match NULL, so the naive
      // overlap test would wave a windowless booking straight through.
      OR: [
        { scheduledStart: { lt: slot.end }, scheduledEnd: { gt: slot.start } },
        { scheduledStart: null },
        { scheduledEnd: null },
      ],
    },
  });

  if (clashes > 0) {
    return { ok: false, reason: 'another truck was committed to it for this slot' };
  }

  return { ok: true, status: dock.status };
}

/**
 * A door that just lost its bookings should not keep claiming it is busy until
 * their old end time. Only nulls `availableFrom` when nothing committed is left.
 */
async function clearAvailabilityIfUnheld(
  tx: Prisma.TransactionClient,
  dockDoorId: string,
): Promise<void> {
  const stillHeld = await tx.dockAssignment.count({
    where: { dockDoorId, ...committedAssignmentWhere },
  });

  if (stillHeld === 0) {
    await tx.dockDoor.update({ where: { id: dockDoorId }, data: { availableFrom: null } });
  }
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
  requestedWindow: Slot;
  currentAssignment: CurrentAssignmentView | null;
  recommendations: DockScore[];
  excluded: ExcludedDock[];
}

interface LoadedContext {
  truck: TruckContext;
  ctx: ScoringContext;
  slot: Slot;
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
  // Serialised against every other yard write: scoring reads before the write,
  // so two concurrent callers would otherwise both see the same door free.
  return withYardLock(`assignDock ${truckIdOrReference}`, () =>
    runAssignDock(truckIdOrReference, dockIdOrCode, now),
  );
}

async function runAssignDock(
  truckIdOrReference: string,
  dockIdOrCode: string | undefined,
  now: Date,
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
  const { assignment, freedDockStatus, reserved } = await prisma.$transaction(async (tx) => {
    let freed: FreedDock | null = null;

    if (current) {
      // Unconditional: leaving the old row ASSIGNED would give the truck two
      // live assignments even if its old door could not be resolved below.
      await tx.dockAssignment.update({
        where: { id: current.id },
        // Manual re-pick, not a dock failure: REASSIGNED + previousAssignmentId
        // stays reserved for Phase 8's failure chain.
        data: { status: 'CANCELLED', releasedAt: now },
      });
    }

    if (current && previousDock) {
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

    // Scoring saw a free door, but that read happened before this write.
    const recheck = await dockStillTakes(tx, chosen.dockId, truck.id, slot);

    if (!recheck.ok) {
      throw HttpError.conflict(
        `Dock ${chosen.dockCode} can no longer take ${truck.reference}: ${recheck.reason} — ask for recommendations again`,
      );
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

    // AVAILABLE -> RESERVED, off the door's *live* status. OCCUPIED is the WMS's
    // transition (a truck that has physically backed in), so an already-occupied
    // door keeps its status.
    const reserved = recheck.status === 'AVAILABLE';

    if (reserved) {
      await tx.dockDoor.update({
        where: { id: chosen.dockId },
        data: { status: 'RESERVED', availableFrom: slot.end },
      });
    }

    return { assignment: created, freedDockStatus: freed, reserved };
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

  if (reserved) {
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
    // `recommendationView` is built from the pre-write context, so its
    // `currentAssignment` still names the door the truck just left. The
    // authoritative answer is the row we just wrote.
    currentAssignment: {
      id: assignment.id,
      dockDoorId: assignment.dockDoorId,
      dockCode: assignment.dockDoor.code,
      status: assignment.status,
    },
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
  releasedAssignmentIds: string[];
}

/**
 * Completes whatever committed assignment holds a door and hands the door back
 * to the yard. Used when a truck finishes, and by operations to clear a door
 * that is stuck holding a stale booking.
 */
export async function releaseDock(dockIdOrCode: string, now = new Date()): Promise<ReleaseResult> {
  return withYardLock(`releaseDock ${dockIdOrCode}`, () => runReleaseDock(dockIdOrCode, now));
}

async function runReleaseDock(dockIdOrCode: string, now: Date): Promise<ReleaseResult> {
  const dock = await findDock(dockIdOrCode);
  const held = dock.assignments;

  const { updated, liveStatusBefore } = await prisma.$transaction(async (tx) => {
    if (held.length > 0) {
      // Every committed row, not just the newest: handing the door back while
      // one of them is still ASSIGNED would report a committed door as free.
      await tx.dockAssignment.updateMany({
        where: { id: { in: held.map((row) => row.id) } },
        data: { status: 'COMPLETED', releasedAt: now },
      });
    }

    // Re-read inside the transaction rather than trusting `findDock`'s snapshot:
    // that read happened before the transaction opened, and a door taken out of
    // service in between must not be handed back to the yard on the strength of
    // a stale AVAILABLE. Same reasoning as `dockStillTakes`.
    const live = await tx.dockDoor.findUniqueOrThrow({
      where: { id: dock.id },
      select: { id: true, code: true, status: true, unavailableReason: true },
    });

    // A door that is out of service stays out of service — releasing a booking
    // does not silently put a broken dock back into rotation.
    if (live.status === 'UNAVAILABLE') {
      return { updated: live, liveStatusBefore: live.status };
    }

    return {
      updated: await tx.dockDoor.update({
        where: { id: dock.id },
        data: { status: 'AVAILABLE', availableFrom: null },
        select: { id: true, code: true, status: true, unavailableReason: true },
      }),
      liveStatusBefore: live.status,
    };
  });

  // Compared against the status read *inside* the transaction, not against
  // `findDock`'s earlier snapshot. If the door went UNAVAILABLE in between, the
  // stale comparison would emit a second DOCK_STATUS_CHANGED reporting an
  // AVAILABLE -> UNAVAILABLE transition this call never made — and that
  // `setDockStatus` has already broadcast.
  if (updated.status !== liveStatusBefore) {
    dockingSink().emit(dockStatusChangedEvent(updated, liveStatusBefore, now));
  }

  return {
    dockDoorId: updated.id,
    dockCode: updated.code,
    status: updated.status,
    releasedAssignmentIds: held.map((row) => row.id),
  };
}

// --- Reassignment after a dock failure (Phase 8) -----------------------

export interface ReassignPrevious {
  id: string;
  dockDoorId: string;
  dockCode: string;
}

export interface ReassignResult {
  /** `REASSIGNED` when a replacement was found; `NO_DOCK_AVAILABLE` when not. */
  outcome: 'REASSIGNED' | 'NO_DOCK_AVAILABLE';
  truck: RecommendationTruckView;
  shipmentId: string | null;
  loadType: LoadType | null;
  previous: ReassignPrevious;
  /** The replacement row, or `null` when nothing compatible was left. */
  assignment: Awaited<ReturnType<typeof currentAssignmentFor>>;
  /** What the engine considered, so the alert can explain itself. */
  candidates: DockScore[];
  excluded: ExcludedDock[];
}

/**
 * Moves a truck off a door that has just gone out of service.
 *
 * The caller (`dock-failure-service`) has already flipped the door to
 * `UNAVAILABLE`, which means the engine excludes it from its own truck's
 * candidates through the ordinary hard filter — there is no special case here
 * for "the dock we are running away from".
 *
 * This is the **only** writer of the `REASSIGNED` + `previousAssignmentId`
 * chain (seeded as DA-3005 -> DA-3006). A manual re-pick through `assignDock`
 * cancels instead, so the timeline distinguishes "operations moved this truck"
 * from "the yard forced this truck to move".
 *
 * When nothing fits we do not invent a dock (§10): the old row is `CANCELLED`
 * and the truck is left genuinely unassigned rather than parked on a door that
 * cannot open.
 */
export async function reassignDock(
  truckIdOrReference: string,
  previousAssignmentId: string,
  reason: string,
  now = new Date(),
): Promise<ReassignResult> {
  // The failure cascade calls this once per affected truck, and each call is
  // hunting the same shrinking pool of doors — exactly the case the lock exists
  // for. `handleDockFailure` stays outside it so the loop does not self-deadlock.
  return withYardLock(`reassignDock ${truckIdOrReference}`, () =>
    runReassignDock(truckIdOrReference, previousAssignmentId, reason, now),
  );
}

async function runReassignDock(
  truckIdOrReference: string,
  previousAssignmentId: string,
  reason: string,
  now: Date,
): Promise<ReassignResult> {
  const previous = await prisma.dockAssignment.findUnique({
    where: { id: previousAssignmentId },
    select: assignmentSelect,
  });

  if (!previous) {
    throw HttpError.notFound(`Dock assignment ${previousAssignmentId} was not found`);
  }

  const loaded = await loadContext(truckIdOrReference, now);
  const { truck, slot, scored } = loaded;

  const previousView: ReassignPrevious = {
    id: previous.id,
    dockDoorId: previous.dockDoorId,
    dockCode: previous.dockDoor.code,
  };

  // One transaction per truck: superseding the old row, writing the
  // replacement and reserving its door must not be observable half-done (§18).
  // Deliberately *not* one transaction for the whole outage — one truck's move
  // failing must not roll back another truck's successful one.
  const committed = await prisma.$transaction(async (tx) => {
    let chosen: DockScore | null = null;
    let liveStatus: DockStatus | null = null;

    // Walk the ranking rather than trusting `[0]`: a door that was free when we
    // scored may have been committed to someone else — or have gone out of
    // service itself — in between.
    for (const candidate of scored.recommendations) {
      const recheck = await dockStillTakes(tx, candidate.dockId, truck.id, slot);

      if (recheck.ok) {
        chosen = candidate;
        liveStatus = recheck.status;
        break;
      }
    }

    if (!chosen) {
      // Conditional on the row still being the committed one we read: a
      // concurrent release or re-pick must win rather than be overwritten.
      const cancelled = await tx.dockAssignment.updateMany({
        where: { id: previous.id, truckId: truck.id, ...committedAssignmentWhere },
        data: { status: 'CANCELLED', releasedAt: now },
      });

      if (cancelled.count === 0) {
        throw HttpError.conflict(
          `Assignment ${previous.id} is no longer the committed booking for ${truck.reference}`,
        );
      }

      await clearAvailabilityIfUnheld(tx, previous.dockDoorId);

      return { chosen: null, assignment: null, reserved: null };
    }

    // REASSIGNED keeps `releasedAt` null and stamps `reassignedAt` — the shape
    // the seeded DA-3005 row documents. Same conditional guard as above, so a
    // row that has since been released is never rewritten.
    const superseded = await tx.dockAssignment.updateMany({
      where: { id: previous.id, truckId: truck.id, ...committedAssignmentWhere },
      data: { status: 'REASSIGNED', reassignedAt: now },
    });

    if (superseded.count === 0) {
      throw HttpError.conflict(
        `Assignment ${previous.id} is no longer the committed booking for ${truck.reference}`,
      );
    }

    // The superseded row must already exist for the FK to resolve, which the
    // update above guarantees. `previousAssignmentId` is unique, so a second
    // failure chains forward from this new row, never re-points at the old one.
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
        previousAssignmentId: previous.id,
      },
      select: assignmentSelect,
    });

    let reserved: { id: string; code: string } | null = null;

    if (liveStatus === 'AVAILABLE') {
      await tx.dockDoor.update({
        where: { id: chosen.dockId },
        data: { status: 'RESERVED', availableFrom: slot.end },
      });
      reserved = { id: chosen.dockId, code: chosen.dockCode };
    }

    await clearAvailabilityIfUnheld(tx, previous.dockDoorId);

    return { chosen, assignment: created, reserved };
  });

  const sink = dockingSink();

  if (committed.reserved) {
    sink.emit(
      dockStatusChangedEvent(
        {
          id: committed.reserved.id,
          code: committed.reserved.code,
          status: 'RESERVED',
          unavailableReason: null,
        },
        'AVAILABLE',
        now,
      ),
    );
  }

  if (committed.assignment) {
    sink.emit(
      dockReassignedEvent(
        {
          id: committed.assignment.id,
          truckId: truck.id,
          shipmentId: truck.shipment?.id ?? null,
          dockDoorId: committed.assignment.dockDoorId,
          dockCode: committed.assignment.dockDoor.code,
          status: committed.assignment.status,
          score: committed.assignment.score,
          reasons: committed.assignment.reasons,
        },
        previousView,
        reason,
        now,
      ),
    );
  }

  return {
    outcome: committed.assignment ? 'REASSIGNED' : 'NO_DOCK_AVAILABLE',
    truck: {
      id: truck.id,
      reference: truck.reference,
      status: truck.status,
      eta: truck.eta,
      progress: truck.progress,
    },
    shipmentId: truck.shipment?.id ?? null,
    loadType: truck.shipment?.loadType ?? null,
    previous: previousView,
    assignment: committed.assignment,
    candidates: scored.recommendations,
    excluded: scored.excluded,
  };
}
