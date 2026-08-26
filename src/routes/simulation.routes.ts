import { Router } from 'express';
import {
  getSimulationState,
  getSimulationTruckState,
  resetSimulation,
  startSimulation,
  stopSimulation,
} from '../controllers/simulation.controller.js';

export const simulationRouter: Router = Router();

simulationRouter.post('/start', startSimulation);
simulationRouter.post('/stop', stopSimulation);
simulationRouter.post('/reset', resetSimulation);
simulationRouter.get('/state', getSimulationState);
simulationRouter.get('/trucks/:truckId', getSimulationTruckState);
