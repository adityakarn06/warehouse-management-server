import type { Request, Response } from 'express';
import { sendData } from '../lib/api-response.js';
import { parseParams } from '../lib/validate.js';
import { idParamSchema } from '../schemas/common.js';
import { getRouteById } from '../services/route-service.js';

export async function getRoute(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(idParamSchema, req);
  sendData(res, await getRouteById(id));
}
