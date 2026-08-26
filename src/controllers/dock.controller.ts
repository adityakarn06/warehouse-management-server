import type { Request, Response } from 'express';
import { sendData, sendList } from '../lib/api-response.js';
import { parseBody, parseParams, parseQuery } from '../lib/validate.js';
import { idParamSchema } from '../schemas/common.js';
import { dockStatusCommandSchema } from '../schemas/docking.js';
import { dockListQuerySchema } from '../schemas/query.js';
import { getDockById, listDocks, setDockStatus } from '../services/dock-service.js';

export async function getDocks(req: Request, res: Response): Promise<void> {
  const query = parseQuery(dockListQuerySchema, req);
  const { items, total } = await listDocks(query);
  sendList(res, items, { total, limit: query.limit, offset: query.offset });
}

export async function getDock(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(idParamSchema, req);
  sendData(res, await getDockById(id));
}

/**
 * Operations' "make unavailable" / "make available" buttons. The response is
 * the authoritative resulting state, including anything still assigned to a
 * door that just went out of service.
 */
export async function patchDockStatus(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(idParamSchema, req);
  const { status, reason } = parseBody(dockStatusCommandSchema, req);
  sendData(res, await setDockStatus(id, status, reason));
}
