import type { Request, Response } from 'express';
import { sendData, sendList } from '../lib/api-response.js';
import { parseParams, parseQuery } from '../lib/validate.js';
import { idParamSchema } from '../schemas/common.js';
import { dockListQuerySchema } from '../schemas/query.js';
import { getDockById, listDocks } from '../services/dock-service.js';

export async function getDocks(req: Request, res: Response): Promise<void> {
  const query = parseQuery(dockListQuerySchema, req);
  const { items, total } = await listDocks(query);
  sendList(res, items, { total, limit: query.limit, offset: query.offset });
}

export async function getDock(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(idParamSchema, req);
  sendData(res, await getDockById(id));
}
