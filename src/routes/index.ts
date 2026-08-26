import { Router } from 'express';
import { healthRouter } from './health.routes.js';

/**
 * Everything mounted under /api/v1. Domain routers (trucks, docks, shipments,
 * alerts, wms) get added here in later phases.
 */
export const apiV1Router: Router = Router();

apiV1Router.use('/health', healthRouter);
