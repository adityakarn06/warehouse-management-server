import { Router } from 'express';
import { getFleet } from '../controllers/fleet.controller.js';

export const fleetRouter: Router = Router();

fleetRouter.get('/', getFleet);
