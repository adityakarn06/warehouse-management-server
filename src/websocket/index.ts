import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';

let io: SocketIOServer | null = null;

export function initWebsocket(httpServer: HttpServer): SocketIOServer {
  const server = new SocketIOServer(httpServer, {
    path: '/socket.io',
    cors: {
      origin: env.corsOrigin,
      methods: ['GET', 'POST'],
    },
  });

  server.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id}`);

    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id} (${reason})`);
    });
  });

  io = server;
  return server;
}

export function getIO(): SocketIOServer {
  if (!io) {
    throw new Error('Socket.IO has not been initialised yet');
  }
  return io;
}

export async function closeWebsocket(): Promise<void> {
  if (!io) return;
  const server = io;
  io = null;

  server.disconnectSockets(true);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
