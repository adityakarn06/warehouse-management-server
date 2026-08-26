import type { Request, Response } from 'express';
import { pingDatabase } from '../lib/prisma.js';
import type { DatabaseHealthResponse, HealthResponse } from '../types/index.js';

const SERVICE_NAME = 'wheres-my-truck-server';

/** Shared by the top-level /health probe and the versioned one. */
export function buildHealthPayload(): HealthResponse {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Liveness only: is this process up and serving HTTP? Deliberately does not
 * touch the database, so a DB blip never takes the process out of rotation.
 */
export function getHealth(_req: Request, res: Response): void {
  res.status(200).json(buildHealthPayload());
}

/** Readiness for the database specifically. Kept separate on purpose. */
export async function getDatabaseHealth(_req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  try {
    await pingDatabase();
    const payload: DatabaseHealthResponse = {
      status: 'ok',
      latencyMs: Date.now() - startedAt,
    };
    res.status(200).json(payload);
  } catch (error) {
    const payload: DatabaseHealthResponse = {
      status: 'down',
      latencyMs: null,
      error: error instanceof Error ? error.message : 'Unknown database error',
    };
    res.status(503).json(payload);
  }
}
