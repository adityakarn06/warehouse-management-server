import type { LoadType } from '../generated/prisma/enums.js';
import { logger } from '../lib/logger.js';
import { createAlert } from '../services/alert-service.js';
import type { AlertCreatedPayload } from '../websocket/events.js';
import { reassignDock } from './dock-assignment-service.js';
import type { ReassignResult } from './dock-assignment-service.js';
import { alertCreatedPayload, dockingSink } from './docking-events.js';

/**
 * Automatic reassignment after a dock failure (CLAUDE.md §10, Scenario D/E).
 *
 * The layering is deliberate:
 *
 *   DockFailureService -> DockAssignmentService -> AlertService -> RealtimeService
 *
 * This module orchestrates and owns the alerts; it never writes an assignment
 * row itself. Every consequence of "make D2 unavailable" is decided here, on
 * the backend — the frontend sends a status and nothing else (§2).
 */

/** A committed row the failed door was holding, as `dock-service` already loaded it. */
export interface AffectedAssignment {
  id: string;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  shipmentId: string | null;
  truck: { id: string; reference: string };
}

export interface FailedDock {
  id: string;
  code: string;
  reason: string;
}

/** What happened to one truck that was standing on the failed door. */
export interface ReassignmentOutcome {
  truckId: string;
  truckReference: string;
  shipmentId: string | null;
  /**
   * `REASSIGNMENT_FAILED` is the third, unhappy answer: the move itself threw,
   * so the truck is still sitting on the door that just went down and needs a
   * human. Reporting it as `NO_DOCK_AVAILABLE` would be a different lie — that
   * one leaves the truck cleanly unassigned.
   */
  outcome: ReassignResult['outcome'] | 'REASSIGNMENT_FAILED';
  previousAssignmentId: string;
  previousDockDoorId: string;
  previousDockCode: string;
  newAssignmentId: string | null;
  newDockDoorId: string | null;
  newDockCode: string | null;
  score: number | null;
  reasons: string[];
  alert: AlertCreatedPayload | null;
}

/** The sentence the UI renders under `TRK-101  D2 -> D4`. */
function failureReason(dock: FailedDock): string {
  return `${dock.code} taken out of service: ${dock.reason}`;
}

/**
 * Writes and emits one alert. A lost audit row must never fail the command —
 * the door is authoritatively down and the truck authoritatively moved either
 * way, exactly as the delay path treats its `TRUCK_DELAYED` alert.
 */
async function raise(
  input: Parameters<typeof createAlert>[0],
  context: string,
): Promise<AlertCreatedPayload | null> {
  try {
    const record = await createAlert(input);
    const payload = alertCreatedPayload(record);
    dockingSink().emit({ type: 'ALERT_CREATED', data: payload });
    return payload;
  } catch (error) {
    logger.error(`Failed to write ${input.type} alert for ${context}`, error);
    return null;
  }
}

function reassignedAlert(
  dock: FailedDock,
  result: ReassignResult,
): Parameters<typeof createAlert>[0] {
  const assignment = result.assignment;
  const newCode = assignment?.dockDoor.code ?? '';
  const score = assignment?.score ?? null;

  return {
    type: 'DOCK_REASSIGNMENT',
    severity: 'INFO',
    title: `${result.truck.reference} reassigned ${result.previous.dockCode} → ${newCode}`,
    message:
      `${dock.code} went out of service (${dock.reason}). ` +
      `${result.truck.reference} was automatically reassigned to ${newCode}` +
      (score === null ? '.' : ` (score ${Math.round(score)}).`),
    truckId: result.truck.id,
    shipmentId: result.shipmentId,
    // The alert points at the *new* door — that is where the truck is going,
    // and where an operator clicking through the alert should land.
    dockDoorId: assignment?.dockDoorId ?? null,
    metadata: {
      reason: dock.reason,
      previousDockDoorId: result.previous.dockDoorId,
      newDockDoorId: assignment?.dockDoorId ?? null,
      previousAssignmentId: result.previous.id,
      newAssignmentId: assignment?.id ?? null,
      score,
      reasons: assignment?.reasons ?? [],
    },
  };
}

