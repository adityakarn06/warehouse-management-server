import type { Prisma } from '../generated/prisma/client.js';
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

/** The shape every alert leaves this service in, read or written. */
const alertSelect = {
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
} as const;

/**
 * The alert surface. Phase 6 adds the first writer (`TRUCK_DELAYED`); Phase 8's
 * dock alerts reuse `createAlert` unchanged, which is why it is typed against
 * the whole `AlertType` enum rather than the delay case.
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
      select: alertSelect,
    }),
    prisma.alert.count({ where }),
  ]);

  return { items, total };
}

export interface CreateAlertInput {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  truckId?: string | null;
  shipmentId?: string | null;
  dockDoorId?: string | null;
  /** Extra operational context — the delay type, the speeds, the ETA shift. */
  metadata?: Prisma.InputJsonValue;
}

export type AlertRecord = Awaited<ReturnType<typeof createAlert>>;

/**
 * Writes one alert. Deliberately does *not* emit `ALERT_CREATED`: the caller
 * owns emission, so the simulation engine keeps its single event path through
 * the `SimulationEventSink` and never reaches for Socket.IO (§14).
 */
export async function createAlert(input: CreateAlertInput) {
  return prisma.alert.create({
    data: {
      type: input.type,
      severity: input.severity,
      title: input.title,
      message: input.message,
      // Null and undefined both mean "no relation": they collapse to undefined
      // and compact() strips the key, letting the nullable column default.
      ...compact({
        truckId: input.truckId ?? undefined,
        shipmentId: input.shipmentId ?? undefined,
        dockDoorId: input.dockDoorId ?? undefined,
        metadata: input.metadata,
      }),
    },
    select: alertSelect,
  });
}
