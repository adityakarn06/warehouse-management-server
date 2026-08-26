import type { DockStatus, LoadType, Priority } from '../generated/prisma/enums.js';

/**
 * The dock recommendation algorithm (CLAUDE.md §9).
 *
 * Deterministic and explainable — no ML, no randomness, no clock, no Prisma.
 * It takes plain data and returns a ranked list plus the reasons that produced
 * each score, so a judge can read *why* D4 won. Everything that touches the
 * database lives in `dock-assignment-service.ts`; this file is pure so it can
 * be tested without one.
 *
 * Reasons deliberately avoid absolute clock times ("free 25 min before the
 * truck is due", not "free at 18:40"): the backend has no idea which timezone
 * the operator is reading, and relative phrasing keeps the tests honest.
 */

// --- Weights -----------------------------------------------------------
// Algorithm constants, not demo knobs, so they stay here rather than in env.
// They sum to 100, which is what makes the score readable as a percentage.
export const WEIGHT_LOAD_TYPE_FIT = 25;
export const WEIGHT_AVAILABILITY_FIT = 30;
export const WEIGHT_APPOINTMENT_FIT = 25;
export const WEIGHT_PRIORITY_FIT = 15;
export const WEIGHT_STATUS_BONUS = 5;

/** Scored when the truck has no appointment: neutral, neither rewarded nor punished. */
const APPOINTMENT_FIT_WITHOUT_APPOINTMENT = 15;

/** A general load loses this much per specialist type a door also supports. */
const SPECIALIST_DOOR_PENALTY = 5;
const LOAD_TYPE_FIT_FLOOR = 10;

const MS_PER_MINUTE = 60_000;

const LOAD_TYPE_LABEL: Record<LoadType, string> = {
  GENERAL: 'general',
  REFRIGERATED: 'refrigerated',
  HAZARDOUS: 'hazardous',
  OVERSIZED: 'oversized',
};

const PRIORITY_LABEL: Record<Priority, string> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/** How hard a priority punishes waiting. Urgent freight weights lateness double. */
const PRIORITY_LATENESS_WEIGHT: Record<Priority, number> = {
  LOW: 0.5,
  MEDIUM: 0.5,
  HIGH: 1,
  CRITICAL: 1,
};

const STATUS_BONUS: Record<DockStatus, number> = {
  AVAILABLE: 5,
  RESERVED: 3,
  OCCUPIED: 0,
  UNAVAILABLE: 0, // filtered out before scoring; here only to keep the map total
};

// --- Inputs ------------------------------------------------------------

export interface BookedWindow {
  start: Date;
  end: Date;
}

/** A dock door as the scorer sees it — no Prisma types, no relations. */
export interface ScoringDock {
  id: string;
  code: string;
  name: string;
  zone: string;
  status: DockStatus;
  supportedLoadTypes: LoadType[];
  /** Scheduled next free time; `null` means free right now. */
  availableFrom: Date | null;
  unavailableReason: string | null;
  /**
   * Committed (`ASSIGNED`) windows already on this door, excluding the truck
   * being scored — re-picking the door a truck already holds is not a clash.
   */
  bookedWindows: BookedWindow[];
}

export interface ScoringAppointment {
  windowStart: Date;
  windowEnd: Date;
  expectedDurationMinutes: number;
}

export interface ScoringContext {
  loadType: LoadType;
  priority: Priority;
  /** When the truck can realistically start: the later of its ETA and its booked window. */
  windowStart: Date;
  /** `windowStart` + the expected dock time. */
  windowEnd: Date;
  appointment: ScoringAppointment | null;
}

// --- Outputs -----------------------------------------------------------

export interface ScoreBreakdown {
  loadTypeFit: number;
  availabilityFit: number;
  appointmentFit: number;
  priorityFit: number;
  statusBonus: number;
}

export interface DockScore {
  dockId: string;
  dockCode: string;
  dockName: string;
  zone: string;
  status: DockStatus;
  /** 0-100, rounded. */
  score: number;
  reasons: string[];
  breakdown: ScoreBreakdown;
  availableFrom: Date | null;
}

