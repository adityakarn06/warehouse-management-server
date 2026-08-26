import type { DockStatus, LoadType } from '../generated/prisma/enums.js';
import { HttpError } from '../lib/http-error.js';
import { compact } from '../lib/object.js';
import { prisma } from '../lib/prisma.js';
import type { Pagination } from '../types/api.js';
import {
  assignmentRecencyOrder,
  committedAssignmentWhere,
  truckSummarySelect,
} from './selects.js';

export interface DockListFilters extends Pagination {
  status?: DockStatus | undefined;
  zone?: string | undefined;
  loadType?: LoadType | undefined;
}

// Committed-only: a RECOMMENDED row is a proposal, and reporting one here
// would show an AVAILABLE door as occupied.
const currentAssignmentSelect = {
  where: committedAssignmentWhere,
  orderBy: assignmentRecencyOrder,
  take: 1,
  select: {
    id: true,
    status: true,
    score: true,
    reasons: true,
    scheduledStart: true,
    scheduledEnd: true,
    assignedAt: true,
    truck: {
      select: { id: true, reference: true, trailerId: true, status: true, eta: true },
    },
    shipment: { select: { id: true, reference: true, priority: true, loadType: true } },
  },
} as const;

export async function listDocks(filters: DockListFilters) {
  const where = compact({
    status: filters.status,
    zone: filters.zone,
    // `supportedLoadTypes` is a scalar list — `has` matches docks that support it.
    supportedLoadTypes: filters.loadType ? { has: filters.loadType } : undefined,
  });

  const [items, total] = await prisma.$transaction([
    prisma.dockDoor.findMany({
      where,
      orderBy: { code: 'asc' },
      skip: filters.offset,
      take: filters.limit,
      select: {
        id: true,
        code: true,
        name: true,
        zone: true,
        status: true,
        supportedLoadTypes: true,
        latitude: true,
        longitude: true,
        availableFrom: true,
        unavailableReason: true,
        assignments: currentAssignmentSelect,
      },
    }),
    prisma.dockDoor.count({ where }),
  ]);

  return { items, total };
}

const ALERT_LIMIT = 10;
const ASSIGNMENT_HISTORY_LIMIT = 20;

const dockDetailSelect = {
  id: true,
  code: true,
  name: true,
  zone: true,
  status: true,
  supportedLoadTypes: true,
  latitude: true,
  longitude: true,
  availableFrom: true,
  unavailableReason: true,
  createdAt: true,
  updatedAt: true,
  assignments: {
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
      truck: { select: truckSummarySelect },
      shipment: { select: { id: true, reference: true, priority: true, loadType: true } },
    },
  },
  alerts: {
    where: { acknowledged: false },
    orderBy: { createdAt: 'desc' },
    take: ALERT_LIMIT,
    select: {
      id: true,
      type: true,
      severity: true,
      title: true,
      message: true,
      createdAt: true,
    },
  },
} as const;

/** Looks up by primary key, then falls back to `code` (see `getTruckById`). */
export async function getDockById(idOrCode: string) {
  const byId = await prisma.dockDoor.findUnique({
    where: { id: idOrCode },
    select: dockDetailSelect,
  });
  if (byId) return byId;

  const byCode = await prisma.dockDoor.findUnique({
    where: { code: idOrCode },
    select: dockDetailSelect,
  });
  if (byCode) return byCode;

  throw HttpError.notFound(`Dock door ${idOrCode} was not found`);
}
