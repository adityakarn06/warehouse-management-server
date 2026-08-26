import type { Request, Response } from 'express';
import { sendData } from '../lib/api-response.js';
import { getYardOverview } from '../services/yard-service.js';

export async function getOverview(_req: Request, res: Response): Promise<void> {
  sendData(res, await getYardOverview());
}
