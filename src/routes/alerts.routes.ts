import { Router } from 'express';
import { getAlerts } from '../controllers/alert.controller.js';

export const alertsRouter: Router = Router();

alertsRouter.get('/', getAlerts);
