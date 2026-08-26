import type { Request, Response } from 'express';
import { releaseDock } from '../docking/dock-assignment-service.js';
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
 * the authoritative resulting state: the door itself, whatever was assigned to
 * it, and where the backend moved each of those trucks.
 */
export async function patchDockStatus(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(idParamSchema, req);
  const { status, reason } = parseBody(dockStatusCommandSchema, req);
  // One clock for the whole request. Without it the status write, the alert and
  // every reassignment the cascade makes each call `new Date()` separately, so
  // the timeline a dashboard renders is stamped milliseconds apart for what was
  // one operator action.
  sendData(res, await setDockStatus(id, status, reason, new Date()));
}

/**
 * Hands a door back to the yard: every committed assignment on it is completed
 * and the door goes back to `AVAILABLE`. A door that is out of service stays
 * out of service — releasing a booking does not repair a broken dock.
 */
export async function postDockRelease(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(idParamSchema, req);
  sendData(res, await releaseDock(id, new Date()));
}
