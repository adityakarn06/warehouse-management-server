import { Router } from 'express';
import { getDock, getDocks, patchDockStatus } from '../controllers/dock.controller.js';

export const docksRouter: Router = Router();

docksRouter.get('/', getDocks);
docksRouter.get('/:id', getDock);
docksRouter.patch('/:id/status', patchDockStatus);
