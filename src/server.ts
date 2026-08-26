import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/index.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';
import { closeWebsocket, initWebsocket } from './websocket/index.js';

const app = createApp();
const httpServer = createServer(app);

initWebsocket(httpServer);

httpServer.listen(env.PORT, env.HOST, () => {
  logger.info(`HTTP + Socket.IO listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
  logger.info(`Health:    http://${env.HOST}:${env.PORT}/health`);
  logger.info(`API:       http://${env.HOST}:${env.PORT}/api/v1/health`);
  logger.info(`Socket.IO: ws://${env.HOST}:${env.PORT}/socket.io`);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    logger.error(`Shutdown exceeded ${env.SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await closeWebsocket();
    logger.info('Socket.IO closed');

    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(error);
          return;
        }
        resolve();
      });
    });
    logger.info('HTTP server closed');

    await disconnectPrisma();
    logger.info('Database disconnected');

    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', error);
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  void shutdown('uncaughtException');
});
