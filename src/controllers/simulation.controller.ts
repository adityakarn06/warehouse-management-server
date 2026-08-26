import type { Request, Response } from 'express';
import { sendData, sendList } from '../lib/api-response.js';
import { HttpError } from '../lib/http-error.js';
import { parseParams } from '../lib/validate.js';
import { truckIdParamSchema } from '../schemas/simulation.js';
import { toLiveTruckView } from '../simulation/live-state.js';
import { simulationManager } from '../simulation/simulation-manager.js';

/**
 * Simulation lifecycle control (CLAUDE.md §16/§22). Delay commands
 * (`/delay`, `/clear-delay`) belong to Phase 6 and are not wired here.
 */

function status() {
  return {
    running: simulationManager.isRunning(),
    truckCount: simulationManager.truckCount,
    tickMs: simulationManager.tickMs,
  };
}

export async function startSimulation(_req: Request, res: Response): Promise<void> {
  await simulationManager.start();
  sendData(res, status());
}

export async function stopSimulation(_req: Request, res: Response): Promise<void> {
  await simulationManager.stop();
  sendData(res, status());
}

export async function resetSimulation(_req: Request, res: Response): Promise<void> {
  await simulationManager.reset();
  sendData(res, status());
}

export function getSimulationState(_req: Request, res: Response): void {
  const states = simulationManager.getAllTruckStates().map(toLiveTruckView);
  sendList(res, states, { total: states.length, limit: states.length, offset: 0 });
}

export function getSimulationTruckState(req: Request, res: Response): void {
  const { truckId } = parseParams(truckIdParamSchema, req);

  const state = simulationManager.getTruckState(truckId);
  if (!state) {
    throw HttpError.notFound(`Truck ${truckId} is not being simulated`);
  }

  sendData(res, toLiveTruckView(state));
}
