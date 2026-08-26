import { z } from 'zod';
import { dockStatusSchema, truckStatusSchema } from './common.js';

/**
 * The simulated WMS feed (CLAUDE.md §15). An external warehouse system reports
 * physical facts at us; this file is where we refuse to believe the ones it has
 * no business asserting.
 *
 * This is the project's first `z.discriminatedUnion`. The discriminator is
 * `eventType`, which means an unknown type fails with one clear issue naming
 * the accepted values rather than a union of six unrelated complaints — worth
 * the convention, since a WMS payload is the least trustworthy input we take.
 *
 * Two narrowings are load-bearing rather than cosmetic; both are documented at
 * their `.exclude()` calls below.
 */

const trailerRef = z.string().min(1);

/** External vocabulary: the WMS says `{ lat, lng }`, the domain says latitude/longitude. */
const yardLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/**
 * When the WMS observed the fact. Accepted on every event and currently
 * recorded in the response only — the backend stamps its own `now` on the rows
 * it writes, because a feed with a skewed clock must not be able to write
 * timestamps that reorder the timeline.
 */
const occurredAt = z.iso.datetime().optional();

const trailerLocationUpdated = z.object({
  eventType: z.literal('TRAILER_LOCATION_UPDATED'),
  trailerId: trailerRef,
  yardLocation: yardLocationSchema,
  progress: z.number().min(0).max(100).optional(),
  speedKmph: z.number().min(0).max(200).optional(),
  occurredAt,
});

const trailerStatusUpdated = z.object({
  eventType: z.literal('TRAILER_STATUS_UPDATED'),
  trailerId: trailerRef,
  /**
   * Two exclusions, both to stop this event producing a state no other endpoint
   * could have produced:
   *
   * - `DELAYED` is owned by the delay scenarios, which set `activeDelay`
   *   alongside it. Accepting it here would yield a truck that is `DELAYED`
   *   with `activeDelay: NORMAL`, which the board cannot explain and
   *   `clearDelay` cannot undo. Use `POST /simulation/trucks/:id/delay`.
   * - `DOCKED` is owned by `TRAILER_DOCKED`, which checks the truck actually
   *   holds that door and flips the door in the same transaction. Setting it
   *   here would record a docked trailer against a door still reading
   *   `RESERVED` — exactly the half-state that transaction exists to prevent.
   */
  status: truckStatusSchema.exclude(['DELAYED', 'DOCKED']),
  /** Explicit `null` clears the estimate; omitting it recomputes from position. */
  eta: z.iso.datetime().nullish(),
  yardLocation: yardLocationSchema.optional(),
  occurredAt,
});

const trailerArrived = z.object({
  eventType: z.literal('TRAILER_ARRIVED'),
  trailerId: trailerRef,
  yardLocation: yardLocationSchema.optional(),
  occurredAt,
});

const trailerDocked = z.object({
  eventType: z.literal('TRAILER_DOCKED'),
  trailerId: trailerRef,
  dockCode: z.string().min(1),
  occurredAt,
});

const dockStatusUpdated = z.object({
  eventType: z.literal('DOCK_STATUS_UPDATED'),
  dockCode: z.string().min(1),
  /**
   * `RESERVED` is excluded: it is the assignment engine's transition, written
   * only when a dock is committed to a truck. `OCCUPIED` is the one status only
   * this feed may set — a trailer has physically backed in.
   */
  status: dockStatusSchema.exclude(['RESERVED']),
  reason: z.string().min(1).max(200).optional(),
  occurredAt,
});

const appointmentUpdated = z
  .object({
    eventType: z.literal('APPOINTMENT_UPDATED'),
    appointmentReference: z.string().min(1),
    windowStart: z.iso.datetime().optional(),
    windowEnd: z.iso.datetime().optional(),
    expectedDurationMinutes: z.number().int().positive().max(1440).optional(),
    notes: z.string().max(500).nullish(),
    occurredAt,
  })
  // An update that updates nothing is a mistake at the sender, not a no-op
  // worth writing. Note the ordering of the two bounds is checked in the
  // handler, not here: either may be omitted, so only the merged row is
  // comparable.
  .refine(
    (event) =>
      event.windowStart !== undefined ||
      event.windowEnd !== undefined ||
      event.expectedDurationMinutes !== undefined ||
      event.notes !== undefined,
    { message: 'APPOINTMENT_UPDATED must change at least one field' },
  );

export const wmsEventSchema = z.discriminatedUnion('eventType', [
  trailerLocationUpdated,
  trailerStatusUpdated,
  trailerArrived,
  trailerDocked,
  dockStatusUpdated,
  appointmentUpdated,
]);

export type WmsEvent = z.infer<typeof wmsEventSchema>;
export type WmsEventType = WmsEvent['eventType'];

/** The scripted demo sequences. Deterministic by name — never random (§25). */
export const WMS_SCENARIOS = ['TRAILER_ARRIVAL', 'DOCK_OCCUPANCY', 'APPOINTMENT_SHIFT'] as const;

export const wmsSimulateCommandSchema = z
  .object({ scenario: z.enum(WMS_SCENARIOS).default('TRAILER_ARRIVAL') })
  // Express 5 leaves `req.body` undefined for a bodyless POST, so `curl -X POST
  // .../wms/simulate` would 400 instead of running the default scenario. The
  // whole object is spelled out because `scenario` is required on the *output*
  // type, which a bare `{}` does not satisfy.
  .default({ scenario: 'TRAILER_ARRIVAL' });

export type WmsScenario = (typeof WMS_SCENARIOS)[number];
