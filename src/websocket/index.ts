import type { Server as HttpServer } from 'node:http';
import type { SimulationEventSink } from '../simulation/simulation-events.js';
import { RealtimeService, socketEmitter } from './realtime-service.js';
import type { RealtimeServer } from './realtime-service.js';
import { createSocketServer } from './socket-server.js';
import type { SocketServerDeps } from './socket-server.js';

/**
 * The realtime layer's public face. `src/server.ts` calls `initWebsocket` once
 * and `closeWebsocket` on shutdown; everything else goes through
 * `getRealtimeService()`.
 */

export type {
  AlertCreatedPayload,
  ClientToServerEvents,
  DockAssignedPayload,
  DockReassignedPayload,
  DockStatusChangedPayload,
  LiveTruckWireView,
  RealtimeEvent,
  RealtimeEventType,
  ServerToClientEvents,
  ShipmentSnapshot,
  ShipmentSubscription,
  SubscribeAck,
  Wire,
  TruckEtaPayload,
  TruckPositionPayload,
  TruckStatusPayload,
  TruckSubscription,
} from './events.js';
export { OPERATIONS_ROOM, roomsFor, shipmentRoom, truckRoom } from './rooms.js';
export { RealtimeService, socketEmitter } from './realtime-service.js';
export type { RealtimeEmitter, RealtimeServer } from './realtime-service.js';
export { createSocketServer } from './socket-server.js';
export type { SocketServerDeps } from './socket-server.js';
export { liveSnapshotProvider } from './snapshots.js';
export type { SnapshotProvider } from './snapshots.js';

let io: RealtimeServer | null = null;
let realtime: RealtimeService | null = null;

export function initWebsocket(
  httpServer: HttpServer,
  deps: Partial<SocketServerDeps> = {},
): RealtimeServer {
  // Re-initialising over a live server would orphan it: the old Socket.IO
  // instance keeps its connections while every emitter points at the new one.
  if (io !== null) {
    throw new Error('Socket.IO is already initialised — call closeWebsocket() first');
  }

  const server = createSocketServer(httpServer, deps);

  io = server;
  realtime = new RealtimeService(socketEmitter(server));
  return server;
}

export function getIO(): RealtimeServer {
  if (!io) {
    throw new Error('Socket.IO has not been initialised yet');
  }
  return io;
}

/** The one place domain code reaches the realtime layer. */
export function getRealtimeService(): RealtimeService {
  if (!realtime) {
    throw new Error('Socket.IO has not been initialised yet');
  }
  return realtime;
}

/**
 * The current service, or `null` when there is none. Domain code that emits on
 * a background loop uses this rather than holding a reference: a service
 * captured once would keep emitting into a Socket.IO server that
 * `closeWebsocket()` has already torn down.
 */
export function tryGetRealtimeService(): RealtimeService | null {
  return realtime;
}

/**
 * A sink that resolves the live service on every event, so it survives
 * close/re-init and silently drops events while there is no server.
 */
export function realtimeSimulationSink(): SimulationEventSink {
  return {
    emit(event) {
      realtime?.emit(event);
    },
  };
}

export async function closeWebsocket(): Promise<void> {
  if (!io) return;
  const server = io;
  io = null;
  realtime = null;

  server.disconnectSockets(true);

  // `close()` returns a promise *and* takes a callback. The promise is the
  // simpler of the two here, but note it never rejects: socket.io hands any
  // error to the callback and then resolves unconditionally, so a close failure
  // is not observable this way. That is acceptable — this runs on the shutdown
  // path, where `httpServer.close()` reports the same failure a moment later.
  await server.close();
}
