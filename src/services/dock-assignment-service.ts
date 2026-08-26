import type { AssignmentStatus } from '../generated/prisma/enums.js';
import { compact } from '../lib/object.js';
import { prisma } from '../lib/prisma.js';
import type { Pagination } from '../types/api.js';
import { dockSummarySelect } from './selects.js';

export interface DockAssignmentListFilters extends Pagination {
  status?: AssignmentStatus | undefined;
  truckId?: string | undefined;
  dockDoorId?: string | undefined;
  shipmentId?: string | undefined;
}

export async function listDockAssignments(filters: DockAssignmentListFilters) {
  const where = compact({
    status: filters.status,
    truckId: filters.truckId,
    dockDoorId: filters.dockDoorId,
    shipmentId: filters.shipmentId,
  });

  const [items, total] = await prisma.$transaction([
    prisma.dockAssignment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: filters.offset,
      take: filters.limit,
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
        previousAssignmentId: true,
        createdAt: true,
        truck: {
          select: { id: true, reference: true, trailerId: true, status: true, eta: true },
        },
        shipment: { select: { id: true, reference: true, priority: true, loadType: true } },
        dockDoor: { select: dockSummarySelect },
      },
    }),
    prisma.dockAssignment.count({ where }),
  ]);

  return { items, total };
}
