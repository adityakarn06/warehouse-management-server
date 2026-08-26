import type { DockStatus } from '../generated/prisma/enums.js';
import { logger } from '../lib/logger.js';
import type { AlertRecord } from '../services/alert-service.js';
import type { AlertCreatedPayload, RealtimeEvent } from '../websocket/events.js';
import { tryGetRealtimeService } from '../websocket/index.js';

/**
 * The docking layer's realtime seam (CLAUDE.md §14).
 *
 * Domain code emits a `DockingEvent` and lets the `RealtimeService` choose the
 * rooms — it never imports Socket.IO. This mirrors the simulation engine's
 * `SimulationEventSink`, with one difference: the default sink is already the
 * realtime-resolving one, so `server.ts` needs no extra wiring. That works
 * because `tryGetRealtimeService()` returns `null` rather than throwing when
 * there is no server, which is exactly the case under the supertest suites,
 * where `createApp()` runs without a websocket.
 */

/** The three events the docking layer is allowed to raise in Phase 7. */
export type DockingEvent = Extract<
  RealtimeEvent,
  { type: 'DOCK_ASSIGNED' | 'DOCK_STATUS_CHANGED' | 'ALERT_CREATED' }
>;

export interface DockingEventSink {
  emit(event: DockingEvent): void;
}

/** Resolves the live service per event, so a close/re-init cannot strand it. */
export const realtimeDockingSink: DockingEventSink = {
  emit(event) {
    tryGetRealtimeService()?.emit(event);
    logger.debug(`docking -> ${event.type}`);
  },
};

let sink: DockingEventSink = realtimeDockingSink;

export function dockingSink(): DockingEventSink {
  return sink;
}

/** Swapped by the tests for a recording sink; production never calls this. */
export function setDockingSink(next: DockingEventSink): void {
  sink = next;
}

export function resetDockingSink(): void {
  sink = realtimeDockingSink;
}

// --- Payload builders --------------------------------------------------
// Shared by the availability command and the assignment service so the two
// cannot drift, and so `exactOptionalPropertyTypes` is satisfied in one place.

export interface DockStatusSnapshot {
  id: string;
  code: string;
  status: DockStatus;
  unavailableReason: string | null;
}

export function dockStatusChangedEvent(
  dock: DockStatusSnapshot,
  previousStatus: DockStatus,
  at: Date,
): DockingEvent {
  return {
    type: 'DOCK_STATUS_CHANGED',
    data: {
      dockDoorId: dock.id,
      code: dock.code,
      previousStatus,
      status: dock.status,
      // Optional on the wire: omit it rather than sending `undefined`.
      ...(dock.unavailableReason === null ? {} : { unavailableReason: dock.unavailableReason }),
      serverTimestamp: at.toISOString(),
    },
  };
}

/** `createAlert` deliberately never emits — the caller owns emission (§14). */
export function alertCreatedPayload(alert: AlertRecord): AlertCreatedPayload {
  return {
    alertId: alert.id,
    type: alert.type,
    severity: alert.severity,
    title: alert.title,
    message: alert.message,
    truckId: alert.truckId,
    shipmentId: alert.shipmentId,
    dockDoorId: alert.dockDoorId,
    createdAt: alert.createdAt.toISOString(),
  };
}
