import { z } from 'zod';

/**
 * Socket payloads are external input too (CLAUDE.md §20). These mirror
 * `TruckSubscription` / `ShipmentSubscription` in `src/websocket/events.ts`.
 *
 * A client can also send nothing at all where an object is expected, so the
 * handlers parse with `safeParse` and answer through the ack rather than
 * throwing — an exception inside a socket handler takes the connection down.
 */

export const truckSubscriptionSchema = z.object({
  truckId: z.string().min(1),
});

export const shipmentSubscriptionSchema = z.object({
  shipmentId: z.string().min(1),
});
