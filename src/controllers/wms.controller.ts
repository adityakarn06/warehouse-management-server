import type { Request, Response } from 'express';
import { sendData } from '../lib/api-response.js';
import { parseBody } from '../lib/validate.js';
import { wmsEventSchema, wmsSimulateCommandSchema } from '../schemas/wms.js';
import { handleWmsEvent } from '../wms/wms-event-handler.js';
import { runWmsScenario } from '../wms/wms-scenarios.js';

/**
 * The simulated WMS ingestion surface (CLAUDE.md §15). These handlers parse and
 * delegate and do nothing else — the business logic belongs to
 * `WmsEventHandler`, never to the route.
 */

export async function postWmsEvent(req: Request, res: Response): Promise<void> {
  const event = parseBody(wmsEventSchema, req);
  sendData(res, await handleWmsEvent(event));
}

export async function postWmsSimulate(req: Request, res: Response): Promise<void> {
  const { scenario } = parseBody(wmsSimulateCommandSchema, req);
  sendData(res, { scenario, steps: await runWmsScenario(scenario) });
}
