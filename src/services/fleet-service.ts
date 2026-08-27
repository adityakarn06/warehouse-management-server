import type { Prisma } from '../generated/prisma/client.js';
import type { DelayScenario, TruckStatus } from '../generated/prisma/enums.js';
import { compact } from '../lib/object.js';
import { prisma } from '../lib/prisma.js';
import type { Pagination } from '../types/api.js';
import type { FleetTruck } from '../types/api.js';
import { assignmentRecencyOrder, committedAssignmentWhere } from './selects.js';

export interface FleetListFilters extends Pagination {
  status?: TruckStatus | undefined;
  activeDelay?: DelayScenario | undefined;
  search?: string | undefined;
}

const fleetTruckSelect = {
  id: true,
  reference: true,
  trailerId: true,
  carrier: true,
  driverName: true,
  driverPhone: true,
  status: true,
  activeDelay: true,
  progress: true,
  speedKmph: true,
  eta: true,
  lastUpdatedAt: true,
  route: {
    select: {
      id: true,
      code: true,
      name: true,
      originName: true,
      destinationName: true,
      distanceKm: true,
    },
  },
  shipment: {
    select: {
      id: true,
      reference: true,
      trackingNumber: true,
      customerName: true,
      status: true,
      priority: true,
      loadType: true,
      weightKg: true,
      palletCount: true,
    },
  },
  // Committed-only — a `RECOMMENDED` row is a proposal, not a door (fleet.md).
  dockAssignments: {
    where: committedAssignmentWhere,
    orderBy: assignmentRecencyOrder,
    take: 1,
    select: {
      id: true,
      status: true,
      dockDoor: { select: { id: true, code: true, name: true, zone: true } },
    },
  },
} as const;

type FleetTruckRow = Prisma.TruckGetPayload<{ select: typeof fleetTruckSelect }>;

function toFleetTruck(row: FleetTruckRow): FleetTruck {
  const assignment = row.dockAssignments[0];
  return {
    id: row.id,
    reference: row.reference,
    trailerId: row.trailerId,
    carrier: row.carrier,
    driverName: row.driverName,
    driverPhone: row.driverPhone,
    status: row.status,
    activeDelay: row.activeDelay,
    progress: row.progress,
    speedKmph: row.speedKmph,
    eta: row.eta?.toISOString() ?? null,
    lastUpdatedAt: row.lastUpdatedAt.toISOString(),
    route: row.route,
    shipment: row.shipment,
    dock: assignment
      ? {
          id: assignment.dockDoor.id,
          code: assignment.dockDoor.code,
          name: assignment.dockDoor.name,
          zone: assignment.dockDoor.zone,
          assignmentId: assignment.id,
          assignmentStatus: assignment.status,
        }
      : null,
  };
}

export async function listFleet(
  filters: FleetListFilters,
): Promise<{ items: FleetTruck[]; total: number }> {
  const where: Prisma.TruckWhereInput = compact({
    status: filters.status,
    activeDelay: filters.activeDelay,
  });

  if (filters.search) {
    where.OR = [
      { reference: { contains: filters.search, mode: 'insensitive' } },
      { trailerId: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  const [rows, total] = await prisma.$transaction([
    prisma.truck.findMany({
      where,
      orderBy: { reference: 'asc' },
      skip: filters.offset,
      take: filters.limit,
      select: fleetTruckSelect,
    }),
    prisma.truck.count({ where }),
  ]);

  return { items: rows.map(toFleetTruck), total };
}
