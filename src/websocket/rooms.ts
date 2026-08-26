import type { RealtimeEvent } from './events.js';

/**
 * The three rooms of CLAUDE.md §12.
 *
 * Room names are always built from **canonical ids**. A client may subscribe
 * with a human reference (`TRK-101`, `E2-TRACK-101`); the subscribe handler
 * resolves it first, so there is exactly one room per truck and per shipment.
 */

export const OPERATIONS_ROOM = 'operations';

export function truckRoom(truckId: string): string {
  return `truck:${truckId}`;
}

export function shipmentRoom(shipmentId: string): string {
  return `shipment:${shipmentId}`;
}

/**
 * Which rooms an event goes to. `io.to([...])` de-duplicates delivery, so a
 * socket that is in both `operations` and `truck:TRK-101` still receives one copy.
 *
 * Everything operational reaches `operations`. Anything that names a truck or a
 * shipment also reaches that entity's room, which is what makes the customer
 * tracking feed a strict subset of the dashboard feed.
 */
export function roomsFor(event: RealtimeEvent): string[] {
  const rooms = [OPERATIONS_ROOM];

  switch (event.type) {
    case 'TRUCK_POSITION_UPDATED':
    case 'TRUCK_ETA_UPDATED':
    case 'TRUCK_STATUS_CHANGED':
    case 'DOCK_ASSIGNED':
    case 'DOCK_REASSIGNED':
      rooms.push(truckRoom(event.data.truckId));
      if (event.data.shipmentId) rooms.push(shipmentRoom(event.data.shipmentId));
      break;

    case 'ALERT_CREATED':
      // An alert may be about a dock rather than a truck, so both ids are optional.
      if (event.data.truckId) rooms.push(truckRoom(event.data.truckId));
      if (event.data.shipmentId) rooms.push(shipmentRoom(event.data.shipmentId));
      break;

    case 'DOCK_STATUS_CHANGED':
      // A dock going down is yard news; the affected truck learns about it
      // through the DOCK_REASSIGNED / ALERT_CREATED that follows.
      break;
  }

  return rooms;
}
