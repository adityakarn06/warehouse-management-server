import type { Request, Response } from 'express';
import { sendData, sendList } from '../lib/api-response.js';
import { HttpError } from '../lib/http-error.js';
import { parseBody, parseParams } from '../lib/validate.js';
import { delayCommandSchema, truckIdParamSchema } from '../schemas/simulation.js';
import { multiplierFor } from '../simulation/delay-scenarios.js';
import type { LiveTruckState } from '../simulation/live-state.js';
import { toLiveTruckView } from '../simulation/live-state.js';
import type { DelayResult } from '../simulation/simulation-manager.js';
import { simulationManager } from '../simulation/simulation-manager.js';

/**
 * Simulation lifecycle control and delay commands (CLAUDE.md §16/§22).
 *
 * The delay endpoints take a scenario name and nothing else. Every consequence —
 * effective speed, ETA, status, the alert, the realtime events — is decided by
 * the engine, and the response carries the authoritative resulting state so the
 * frontend never has to compute or re-read it (§2).
 */

/**
 * The loop's own state, including `lastTickAt` / `lastTickError` so a dashboard
 * can tell a healthy engine from a wedged one. Per-truck tick failures are
 * swallowed to keep the interval alive (§22), which would otherwise make the
 * two indistinguishable from outside.
 */
function status() {
  return simulationManager.health();
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
  const states = simulationManager.getAllTruckStates().map(truckView);
  sendList(res, states, { total: states.length, limit: states.length, offset: 0 });
}

export function getSimulationTruckState(req: Request, res: Response): void {
  const { truckId } = parseParams(truckIdParamSchema, req);

  const state = simulationManager.getTruckState(truckId);
  if (!state) {
    throw HttpError.notFound(`Truck ${truckId} is not being simulated`);
  }

  sendData(res, truckView(state));
}

export async function applyTruckDelay(req: Request, res: Response): Promise<void> {
  const { truckId } = parseParams(truckIdParamSchema, req);
  const { type } = parseBody(delayCommandSchema, req);

  sendData(res, delayResponse(await simulationManager.applyDelay(truckId, type)));
}

export async function clearTruckDelay(req: Request, res: Response): Promise<void> {
  const { truckId } = parseParams(truckIdParamSchema, req);

  sendData(res, delayResponse(await simulationManager.clearDelay(truckId)));
}

/**
 * The live view plus the multiplier currently in force, so the whole
 * `base x multiplier = effective` calculation is legible in one response.
 */
function truckView(state: LiveTruckState) {
  const view = toLiveTruckView(state);
  return {
    ...view,
    delayMultiplier: multiplierFor(view.activeDelay, simulationManager.delayMultipliers),
  };
}

function delayResponse(result: DelayResult) {
  return {
    truck: {
      ...result.truck,
      delayMultiplier: multiplierFor(
        result.truck.activeDelay,
        simulationManager.delayMultipliers,
      ),
    },
    alert: result.alert,
  };
}
