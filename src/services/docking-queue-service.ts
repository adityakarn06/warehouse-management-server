import { recommendDocks } from '../docking/dock-assignment-service.js';
import { env } from '../config/index.js';
import type { Priority } from '../generated/prisma/enums.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type {
  DockingQueueEntry,
  DockingQueueResponse,
  DockingQueueWindow,
} from '../types/api.js';
import { committedAssignmentWhere } from './selects.js';

const PRIORITY_RANK: Record<Priority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/**
 * "Identify the trailer that needs to be docked for each arrival window"
 * (problem statement §4). A truck qualifies once it is physically close
 * (`ARRIVING`/`ARRIVED`) or its appointment window opens within the horizon,
 * and it holds no committed door yet — `dockAssignments: { none: ... } }`
 * reuses the same committed/recommended distinction the rest of the read side
 * is built on (`src/services/selects.ts`).
 *
 * Read-only: `recommendDocks` is documented side-effect free, so this never
 * writes a `RECOMMENDED` row (§2 — the operator still presses assign).
 */
export async function getDockingQueue(now = new Date()): Promise<DockingQueueResponse> {
  const horizon = new Date(now.getTime() + env.ARRIVAL_HORIZON_MINUTES * 60_000);

  const trucks = await prisma.truck.findMany({
    where: {
      status: { notIn: ['COMPLETED', 'DOCKED'] },
      dockAssignments: { none: committedAssignmentWhere },
      OR: [
        { status: { in: ['ARRIVING', 'ARRIVED'] } },
        // "Opens within the horizon" (§4) — bounded on both sides, so a window
        // that finished hours ago does not pin a stuck truck in the queue
        // forever. A window already open but not yet closed still qualifies.
        {
          shipment: {
            appointment: { windowStart: { lte: horizon }, windowEnd: { gte: now } },
          },
        },
      ],
    },
    select: {
      id: true,
      reference: true,
      trailerId: true,
      status: true,
      eta: true,
      progress: true,
      shipment: {
        select: {
          reference: true,
          priority: true,
          loadType: true,
          appointment: { select: { windowStart: true, windowEnd: true } },
        },
      },
    },
  });

  const buckets = new Map<string, { windowStart: Date | null; windowEnd: Date | null; rows: typeof trucks }>();
  const UNSCHEDULED_KEY = 'UNSCHEDULED';

  for (const truck of trucks) {
    const appointment = truck.shipment?.appointment ?? null;
    const key = appointment ? appointment.windowStart.toISOString() : UNSCHEDULED_KEY;

    const bucket = buckets.get(key);
    if (bucket) {
      bucket.rows.push(truck);
    } else {
      buckets.set(key, {
        windowStart: appointment?.windowStart ?? null,
        windowEnd: appointment?.windowEnd ?? null,
        rows: [truck],
      });
    }
  }

  const sortedKeys = [...buckets.keys()].sort((a, b) => {
    if (a === UNSCHEDULED_KEY) return b === UNSCHEDULED_KEY ? 0 : 1;
    if (b === UNSCHEDULED_KEY) return -1;
    return a.localeCompare(b);
  });

  const windows: DockingQueueWindow[] = [];

  for (const key of sortedKeys) {
    const bucket = buckets.get(key);
    if (!bucket) continue;

    const sorted = [...bucket.rows].sort((a, b) => {
      const priorityDiff =
        (PRIORITY_RANK[a.shipment?.priority ?? 'MEDIUM'] ?? 2) -
        (PRIORITY_RANK[b.shipment?.priority ?? 'MEDIUM'] ?? 2);
      if (priorityDiff !== 0) return priorityDiff;
      if (a.eta === null) return b.eta === null ? 0 : 1;
      if (b.eta === null) return -1;
      return a.eta.getTime() - b.eta.getTime();
    });

    // Independent per truck, so fetched concurrently; one truck the scorer
    // can no longer resolve (e.g. it moved on between the list query and here)
    // must not fail the whole queue — it just gets no recommendation.
    const entries: DockingQueueEntry[] = await Promise.all(
      sorted.map(async (truck): Promise<DockingQueueEntry> => {
        let top: Awaited<ReturnType<typeof recommendDocks>>['recommendations'][number] | null =
          null;
        try {
          const recommendation = await recommendDocks(truck.id, now);
          top = recommendation.recommendations[0] ?? null;
        } catch (error) {
          logger.error(`Failed to score dock recommendations for ${truck.reference}`, error);
        }

        return {
          truckId: truck.id,
          truckReference: truck.reference,
          trailerId: truck.trailerId,
          status: truck.status,
          eta: truck.eta?.toISOString() ?? null,
          progress: truck.progress,
          shipmentReference: truck.shipment?.reference ?? null,
          priority: truck.shipment?.priority ?? null,
          loadType: truck.shipment?.loadType ?? null,
          topRecommendation: top
            ? { dockId: top.dockId, dockCode: top.dockCode, score: top.score, reasons: top.reasons }
            : null,
        };
      }),
    );

    windows.push({
      windowStart: bucket.windowStart?.toISOString() ?? null,
      windowEnd: bucket.windowEnd?.toISOString() ?? null,
      entries,
    });
  }

  return {
    generatedAt: now.toISOString(),
    horizonMinutes: env.ARRIVAL_HORIZON_MINUTES,
    windows,
  };
}
