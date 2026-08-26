import type { DelayScenario, TruckStatus } from '../generated/prisma/enums.js';
import { HttpError } from '../lib/http-error.js';
import { compact } from '../lib/object.js';
import { prisma } from '../lib/prisma.js';
import type { Pagination } from '../types/api.js';
import {
  appointmentSelect,
  assignmentRecencyOrder,
  dockSummarySelect,
  routeDetailSelect,
  routeSummarySelect,
  shipmentSummarySelect,
} from './selects.js';

export interface TruckListFilters extends Pagination {
  status?: TruckStatus | undefined;
  routeId?: string | undefined;
  activeDelay?: DelayScenario | undefined;
}

const LOCATION_HISTORY_LIMIT = 20;
const ASSIGNMENT_HISTORY_LIMIT = 20;

export async function listTrucks(filters: TruckListFilters) {
  const where = compact({
    status: filters.status,
    routeId: filters.routeId,
    activeDelay: filters.activeDelay,
  });

  const [items, total] = await prisma.$transaction([
    prisma.truck.findMany({
      where,
      orderBy: { reference: 'asc' },
      skip: filters.offset,
      take: filters.limit,
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
        route: { select: routeSummarySelect },
        shipment: { select: shipmentSummarySelect },
      },
    }),
    prisma.truck.count({ where }),
  ]);

  return { items, total };
}

/**
 * Seeded rows use their human reference as the primary key, but rows created at
 * runtime get a `cuid()`. Look up by id first and fall back to `reference` so
 * both `/trucks/TRK-101` and `/trucks/<cuid>` work. The extra query only runs
 * on a miss.
 */
export async function getTruckById(idOrReference: string) {
  const select = {
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
    createdAt: true,
    updatedAt: true,
    route: { select: routeDetailSelect },
    shipment: {
      select: { ...shipmentSummarySelect, appointment: { select: appointmentSelect } },
    },
    dockAssignments: {
      orderBy: assignmentRecencyOrder,
      take: ASSIGNMENT_HISTORY_LIMIT,
      select: {
        id: true,
        status: true,
        score: true,
        reasons: true,
        scheduledStart: true,
        scheduledEnd: true,
        assignedAt: true,
        releasedAt: true,
        reassignedAt: true,
        dockDoor: { select: dockSummarySelect },
      },
    },
    locationHistory: {
      orderBy: { recordedAt: 'desc' },
      take: LOCATION_HISTORY_LIMIT,
      select: {
        id: true,
        latitude: true,
        longitude: true,
        progress: true,
        speedKmph: true,
        status: true,
        eta: true,
        reason: true,
        recordedAt: true,
      },
    },
  } as const;

  const byId = await prisma.truck.findUnique({ where: { id: idOrReference }, select });
  if (byId) return byId;

  const byReference = await prisma.truck.findUnique({
    where: { reference: idOrReference },
    select,
  });
  if (byReference) return byReference;

  throw HttpError.notFound(`Truck ${idOrReference} was not found`);
}
