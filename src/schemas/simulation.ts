import { z } from 'zod';
import { delayScenarioSchema } from './common.js';

/** Accepts a truck id or its human reference, like the other detail routes. */
export const truckIdParamSchema = z.object({ truckId: z.string().min(1) });

/**
 * `POST /simulation/trucks/:truckId/delay` — the whole command surface the
 * frontend gets. It names a scenario and nothing else; the backend owns every
 * consequence (CLAUDE.md §2).
 *
 * `NORMAL` is excluded on purpose: clearing a delay is its own endpoint, so
 * "activate" and "clear" cannot be confused for one another.
 */
export const delayCommandSchema = z.object({
  type: delayScenarioSchema.exclude(['NORMAL']),
});

export type DelayCommand = z.infer<typeof delayCommandSchema>;
