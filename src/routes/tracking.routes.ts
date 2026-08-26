import { Router } from 'express';
import { getTracking } from '../controllers/tracking.controller.js';

export const trackingRouter: Router = Router();

trackingRouter.get('/:trackingNumber', getTracking);
