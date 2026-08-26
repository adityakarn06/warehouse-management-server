import { z } from 'zod';
import {
  AlertSeverity,
  AlertType,
  AssignmentStatus,
  DelayScenario,
  DockStatus,
  LoadType,
  Priority,
  ShipmentStatus,
  TruckStatus,
} from '../generated/prisma/enums.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

/** `z.coerce.boolean()` treats any non-empty string as true — hence the explicit enum. */
export const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

export const idParamSchema = z.object({ id: z.string().min(1) });

export const truckStatusSchema = z.enum(TruckStatus);
export const shipmentStatusSchema = z.enum(ShipmentStatus);
export const dockStatusSchema = z.enum(DockStatus);
export const assignmentStatusSchema = z.enum(AssignmentStatus);
export const prioritySchema = z.enum(Priority);
export const loadTypeSchema = z.enum(LoadType);
export const delayScenarioSchema = z.enum(DelayScenario);
export const alertTypeSchema = z.enum(AlertType);
export const alertSeveritySchema = z.enum(AlertSeverity);
