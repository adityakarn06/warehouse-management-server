import { logger } from '../lib/logger.js';
import type { WmsEvent, WmsScenario } from '../schemas/wms.js';
import type { WmsEventResult } from './wms-event-handler.js';
import { handleWmsEvent } from './wms-event-handler.js';

/**
 * `POST /api/v1/wms/simulate` — a few deterministic WMS events for the demo
 * (CLAUDE.md §15).
 *
 * Deliberately not random. Every sequence names seeded rows and derives its
 * timestamps from one `now`, the way `prisma/seed.ts` derives everything from
 * `BASE`, so the demo tells the same story on every run (§25, §26).
 *
 * These are ordinary events fed through `handleWmsEvent` — there is no second
 * code path here, which is the point: whatever the demo proves, the real
 * endpoint does too.
 */

const minutes = (base: Date, n: number): string => new Date(base.getTime() + n * 60_000).toISOString();

/**
 * A trailer arrives and backs into the door it was already assigned.
 *
 * TRL-101 holds DA-3002 on D2 (the Scenario D pairing), so the sequence ends
 * with D2 OCCUPIED, TRK-101 DOCKED and SHP-1001 DOCKED. That moves seeded demo
 * rows — `pnpm db:seed` puts them back.
 */
function trailerArrival(now: Date): WmsEvent[] {
  return [
    {
      eventType: 'TRAILER_LOCATION_UPDATED',
      trailerId: 'TRL-101',
      // Just short of the warehouse on the NH-19 corridor.
      yardLocation: { lat: 22.5799, lng: 88.3985 },
      progress: 97,
      speedKmph: 24,
      occurredAt: minutes(now, -6),
    },
    {
      eventType: 'TRAILER_STATUS_UPDATED',
      trailerId: 'TRL-101',
      status: 'ARRIVING',
      occurredAt: minutes(now, -4),
    },
    { eventType: 'TRAILER_ARRIVED', trailerId: 'TRL-101', occurredAt: minutes(now, -2) },
    {
      eventType: 'TRAILER_DOCKED',
      trailerId: 'TRL-101',
      dockCode: 'D2',
      occurredAt: minutes(now, 0),
    },
  ];
}

/**
 * The one transition only the WMS may make. D3 is seeded AVAILABLE and holds no
 * booking, so occupying and releasing it disturbs nothing else.
 */
function dockOccupancy(now: Date): WmsEvent[] {
  return [
    { eventType: 'DOCK_STATUS_UPDATED', dockCode: 'D3', status: 'OCCUPIED', occurredAt: minutes(now, -3) },
    { eventType: 'DOCK_STATUS_UPDATED', dockCode: 'D3', status: 'AVAILABLE', occurredAt: minutes(now, 0) },
  ];
}

/**
 * A customer moves their slot. APT-2001 is TRK-101/SHP-1001's window, and
 * pushing it out an hour visibly re-ranks
 * `GET /api/v1/trucks/TRK-101/dock-recommendations` through `appointmentFit`.
 */
function appointmentShift(now: Date): WmsEvent[] {
  return [
    {
      eventType: 'APPOINTMENT_UPDATED',
      appointmentReference: 'APT-2001',
      windowStart: minutes(now, 105),
      windowEnd: minutes(now, 165),
      notes: 'WMS: customer moved the slot out by one hour',
      occurredAt: minutes(now, 0),
    },
  ];
}

const SCRIPTS: Record<WmsScenario, (now: Date) => WmsEvent[]> = {
  TRAILER_ARRIVAL: trailerArrival,
  DOCK_OCCUPANCY: dockOccupancy,
  APPOINTMENT_SHIFT: appointmentShift,
};

/** One entry per event, in the order it was fed, whether or not it succeeded. */
export interface WmsScenarioStep {
  eventType: WmsEvent['eventType'];
  ok: boolean;
  result: WmsEventResult | null;
  error: string | null;
}

/**
 * Replays one scenario. Strictly sequential — later events depend on what
 * earlier ones did, so `Promise.all` would be wrong rather than merely faster.
 *
 * A failing step is captured and the run continues, for the same reason
 * `handleDockFailure` reports a truck it could not move instead of dropping it:
 * a half-finished demo that says which half failed is far more useful than one
 * that stops with no explanation.
 */
export async function runWmsScenario(
  scenario: WmsScenario,
  now = new Date(),
): Promise<WmsScenarioStep[]> {
  const steps: WmsScenarioStep[] = [];

  for (const event of SCRIPTS[scenario](now)) {
    try {
      steps.push({
        eventType: event.eventType,
        ok: true,
        result: await handleWmsEvent(event, now),
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`WMS scenario ${scenario}: ${event.eventType} failed — ${message}`);
      steps.push({ eventType: event.eventType, ok: false, result: null, error: message });
    }
  }

  return steps;
}
