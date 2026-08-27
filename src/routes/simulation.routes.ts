import { Router } from 'express';
import {
  applyTruckDelay,
  clearTruckDelay,
  getSimulationState,
  getSimulationStatus,
  getSimulationTruckState,
  resetSimulation,
  startSimulation,
  stopSimulation,
} from '../controllers/simulation.controller.js';

export const simulationRouter: Router = Router();

simulationRouter.post('/start', startSimulation);
simulationRouter.post('/stop', stopSimulation);
simulationRouter.post('/reset', resetSimulation);
simulationRouter.get('/status', getSimulationStatus);
simulationRouter.get('/state', getSimulationState);
simulationRouter.get('/trucks/:truckId', getSimulationTruckState);
simulationRouter.post('/trucks/:truckId/delay', applyTruckDelay);
simulationRouter.post('/trucks/:truckId/clear-delay', clearTruckDelay);
