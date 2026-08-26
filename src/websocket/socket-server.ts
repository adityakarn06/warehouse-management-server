import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { shipmentSubscriptionSchema, truckSubscriptionSchema } from '../schemas/realtime.js';
import type { SubscribeAck } from './events.js';
import type { RealtimeServer } from './realtime-service.js';
import { OPERATIONS_ROOM, shipmentRoom, truckRoom } from './rooms.js';
import type { SnapshotProvider } from './snapshots.js';
import { liveSnapshotProvider } from './snapshots.js';

/**
 * The Socket.IO server and its subscription protocol.
 *
 * Nothing is broadcast to a socket that did not ask for it: a client joins by
 * emitting `subscribe:operations` / `subscribe:truck` / `subscribe:shipment`
 * and receives its opening snapshot in the ack of that same call.
 */

export interface SocketServerDeps {
  /** Injectable so the socket tests need no database. */
  snapshots: SnapshotProvider;
}

export function createSocketServer(
  httpServer: HttpServer,
  deps: Partial<SocketServerDeps> = {},
): RealtimeServer {
  const snapshots = deps.snapshots ?? liveSnapshotProvider;

  const io: RealtimeServer = new SocketIOServer(httpServer, {
    path: '/socket.io',
    cors: {
      origin: env.corsOrigin,
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    const connectedAt = Date.now();
    logger.info(`Socket connected: ${socket.id} (${socket.handshake.address})`);

    // Rooms this socket actually joined, keyed by every alias it subscribed
    // with. Unsubscribe reads the map instead of re-resolving the id, so a
    // truck joined by cuid can still be left by reference, and a database
    // hiccup can never strand a socket in a room it cannot leave.
    const joinedTruckRooms = new Map<string, string>();
    const joinedShipmentRooms = new Map<string, string>();

    function forget(rooms: Map<string, string>, room: string): void {
      for (const [alias, joined] of rooms) {
        if (joined === room) rooms.delete(alias);
      }
    }

    socket.on('subscribe:operations', (ack) => {
      void guard(ack, async () => {
        await socket.join(OPERATIONS_ROOM);
        logger.info(`Socket ${socket.id} joined ${OPERATIONS_ROOM}`);
        return { ok: true, room: OPERATIONS_ROOM, data: await snapshots.operations() };
      });
    });

    socket.on('unsubscribe:operations', (ack) => {
      void guard(ack, async () => {
        await socket.leave(OPERATIONS_ROOM);
        return { ok: true, room: OPERATIONS_ROOM, data: null };
      });
    });

    socket.on('subscribe:truck', (payload, ack) => {
      void guard(ack, async () => {
        const parsed = truckSubscriptionSchema.safeParse(payload);
        if (!parsed.success) return { ok: false, error: 'truckId is required' };

        const resolved = await snapshots.truck(parsed.data.truckId);
        if (resolved === null) {
          return { ok: false, error: `Truck ${parsed.data.truckId} was not found` };
        }

        // Join by canonical id, so `TRK-101` and its cuid share one room.
        const room = truckRoom(resolved.truckId);
        await socket.join(room);
        joinedTruckRooms.set(parsed.data.truckId, room);
        joinedTruckRooms.set(resolved.truckId, room);
        logger.info(`Socket ${socket.id} joined ${room}`);

        // Snapshot *after* joining. An event emitted between the lookup and the
        // join reaches nobody, and status changes are never repeated, so the
        // opening state must be at least as new as the room membership;
        // `sequenceNumber` lets the client discard the overlap.
        return { ok: true, room, data: (await snapshots.truck(resolved.truckId)) ?? resolved };
      });
    });

    socket.on('unsubscribe:truck', (payload, ack) => {
      void guard(ack, async () => {
        const parsed = truckSubscriptionSchema.safeParse(payload);
        if (!parsed.success) return { ok: false, error: 'truckId is required' };

        const room = joinedTruckRooms.get(parsed.data.truckId) ?? truckRoom(parsed.data.truckId);
        await socket.leave(room);
        forget(joinedTruckRooms, room);
        return { ok: true, room, data: null };
      });
    });

    socket.on('subscribe:shipment', (payload, ack) => {
      void guard(ack, async () => {
        const parsed = shipmentSubscriptionSchema.safeParse(payload);
        if (!parsed.success) return { ok: false, error: 'shipmentId is required' };

        const resolved = await snapshots.shipment(parsed.data.shipmentId);
        if (resolved === null) {
          return { ok: false, error: `Shipment ${parsed.data.shipmentId} was not found` };
        }

        const room = shipmentRoom(resolved.shipmentId);
        await socket.join(room);
        joinedShipmentRooms.set(parsed.data.shipmentId, room);
        joinedShipmentRooms.set(resolved.shipmentId, room);
        logger.info(`Socket ${socket.id} joined ${room}`);

        // Re-read after joining, for the same reason as the truck room above.
        return {
          ok: true,
          room,
          data: (await snapshots.shipment(resolved.shipmentId)) ?? resolved,
        };
      });
    });

    socket.on('unsubscribe:shipment', (payload, ack) => {
      void guard(ack, async () => {
        const parsed = shipmentSubscriptionSchema.safeParse(payload);
        if (!parsed.success) return { ok: false, error: 'shipmentId is required' };

        const room =
          joinedShipmentRooms.get(parsed.data.shipmentId) ??
          shipmentRoom(parsed.data.shipmentId);
        await socket.leave(room);
        forget(joinedShipmentRooms, room);
        return { ok: true, room, data: null };
      });
    });

    socket.on('disconnect', (reason) => {
      const seconds = ((Date.now() - connectedAt) / 1000).toFixed(1);
      logger.info(`Socket disconnected: ${socket.id} (${reason}, after ${seconds}s)`);
    });
  });

  return io;
}

/**
 * Runs a subscribe handler and answers through the ack.
 *
 * Two things this buys: a rejected promise inside a socket handler would
 * otherwise surface as an unhandled rejection and take the process down rather
 * than the request, and the ack is optional on the wire — a client that emits
 * without a callback must not crash the server.
 */
async function guard<T>(
  ack: ((res: SubscribeAck<T>) => void) | undefined,
  run: () => Promise<SubscribeAck<T>>,
): Promise<void> {
  let result: SubscribeAck<T>;
  try {
    result = await run();
  } catch (error) {
    logger.error('Socket subscription failed', error);
    result = { ok: false, error: 'Subscription failed' };
  }

  if (typeof ack === 'function') ack(result);
}