function noDockAlert(
  dock: FailedDock,
  result: ReassignResult,
  loadType: LoadType | null,
): Parameters<typeof createAlert>[0] {
  return {
    type: 'NO_DOCK_AVAILABLE',
    severity: 'CRITICAL',
    title: `No dock available for ${result.truck.reference}`,
    message:
      `${dock.code} went out of service (${dock.reason}) and no compatible door is free ` +
      `for ${result.truck.reference}. The truck is unassigned and needs a manual decision.`,
    truckId: result.truck.id,
    shipmentId: result.shipmentId,
    // No door to point at — inventing one would be the exact mistake §10 forbids.
    dockDoorId: null,
    metadata: {
      reason: dock.reason,
      loadType,
      previousDockDoorId: result.previous.dockDoorId,
      previousAssignmentId: result.previous.id,
      // Why nothing fit, in the scorer's own words.
      excluded: result.excluded.map((row) => `${row.dockCode}: ${row.reason}`),
    },
  };
}

/**
 * The truck could not be moved *and* could not be cleanly unassigned, because
 * the move threw. Its row is still `ASSIGNED` to a door that cannot open, so
 * this must be as loud as the no-dock case — silence here is exactly the
 * stranding the cascade exists to prevent.
 */
function failedAlert(
  dock: FailedDock,
  row: AffectedAssignment,
  error: unknown,
): Parameters<typeof createAlert>[0] {
  return {
    type: 'NO_DOCK_AVAILABLE',
    severity: 'CRITICAL',
    title: `Could not reassign ${row.truck.reference} off ${dock.code}`,
    message:
      `${dock.code} went out of service (${dock.reason}) but ${row.truck.reference} could not be ` +
      `moved. It is still assigned to ${dock.code} and needs a manual decision.`,
    truckId: row.truck.id,
    shipmentId: row.shipmentId,
    dockDoorId: dock.id,
    metadata: {
      reason: dock.reason,
      previousDockDoorId: dock.id,
      previousAssignmentId: row.id,
      failure: error instanceof Error ? error.message : String(error),
    },
  };
}

function toFailedOutcome(
  dock: FailedDock,
  row: AffectedAssignment,
  alert: AlertCreatedPayload | null,
): ReassignmentOutcome {
  return {
    truckId: row.truck.id,
    truckReference: row.truck.reference,
    shipmentId: row.shipmentId,
    outcome: 'REASSIGNMENT_FAILED',
    previousAssignmentId: row.id,
    previousDockDoorId: dock.id,
    previousDockCode: dock.code,
    newAssignmentId: null,
    newDockDoorId: null,
    newDockCode: null,
    score: null,
    reasons: [],
    alert,
  };
}

function toOutcome(result: ReassignResult, alert: AlertCreatedPayload | null): ReassignmentOutcome {
  const assignment = result.assignment;

  return {
    truckId: result.truck.id,
    truckReference: result.truck.reference,
    shipmentId: result.shipmentId,
    outcome: result.outcome,
    previousAssignmentId: result.previous.id,
    previousDockDoorId: result.previous.dockDoorId,
    previousDockCode: result.previous.dockCode,
    newAssignmentId: assignment?.id ?? null,
    newDockDoorId: assignment?.dockDoorId ?? null,
    newDockCode: assignment?.dockDoor.code ?? null,
    score: assignment?.score ?? null,
    reasons: assignment?.reasons ?? [],
    alert,
  };
}

/**
 * Runs the failure cascade for every truck the door was holding.
 *
 * Trucks are handled oldest-slot-first so a door with several bookings resolves
 * deterministically (§25) — the truck due soonest gets first pick of what is
 * left. One truck's failure to move is logged and does not stop the next.
 */
export async function handleDockFailure(
  dock: FailedDock,
  affected: AffectedAssignment[],
  now = new Date(),
): Promise<ReassignmentOutcome[]> {
  const ordered = [...affected].sort((a, b) => {
    const left = a.scheduledStart?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const right = b.scheduledStart?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.id.localeCompare(b.id);
  });

  const outcomes: ReassignmentOutcome[] = [];
  const reason = failureReason(dock);

  for (const row of ordered) {
    try {
      const result = await reassignDock(row.truck.id, row.id, reason, now);

      const alert =
        result.outcome === 'REASSIGNED'
          ? await raise(reassignedAlert(dock, result), `${result.truck.reference} -> ${dock.code}`)
          : await raise(
              noDockAlert(dock, result, result.loadType),
              `${result.truck.reference} (no dock)`,
            );

      outcomes.push(toOutcome(result, alert));
    } catch (error) {
      // The door is already out of service and this truck is still on it. Say
      // so — in the response *and* in an alert — and carry on with the rest:
      // one truck we could not move must not strand the others silently.
      logger.error(`Failed to reassign ${row.truck.reference} off ${dock.code}`, error);

      const alert = await raise(
        failedAlert(dock, row, error),
        `${row.truck.reference} (reassignment failed)`,
      );
      outcomes.push(toFailedOutcome(dock, row, alert));
    }
  }

  return outcomes;
}