export interface ExcludedDock {
  dockId: string;
  dockCode: string;
  reason: string;
}

export interface ScoringResult {
  recommendations: DockScore[];
  excluded: ExcludedDock[];
}

// --- Helpers -----------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** One decimal is enough to explain a breakdown without pretending to precision. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_MINUTE);
}

function overlaps(a: BookedWindow, start: Date, end: Date): boolean {
  return a.start.getTime() < end.getTime() && a.end.getTime() > start.getTime();
}

/**
 * The single hard-filter pass (§9 steps 1-2, plus the two timing impossibilities).
 * Returns the sentence that disqualified the dock, or `null` when it survives.
 */
function exclusionReason(dock: ScoringDock, ctx: ScoringContext): string | null {
  if (dock.status === 'UNAVAILABLE') {
    return dock.unavailableReason
      ? `Dock is out of service: ${dock.unavailableReason}`
      : 'Dock is out of service';
  }

  if (!dock.supportedLoadTypes.includes(ctx.loadType)) {
    return `Does not support ${ctx.loadType} loads`;
  }

  const clash = dock.bookedWindows.find((window) => overlaps(window, ctx.windowStart, ctx.windowEnd));
  if (clash) {
    return `Already booked for another truck for ${minutesBetween(clash.start, clash.end)} min across this slot`;
  }

  // Never free in time: the door frees up only after the slot has already ended.
  if (dock.availableFrom && dock.availableFrom.getTime() >= ctx.windowEnd.getTime()) {
    return `Not free for another ${minutesBetween(ctx.windowStart, dock.availableFrom)} min, after this slot ends`;
  }

  return null;
}

// --- Scoring components ------------------------------------------------

function scoreLoadType(dock: ScoringDock, ctx: ScoringContext): [number, string] {
  if (ctx.loadType !== 'GENERAL') {
    return [WEIGHT_LOAD_TYPE_FIT, `Compatible with ${LOAD_TYPE_LABEL[ctx.loadType]} load`];
  }

  // A general load fits everywhere, so prefer the plainest door and leave the
  // specialist ones free for the freight that actually needs them.
  const specialistTypes = dock.supportedLoadTypes.filter((type) => type !== 'GENERAL');
  if (specialistTypes.length === 0) {
    return [WEIGHT_LOAD_TYPE_FIT, 'General-purpose door, ideal for general freight'];
  }

  const fit = Math.max(
    LOAD_TYPE_FIT_FLOOR,
    WEIGHT_LOAD_TYPE_FIT - SPECIALIST_DOOR_PENALTY * specialistTypes.length,
  );
  const labels = specialistTypes.map((type) => LOAD_TYPE_LABEL[type]).join(', ');
  return [fit, `Handles general freight, but is a ${labels} door worth keeping free`];
}

function scoreAvailability(
  lateness: number,
  lateMinutes: number,
  freeTimeUnknown: boolean,
): [number, string] {
  const fit = WEIGHT_AVAILABILITY_FIT * (1 - lateness);
  if (freeTimeUnknown) {
    return [fit, 'Occupied with no scheduled free time'];
  }
  if (lateMinutes <= 0) {
    return [fit, 'Available before ETA'];
  }
  return [fit, `Frees up ${lateMinutes} min after the truck is due`];
}

function scoreAppointment(dock: ScoringDock, ctx: ScoringContext): [number, string] {
  if (!ctx.appointment) {
    return [
      APPOINTMENT_FIT_WITHOUT_APPOINTMENT,
      'No appointment booked — scored on ETA alone',
    ];
  }

  const { expectedDurationMinutes } = ctx.appointment;
  const usableStart = Math.max(
    ctx.windowStart.getTime(),
    dock.availableFrom?.getTime() ?? 0,
    ctx.appointment.windowStart.getTime(),
  );
  const usableMs = Math.max(0, ctx.appointment.windowEnd.getTime() - usableStart);
  const neededMs = expectedDurationMinutes * MS_PER_MINUTE;
  const covered = neededMs <= 0 ? 1 : clamp(usableMs / neededMs, 0, 1);
  const fit = WEIGHT_APPOINTMENT_FIT * covered;

  if (covered >= 1) {
    return [fit, `Fits the ${expectedDurationMinutes}-minute appointment window`];
  }
  if (usableMs <= 0) {
    return [fit, 'Cannot start inside the booked appointment window'];
  }
  return [
    fit,
    `Covers ${Math.round(usableMs / MS_PER_MINUTE)} of the ${expectedDurationMinutes} minutes booked`,
  ];
}

