import { Router } from 'express';
import { getTruck, getTrucks } from '../controllers/truck.controller.js';

export const trucksRouter: Router = Router();

trucksRouter.get('/', getTrucks);
trucksRouter.get('/:id', getTruck);
