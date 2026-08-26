import type { LoadType, Priority, ShipmentStatus } from '../generated/prisma/enums.js';
import { HttpError } from '../lib/http-error.js';
import { compact } from '../lib/object.js';
import { prisma } from '../lib/prisma.js';
import type { Pagination } from '../types/api.js';
import {
  activeAssignmentWhere,
  assignmentRecencyOrder,
  appointmentSelect,
  dockSummarySelect,
  routeDetailSelect,
} from './selects.js';

export interface ShipmentListFilters extends Pagination {
  status?: ShipmentStatus | undefined;
  priority?: Priority | undefined;
  loadType?: LoadType | undefined;
}

export async function listShipments(filters: ShipmentListFilters) {
  const where = compact({
    status: filters.status,
    priority: filters.priority,
    loadType: filters.loadType,
  });

  const [items, total] = await prisma.$transaction([
    prisma.shipment.findMany({
      where,
      orderBy: { reference: 'asc' },
      skip: filters.offset,
      take: filters.limit,
      select: {
        id: true,
        reference: true,
        trackingNumber: true,
        customerName: true,
        originName: true,
        destinationName: true,
        status: true,
        priority: true,
        loadType: true,
        weightKg: true,
        palletCount: true,
        truck: {
          select: {
            id: true,
            reference: true,
            trailerId: true,
            status: true,
            progress: true,
            eta: true,
          },
        },
        appointment: {
          select: { windowStart: true, windowEnd: true, expectedDurationMinutes: true },
        },
      },
    }),
    prisma.shipment.count({ where }),
  ]);

  return { items, total };
}

const shipmentDetailSelect = {
  id: true,
  reference: true,
  trackingNumber: true,
  customerName: true,
  originName: true,
  destinationName: true,
  status: true,
  priority: true,
  loadType: true,
  weightKg: true,
  palletCount: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  truck: {
    select: {
      id: true,
      reference: true,
      trailerId: true,
      driverName: true,
      driverPhone: true,
      carrier: true,
      status: true,
      activeDelay: true,
      currentLatitude: true,
      currentLongitude: true,
      progress: true,
      speedKmph: true,
      eta: true,
      departedAt: true,
      arrivedAt: true,
      lastUpdatedAt: true,
      route: { select: routeDetailSelect },
    },
  },
  appointment: { select: appointmentSelect },
  dockAssignments: {
    where: activeAssignmentWhere,
    orderBy: assignmentRecencyOrder,
    select: {
      id: true,
      status: true,
      score: true,
      reasons: true,
      scheduledStart: true,
      scheduledEnd: true,
      assignedAt: true,
      dockDoor: { select: dockSummarySelect },
    },
  },
} as const;

/** Looks up by primary key, then falls back to `reference` (see `getTruckById`). */
export async function getShipmentById(idOrReference: string) {
  const byId = await prisma.shipment.findUnique({
    where: { id: idOrReference },
    select: shipmentDetailSelect,
  });
  if (byId) return byId;

  const byReference = await prisma.shipment.findUnique({
    where: { reference: idOrReference },
    select: shipmentDetailSelect,
  });
  if (byReference) return byReference;

  throw HttpError.notFound(`Shipment ${idOrReference} was not found`);
}

export async function getShipmentByReference(reference: string) {
  const shipment = await prisma.shipment.findUnique({
    where: { reference },
    select: shipmentDetailSelect,
  });
  if (!shipment) {
    throw HttpError.notFound(`Shipment with reference ${reference} was not found`);
  }
  return shipment;
}
