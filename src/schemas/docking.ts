import { z } from 'zod';

/**
 * The docking command surface (CLAUDE.md §8, §9). Like the delay commands, the
 * frontend names *what* it wants and nothing else — the backend owns every
 * consequence.
 */

/**
 * `PATCH /docks/:id/status`. Only the two operator buttons are accepted:
 * `RESERVED` and `OCCUPIED` are owned by the assignment engine and the WMS
 * feed, and letting an operator set them by hand would let the board lie.
 */
export const dockStatusCommandSchema = z.object({
  status: z.enum(['AVAILABLE', 'UNAVAILABLE']),
  reason: z.string().min(1).max(200).optional(),
});

export type DockStatusCommand = z.infer<typeof dockStatusCommandSchema>;

/**
 * `POST /trucks/:truckId/dock-assignment`. `dockId` is optional: omitting it
 * commits the top-ranked recommendation, which is the demo's one-click flow.
 */
export const assignDockCommandSchema = z
  .object({ dockId: z.string().min(1).optional() })
  // Express 5 leaves `req.body` undefined when a request carries no body at
  // all, so `curl -X POST .../dock-assignment` would otherwise 400 instead of
  // taking the top recommendation. The default makes "no body" mean "{}".
  .default({});

export type AssignDockCommand = z.infer<typeof assignDockCommandSchema>;
