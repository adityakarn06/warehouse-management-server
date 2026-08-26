import { z } from 'zod';

/** Accepts a truck id or its human reference, like the other detail routes. */
export const truckIdParamSchema = z.object({ truckId: z.string().min(1) });
