import type { Request, Response } from 'express';
import { sendData, sendList } from '../lib/api-response.js';
import { parseParams, parseQuery } from '../lib/validate.js';
import { idParamSchema } from '../schemas/common.js';
import { referenceParamSchema, shipmentListQuerySchema } from '../schemas/query.js';
import {
  getShipmentById,
  getShipmentByReference,
  listShipments,
} from '../services/shipment-service.js';

export async function getShipments(req: Request, res: Response): Promise<void> {
  const query = parseQuery(shipmentListQuerySchema, req);
  const { items, total } = await listShipments(query);
  sendList(res, items, { total, limit: query.limit, offset: query.offset });
}

export async function getShipment(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(idParamSchema, req);
  sendData(res, await getShipmentById(id));
}

export async function getShipmentByRef(req: Request, res: Response): Promise<void> {
  const { reference } = parseParams(referenceParamSchema, req);
  sendData(res, await getShipmentByReference(reference));
}
