import type { LiveTruckState, LiveTruckView } from '../simulation/live-state.js';
import { toLiveTruckView } from '../simulation/live-state.js';
import { simulationManager } from '../simulation/simulation-manager.js';
import { resolveShipmentTruck } from '../services/shipment-service.js';
import { getTruckLiveRow, listMovingTruckLiveRows } from '../services/truck-service.js';
import type { LiveTruckWireView, ShipmentSnapshot } from './events.js';

/**
 * "Receive the latest relevant state immediately after joining."
 *
 * A subscriber should not have to wait up to a tick to draw something, so every
 * successful subscribe answers with a snapshot. The provider is an interface so
 * the socket tests can run without a database.
 *
 * Snapshots are wire-shaped (`LiveTruckWireView`): timestamps are serialised
 * here rather than left as `Date`s that Socket.IO would silently stringify.
 */
export interface SnapshotProvider {
  /** Every truck the loop is currently advancing, or would be. */
  operations(): Promise<LiveTruckWireView[]>;
  /** One truck by id or reference, or `null` when there is no such truck. */
  truck(idOrReference: string): Promise<LiveTruckWireView | null>;
  /**
   * The canonical shipment id plus its truck. `null` when the shipment does not
   * exist — distinct from a found shipment whose truck has no live state.
   */
  shipment(idOrReference: string): Promise<ShipmentSnapshot | null>;
}

/**
 * Live state first, database second. `LiveStateStore.get` already resolves an
 * id or a reference, so `TRK-101` and a cuid both land on the same truck.
 */
export const liveSnapshotProvider: SnapshotProvider = {
  async operations() {
    const live = simulationManager.getAllTruckStates();
    // An empty map means the loop has not loaded the fleet (autostart off, or
    // stopped) — not that the yard is empty. Fall back to the database so a
    // dashboard never joins to a blank map.
    if (live.length > 0) return live.map(toWireView);

    return (await listMovingTruckLiveRows()).map(rowToWireView);
  },

  async truck(idOrReference) {
    const live = simulationManager.getTruckState(idOrReference);
    if (live) return toWireView(live);

    const row = await getTruckLiveRow(idOrReference);
    return row === null ? null : rowToWireView(row);
  },

  async shipment(idOrReference) {
    const resolved = await resolveShipmentTruck(idOrReference);
    if (resolved === null) return null;

    return { shipmentId: resolved.shipmentId, truck: await this.truck(resolved.truckId) };
  },
};

type TruckLiveRow = NonNullable<Awaited<ReturnType<typeof getTruckLiveRow>>>;

/** In-memory state as it goes on the wire. */
function toWireView(state: LiveTruckState): LiveTruckWireView {
  return toWire(toLiveTruckView(state));
}

/**
 * A persisted truck rendered as a live view. `sequenceNumber` restarts at 0
 * because sequence numbers are per-run engine bookkeeping and never reach the
 * database; `previous*` is omitted for the same reason. That is safe for a
 * client that re-baselines its high-water mark on every snapshot (see
 * `api-docs/realtime.md`): a truck answered from the database is one the loop
 * is not advancing, so no event can be in flight below it.
 */
function rowToWireView(row: TruckLiveRow): LiveTruckWireView {
  return toWire({
    truckId: row.id,
    reference: row.reference,
    routeId: row.routeId,
    shipmentId: row.shipment?.id ?? null,
    latitude: row.currentLatitude,
    longitude: row.currentLongitude,
    progress: row.progress,
    speedKmph: row.speedKmph,
    eta: row.eta,
    status: row.status,
    activeDelay: row.activeDelay,
    arrivedAt: row.arrivedAt,
    lastUpdatedAt: row.lastUpdatedAt,
    sequenceNumber: 0,
  });
}

function toWire(view: LiveTruckView): LiveTruckWireView {
  return {
    ...view,
    eta: view.eta?.toISOString() ?? null,
    arrivedAt: view.arrivedAt?.toISOString() ?? null,
    lastUpdatedAt: view.lastUpdatedAt.toISOString(),
  };
}
