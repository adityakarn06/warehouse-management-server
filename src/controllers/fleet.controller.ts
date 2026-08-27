import type { Request, Response } from 'express';
import { sendList } from '../lib/api-response.js';
import { parseQuery } from '../lib/validate.js';
import { fleetListQuerySchema } from '../schemas/query.js';
import { listFleet } from '../services/fleet-service.js';

export async function getFleet(req: Request, res: Response): Promise<void> {
  const query = parseQuery(fleetListQuerySchema, req);
  const { items, total } = await listFleet(query);
  sendList(res, items, { total, limit: query.limit, offset: query.offset });
}