function scorePriority(ctx: ScoringContext, lateness: number, lateMinutes: number): [number, string | null] {
  const weight = PRIORITY_LATENESS_WEIGHT[ctx.priority];
  const fit = Math.max(0, WEIGHT_PRIORITY_FIT * (1 - weight * lateness));
  const urgent = ctx.priority === 'HIGH' || ctx.priority === 'CRITICAL';

  if (!urgent) return [fit, null];

  if (lateMinutes <= 0) {
    return [fit, `Suitable for ${PRIORITY_LABEL[ctx.priority]}-priority shipment`];
  }
  return [fit, `Would hold a ${PRIORITY_LABEL[ctx.priority]}-priority shipment for ${lateMinutes} min`];
}

// --- Entry point -------------------------------------------------------

/**
 * Ranks every dock that can physically take the truck. Ties are broken by dock
 * code so the same input always produces the same order (§25: the demo must be
 * deterministic).
 */
export function scoreDocks(docks: ScoringDock[], ctx: ScoringContext): ScoringResult {
  const recommendations: DockScore[] = [];
  const excluded: ExcludedDock[] = [];

  const windowMs = Math.max(1, ctx.windowEnd.getTime() - ctx.windowStart.getTime());

  for (const dock of docks) {
    const reason = exclusionReason(dock, ctx);
    if (reason !== null) {
      excluded.push({ dockId: dock.id, dockCode: dock.code, reason });
      continue;
    }

    // A truck is physically on an OCCUPIED door. With no `availableFrom` there
    // is nothing to say when it leaves, and reading that silence as "free now"
    // would recommend a door that is in use — assume it stays busy instead.
    const freeTimeUnknown = dock.status === 'OCCUPIED' && dock.availableFrom === null;

    const lateMs = Math.max(0, (dock.availableFrom?.getTime() ?? 0) - ctx.windowStart.getTime());
    const lateness = freeTimeUnknown ? 1 : clamp(lateMs / windowMs, 0, 1);
    const lateMinutes = Math.round(lateMs / MS_PER_MINUTE);

    const [loadTypeFit, loadTypeReason] = scoreLoadType(dock, ctx);
    const [availabilityFit, availabilityReason] = scoreAvailability(
      lateness,
      lateMinutes,
      freeTimeUnknown,
    );
    const [appointmentFit, appointmentReason] = scoreAppointment(dock, ctx);
    const [priorityFit, priorityReason] = scorePriority(ctx, lateness, lateMinutes);
    const statusBonus = STATUS_BONUS[dock.status];

    const reasons = [loadTypeReason, availabilityReason, appointmentReason];
    if (priorityReason) reasons.push(priorityReason);
    if (dock.status === 'AVAILABLE') reasons.push('Door is free right now');

    recommendations.push({
      dockId: dock.id,
      dockCode: dock.code,
      dockName: dock.name,
      zone: dock.zone,
      status: dock.status,
      score: Math.round(loadTypeFit + availabilityFit + appointmentFit + priorityFit + statusBonus),
      reasons,
      breakdown: {
        loadTypeFit: round1(loadTypeFit),
        availabilityFit: round1(availabilityFit),
        appointmentFit: round1(appointmentFit),
        priorityFit: round1(priorityFit),
        statusBonus,
      },
      availableFrom: dock.availableFrom,
    });
  }

  recommendations.sort((a, b) => b.score - a.score || a.dockCode.localeCompare(b.dockCode));
  excluded.sort((a, b) => a.dockCode.localeCompare(b.dockCode));

  return { recommendations, excluded };
}
