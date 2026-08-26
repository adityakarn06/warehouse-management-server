import { Router } from 'express';
import {
  getShipment,
  getShipmentByRef,
  getShipments,
} from '../controllers/shipment.controller.js';

export const shipmentsRouter: Router = Router();

shipmentsRouter.get('/', getShipments);
// Registered before '/:id' so the literal segment wins.
shipmentsRouter.get('/reference/:reference', getShipmentByRef);
shipmentsRouter.get('/:id', getShipment);
