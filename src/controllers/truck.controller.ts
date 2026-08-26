import type { Request, Response } from 'express';
import { assignDock, recommendDocks } from '../docking/dock-assignment-service.js';
import { sendData, sendList } from '../lib/api-response.js';
import { parseBody, parseParams, parseQuery } from '../lib/validate.js';
import { idParamSchema } from '../schemas/common.js';
import { assignDockCommandSchema } from '../schemas/docking.js';
import { truckListQuerySchema } from '../schemas/query.js';
import { truckIdParamSchema } from '../schemas/simulation.js';
import { getTruckById, listTrucks } from '../services/truck-service.js';

export async function getTrucks(req: Request, res: Response): Promise<void> {
  const query = parseQuery(truckListQuerySchema, req);
  const { items, total } = await listTrucks(query);
  sendList(res, items, { total, limit: query.limit, offset: query.offset });
}

export async function getTruck(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(idParamSchema, req);
  sendData(res, await getTruckById(id));
}

/** Ranked, explainable dock options. Read-only — nothing is written here. */
export async function getDockRecommendations(req: Request, res: Response): Promise<void> {
  const { truckId } = parseParams(truckIdParamSchema, req);
  sendData(res, await recommendDocks(truckId));
}

/**
 * Commits a dock. 201 when a new assignment was written, 200 when the truck
 * already held the requested door.
 */
export async function postDockAssignment(req: Request, res: Response): Promise<void> {
  const { truckId } = parseParams(truckIdParamSchema, req);
  const { dockId } = parseBody(assignDockCommandSchema, req);
  const result = await assignDock(truckId, dockId);
  sendData(res, result, result.created ? 201 : 200);
}
