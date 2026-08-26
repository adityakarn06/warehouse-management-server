import { Router } from 'express';
import { getOverview } from '../controllers/yard.controller.js';

export const yardRouter: Router = Router();

yardRouter.get('/overview', getOverview);
