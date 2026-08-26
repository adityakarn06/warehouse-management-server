import type { Request, Response } from 'express';
import { sendData } from '../lib/api-response.js';
import { parseParams } from '../lib/validate.js';
import { trackingNumberParamSchema } from '../schemas/query.js';
import { getTrackingByNumber } from '../services/tracking-service.js';

export async function getTracking(req: Request, res: Response): Promise<void> {
  const { trackingNumber } = parseParams(trackingNumberParamSchema, req);
  sendData(res, await getTrackingByNumber(trackingNumber));
}
