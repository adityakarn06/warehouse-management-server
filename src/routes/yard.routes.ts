import { Router } from 'express';
import {
  getAllocationSummaryHandler,
  getDockingQueueHandler,
  getOverview,
} from '../controllers/yard.controller.js';

export const yardRouter: Router = Router();

yardRouter.get('/overview', getOverview);
yardRouter.get('/docking-queue', getDockingQueueHandler);
yardRouter.get('/allocation-summary', getAllocationSummaryHandler);
