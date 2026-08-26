import type { AssignmentStatus, DockStatus } from '../generated/prisma/enums.js';
import type { LiveTruckView } from '../simulation/live-state.js';
import type {
  AlertCreatedPayload,
  TruckEtaPayload,
  TruckPositionPayload,
  TruckStatusPayload,
} from '../simulation/simulation-events.js';

/**
 * The realtime contract (CLAUDE.md §13). This file is the single source of
 * truth a frontend types itself against — every event name, every payload.
 *
 * Events go out **by name**: `socket.on('TRUCK_POSITION_UPDATED', ...)`, not a
 * `{ type, data }` envelope. `RealtimeEvent` below is the internal, tagged form
 * the service routes on; the tag becomes the Socket.IO event name.
 *
 * Payloads stay small (§24): ids and scalars, never a nested database row and
 * never route geometry.
 */

// These payloads are already defined by the engine and already carry the ids
// room routing needs. Re-export rather than redefine, so the two contracts
// cannot drift. `AlertCreatedPayload` joined them in Phase 6, when the delay
// commands became the first thing to raise an alert.
export type {
  AlertCreatedPayload,
  TruckEtaPayload,
  TruckPositionPayload,
  TruckStatusPayload,
};

/** Emitted from Phase 7 onwards (`PATCH /docks/:id/status`). */
export interface DockStatusChangedPayload {
  dockDoorId: string;
  code: string;
  previousStatus: DockStatus;
  status: DockStatus;
  unavailableReason?: string;
  serverTimestamp: string;
}

/** Emitted from Phase 7 onwards (`POST /trucks/:truckId/dock-assignment`). */
export interface DockAssignedPayload {
  assignmentId: string;
  truckId: string;
  shipmentId: string | null;
  dockDoorId: string;
  dockCode: string;
  status: AssignmentStatus;
  score: number | null;
  reasons: string[];
  serverTimestamp: string;
}

/** Emitted from Phase 8 onwards, when a dock failure forces a move. */
export interface DockReassignedPayload extends DockAssignedPayload {
  previousAssignmentId: string;
  previousDockDoorId: string;
  previousDockCode: string;
  /**
   * Why the truck moved, e.g. "D2 taken out of service: hydraulic fault". The
   * board renders `TRK-101 | D2 -> D4 | Reason: ...` straight off this event,
   * so it must not need a second fetch to explain itself.
   */
  reason: string;
}

/**
 * The tagged union the `RealtimeService` routes on. A later phase adds a member
 * here and a room rule in `rooms.ts`; nothing else changes.
 */
export type RealtimeEvent =
  | { type: 'TRUCK_POSITION_UPDATED'; data: TruckPositionPayload }
  | { type: 'TRUCK_ETA_UPDATED'; data: TruckEtaPayload }
  | { type: 'TRUCK_STATUS_CHANGED'; data: TruckStatusPayload }
  | { type: 'ALERT_CREATED'; data: AlertCreatedPayload }
  | { type: 'DOCK_STATUS_CHANGED'; data: DockStatusChangedPayload }
  | { type: 'DOCK_ASSIGNED'; data: DockAssignedPayload }
  | { type: 'DOCK_REASSIGNED'; data: DockReassignedPayload };

export type RealtimeEventType = RealtimeEvent['type'];

/** Server -> client. One method per event name. */
export interface ServerToClientEvents {
  TRUCK_POSITION_UPDATED: (data: TruckPositionPayload) => void;
  TRUCK_ETA_UPDATED: (data: TruckEtaPayload) => void;
  TRUCK_STATUS_CHANGED: (data: TruckStatusPayload) => void;
  ALERT_CREATED: (data: AlertCreatedPayload) => void;
  DOCK_STATUS_CHANGED: (data: DockStatusChangedPayload) => void;
  DOCK_ASSIGNED: (data: DockAssignedPayload) => void;
  DOCK_REASSIGNED: (data: DockReassignedPayload) => void;
}

/**
 * A payload as it actually arrives on the wire. Socket.IO JSON-serialises acks,
 * so a `Date` on the server is an ISO string by the time the client sees it —
 * this file is what a frontend types itself against, and it must not promise a
 * `Date` the client will never receive.
 */
export type Wire<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null
      ? string | null
      : T[K];
};

/** The live truck a subscriber receives — `LiveTruckView` with wire timestamps. */
export type LiveTruckWireView = Wire<LiveTruckView>;

/**
 * Every subscribe/unsubscribe answers through the Socket.IO ack callback rather
 * than a second event, so a client knows immediately whether it joined and gets
 * its opening state in the same round trip.
 */
export type SubscribeAck<T> = { ok: true; room: string; data: T } | { ok: false; error: string };

export interface TruckSubscription {
  /** Truck id or human reference — `TRK-101` and a cuid both resolve. */
  truckId: string;
}

export interface ShipmentSubscription {
  /** Shipment id, reference (`SHP-1001`) or tracking number (`E2-TRACK-101`). */
  shipmentId: string;
}

/** The snapshot a customer tracking client receives when it joins. */
export interface ShipmentSnapshot {
  shipmentId: string;
  truck: LiveTruckWireView | null;
}

/** Client -> server. */
export interface ClientToServerEvents {
  'subscribe:operations': (ack: (res: SubscribeAck<LiveTruckWireView[]>) => void) => void;
  'subscribe:truck': (
    payload: TruckSubscription,
    ack: (res: SubscribeAck<LiveTruckWireView | null>) => void,
  ) => void;
  'subscribe:shipment': (
    payload: ShipmentSubscription,
    ack: (res: SubscribeAck<ShipmentSnapshot>) => void,
  ) => void;

  'unsubscribe:operations': (ack: (res: SubscribeAck<null>) => void) => void;
  'unsubscribe:truck': (
    payload: TruckSubscription,
    ack: (res: SubscribeAck<null>) => void,
  ) => void;
  'unsubscribe:shipment': (
    payload: ShipmentSubscription,
    ack: (res: SubscribeAck<null>) => void,
  ) => void;
}
