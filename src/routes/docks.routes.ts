import { Router } from 'express';
import {
  getDock,
  getDocks,
  patchDockStatus,
  postDockRelease,
} from '../controllers/dock.controller.js';

export const docksRouter: Router = Router();

docksRouter.get('/', getDocks);
docksRouter.get('/:id', getDock);
docksRouter.patch('/:id/status', patchDockStatus);
docksRouter.post('/:id/release', postDockRelease);
