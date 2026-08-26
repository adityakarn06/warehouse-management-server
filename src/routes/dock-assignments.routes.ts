import { Router } from 'express';
import { getDockAssignments } from '../controllers/dock-assignment.controller.js';

export const dockAssignmentsRouter: Router = Router();

dockAssignmentsRouter.get('/', getDockAssignments);
