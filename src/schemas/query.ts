import { z } from 'zod';
import {
  alertSeveritySchema,
  alertTypeSchema,
  assignmentStatusSchema,
  booleanQuery,
  delayScenarioSchema,
  dockStatusSchema,
  loadTypeSchema,
  paginationSchema,
  prioritySchema,
  shipmentStatusSchema,
  truckStatusSchema,
} from './common.js';

export const shipmentListQuerySchema = paginationSchema.extend({
  status: shipmentStatusSchema.optional(),
  priority: prioritySchema.optional(),
  loadType: loadTypeSchema.optional(),
});

export const truckListQuerySchema = paginationSchema.extend({
  status: truckStatusSchema.optional(),
  routeId: z.string().min(1).optional(),
  activeDelay: delayScenarioSchema.optional(),
});

export const dockListQuerySchema = paginationSchema.extend({
  status: dockStatusSchema.optional(),
  zone: z.string().min(1).optional(),
  loadType: loadTypeSchema.optional(),
});

export const dockAssignmentListQuerySchema = paginationSchema.extend({
  status: assignmentStatusSchema.optional(),
  truckId: z.string().min(1).optional(),
  dockDoorId: z.string().min(1).optional(),
  shipmentId: z.string().min(1).optional(),
});

export const alertListQuerySchema = paginationSchema.extend({
  type: alertTypeSchema.optional(),
  severity: alertSeveritySchema.optional(),
  acknowledged: booleanQuery.optional(),
  truckId: z.string().min(1).optional(),
  shipmentId: z.string().min(1).optional(),
  dockDoorId: z.string().min(1).optional(),
});

export const referenceParamSchema = z.object({ reference: z.string().min(1) });
export const trackingNumberParamSchema = z.object({ trackingNumber: z.string().min(1) });
