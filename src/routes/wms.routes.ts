import { Router } from 'express';
import { postWmsEvent, postWmsSimulate } from '../controllers/wms.controller.js';

export const wmsRouter: Router = Router();

wmsRouter.post('/events', postWmsEvent);
wmsRouter.post('/simulate', postWmsSimulate);
