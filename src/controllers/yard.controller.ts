import type { Request, Response } from 'express';
import { sendData } from '../lib/api-response.js';
import { getDockingQueue } from '../services/docking-queue-service.js';
import { getAllocationSummary, getYardOverview } from '../services/yard-service.js';

export async function getOverview(_req: Request, res: Response): Promise<void> {
  sendData(res, await getYardOverview());
}

/** "Trailer that needs to be docked for each arrival window" (problem statement §4). */
export async function getDockingQueueHandler(_req: Request, res: Response): Promise<void> {
  sendData(res, await getDockingQueue());
}

/** "Trailer-to-door allocation summary" (problem statement §7 output). */
export async function getAllocationSummaryHandler(_req: Request, res: Response): Promise<void> {
  sendData(res, await getAllocationSummary());
}
