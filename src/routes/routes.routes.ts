import { Router } from 'express';
import { getRoute } from '../controllers/route.controller.js';

export const routesRouter: Router = Router();

routesRouter.get('/:id', getRoute);
