import { Router } from 'express';
import { getDock, getDocks } from '../controllers/dock.controller.js';

export const docksRouter: Router = Router();

docksRouter.get('/', getDocks);
docksRouter.get('/:id', getDock);
