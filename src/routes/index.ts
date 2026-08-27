import { Router } from 'express';
import { alertsRouter } from './alerts.routes.js';
import { dockAssignmentsRouter } from './dock-assignments.routes.js';
import { docksRouter } from './docks.routes.js';
import { fleetRouter } from './fleet.routes.js';
import { healthRouter } from './health.routes.js';
import { routesRouter } from './routes.routes.js';
import { shipmentsRouter } from './shipments.routes.js';
import { simulationRouter } from './simulation.routes.js';
import { trackingRouter } from './tracking.routes.js';
import { trucksRouter } from './trucks.routes.js';
import { wmsRouter } from './wms.routes.js';
import { yardRouter } from './yard.routes.js';

/** Everything mounted under /api/v1. */
export const apiV1Router: Router = Router();

apiV1Router.use('/health', healthRouter);
apiV1Router.use('/shipments', shipmentsRouter);
apiV1Router.use('/tracking', trackingRouter);
apiV1Router.use('/trucks', trucksRouter);
apiV1Router.use('/fleet', fleetRouter);
apiV1Router.use('/routes', routesRouter);
apiV1Router.use('/docks', docksRouter);
apiV1Router.use('/dock-assignments', dockAssignmentsRouter);
apiV1Router.use('/alerts', alertsRouter);
apiV1Router.use('/yard', yardRouter);
apiV1Router.use('/simulation', simulationRouter);
apiV1Router.use('/wms', wmsRouter);
