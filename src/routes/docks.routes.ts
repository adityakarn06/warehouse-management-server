import { Router } from 'express';
import {
  getDock,
  getDockScheduleHandler,
  getDocks,
  patchDockStatus,
  postDockRelease,
} from '../controllers/dock.controller.js';

export const docksRouter: Router = Router();

docksRouter.get('/', getDocks);
// Must precede `/:id`, or Express would match `schedule` as a dock id.
docksRouter.get('/schedule', getDockScheduleHandler);
docksRouter.get('/:id', getDock);
docksRouter.patch('/:id/status', patchDockStatus);
docksRouter.post('/:id/release', postDockRelease);
