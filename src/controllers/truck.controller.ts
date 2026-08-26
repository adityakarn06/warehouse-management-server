import type { Request, Response } from 'express';
import { sendData, sendList } from '../lib/api-response.js';
import { parseParams, parseQuery } from '../lib/validate.js';
import { idParamSchema } from '../schemas/common.js';
import { truckListQuerySchema } from '../schemas/query.js';
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
