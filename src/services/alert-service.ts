import type { AlertSeverity, AlertType } from '../generated/prisma/enums.js';
import { compact } from '../lib/object.js';
import { prisma } from '../lib/prisma.js';
import type { Pagination } from '../types/api.js';

export interface AlertListFilters extends Pagination {
  type?: AlertType | undefined;
  severity?: AlertSeverity | undefined;
  acknowledged?: boolean | undefined;
  truckId?: string | undefined;
  shipmentId?: string | undefined;
  dockDoorId?: string | undefined;
}

/**
 * Read surface only for now. Phase 8 adds alert creation to this same service.
 */
export async function listAlerts(filters: AlertListFilters) {
  const where = compact({
    type: filters.type,
    severity: filters.severity,
    acknowledged: filters.acknowledged,
    truckId: filters.truckId,
    shipmentId: filters.shipmentId,
    dockDoorId: filters.dockDoorId,
  });

  const [items, total] = await prisma.$transaction([
    prisma.alert.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: filters.offset,
      take: filters.limit,
      select: {
        id: true,
        type: true,
        severity: true,
        title: true,
        message: true,
        truckId: true,
        shipmentId: true,
        dockDoorId: true,
        metadata: true,
        acknowledged: true,
        acknowledgedAt: true,
        createdAt: true,
      },
    }),
    prisma.alert.count({ where }),
  ]);

  return { items, total };
}
