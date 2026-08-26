import type { Request, Response } from 'express';
import { sendList } from '../lib/api-response.js';
import { parseQuery } from '../lib/validate.js';
import { alertListQuerySchema } from '../schemas/query.js';
import { listAlerts } from '../services/alert-service.js';

export async function getAlerts(req: Request, res: Response): Promise<void> {
  const query = parseQuery(alertListQuerySchema, req);
  const { items, total } = await listAlerts(query);
  sendList(res, items, { total, limit: query.limit, offset: query.offset });
}
