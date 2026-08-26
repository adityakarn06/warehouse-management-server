import { Router } from 'express';
import {
  getDockRecommendations,
  getTruck,
  getTrucks,
  postDockAssignment,
} from '../controllers/truck.controller.js';

export const trucksRouter: Router = Router();

trucksRouter.get('/', getTrucks);
trucksRouter.get('/:id', getTruck);
trucksRouter.get('/:truckId/dock-recommendations', getDockRecommendations);
trucksRouter.post('/:truckId/dock-assignment', postDockAssignment);
