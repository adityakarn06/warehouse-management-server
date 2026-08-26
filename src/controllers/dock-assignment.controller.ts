import type { Request, Response } from 'express';
import { sendList } from '../lib/api-response.js';
import { parseQuery } from '../lib/validate.js';
import { dockAssignmentListQuerySchema } from '../schemas/query.js';
import { listDockAssignments } from '../services/dock-assignment-service.js';

export async function getDockAssignments(req: Request, res: Response): Promise<void> {
  const query = parseQuery(dockAssignmentListQuerySchema, req);
  const { items, total } = await listDockAssignments(query);
  sendList(res, items, { total, limit: query.limit, offset: query.offset });
}
