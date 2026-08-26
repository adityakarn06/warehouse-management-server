import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/index.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';
import { beginShutdown } from './lib/shutdown-state.js';
import { simulationManager } from './simulation/simulation-manager.js';
import { closeWebsocket, initWebsocket, realtimeSimulationSink } from './websocket/index.js';

const app = createApp();
const httpServer = createServer(app);

initWebsocket(httpServer);

// §14: the engine emits domain events into a sink and never imports Socket.IO.
// The sink resolves the live service per event rather than capturing one, so a
// close/re-init cannot leave the engine emitting into a torn-down server.
simulationManager.setSink(realtimeSimulationSink());

httpServer.listen(env.PORT, env.HOST, () => {
  logger.info(`HTTP + Socket.IO listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
  logger.info(`Health:    http://${env.HOST}:${env.PORT}/health`);
  logger.info(`API:       http://${env.HOST}:${env.PORT}/api/v1/health`);
  logger.info(`Socket.IO: ws://${env.HOST}:${env.PORT}/socket.io`);

  // The simulation lives in this same process (§3) and is started here, not in
  // createApp(), so the test suite never spins up a tick loop.
  if (env.simulationAutostart) {
    void simulationManager.start().catch((error: unknown) => {
      logger.error('Failed to start the simulation', error);
    });
  } else {
    logger.info('Simulation autostart disabled — POST /api/v1/simulation/start to run it');
  }
});

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Before anything else: refuse commands from clients already holding a
  // keep-alive connection, which `httpServer.close()` below does not reach.
  beginShutdown();

  const forceExit = setTimeout(() => {
    logger.error(`Shutdown exceeded ${env.SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // Stop accepting new connections here, but do not await the close yet.
  //
  // The await has to come last: Socket.IO's connections are live upgrades, not
  // idle keep-alives, so `close()` does not resolve until `closeWebsocket()` has
  // disconnected them. Awaiting here would deadlock until the force-exit timer
  // fires.
  //
  // Note this only refuses *new connections* — a client on an existing
  // keep-alive can still send another request, which is what `beginShutdown()`
  // above actually guards against.
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
    // `close()` stops accepting new connections but waits on established ones,
    // and a browser holding an idle keep-alive would otherwise pin shutdown
    // until the force-exit timer. In-flight requests are left alone.
    httpServer.closeIdleConnections();
  });

  // Owned from the moment it is created, and declared outside the try so the
  // catch below can settle it too. If `stop()` or `closeWebsocket()` throws we
  // jump straight to the catch and never await `httpClosed`; a rejection from
  // `close()` would then surface as an unowned `unhandledRejection` instead of
  // being logged alongside the shutdown error it belongs to.
  const httpClosedSettled = httpClosed.catch((error: unknown) => {
    logger.error('HTTP server close failed', error);
  });

  try {
    // §22 order: with the door shut, stop the simulation and let it flush, so no
    // tick can write to a connection that is about to close.
    await simulationManager.stop();

    await closeWebsocket();
    logger.info('Socket.IO closed');

    await httpClosed;
    logger.info('HTTP server closed');

    await disconnectPrisma();
    logger.info('Database disconnected');

    clearTimeout(forceExit);
    process.exit(exitCode);
  } catch (error) {
    logger.error('Error during shutdown', error);
    // Settle the close we may never have awaited, so its outcome is logged here
    // rather than escaping as an unhandled rejection after we have exited.
    await httpClosedSettled;
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
  // Exit non-zero: a crash that reports success to its supervisor never restarts.
  void shutdown('uncaughtException', 1);
});
