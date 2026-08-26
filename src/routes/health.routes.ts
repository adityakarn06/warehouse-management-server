import { Router } from 'express';
import { getDatabaseHealth, getHealth } from '../controllers/health.controller.js';

export const healthRouter: Router = Router();

healthRouter.get('/', getHealth);
healthRouter.get('/db', getDatabaseHealth);
