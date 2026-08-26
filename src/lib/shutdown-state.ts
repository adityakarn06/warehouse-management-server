/**
 * Whether the process has begun shutting down.
 *
 * `httpServer.close()` stops accepting *new connections*, and
 * `closeIdleConnections()` kills only the ones idle at that instant — neither
 * stops a client that already holds a keep-alive connection from sending one
 * more request. That matters here because the request could be
 * `POST /api/v1/simulation/start`, which would install a fresh interval after
 * `simulationManager.stop()` has already flushed, and tick into a Prisma client
 * that is about to disconnect.
 *
 * So the socket-level close is the coarse gate and this is the precise one: the
 * middleware in `src/app.ts` refuses commands with a 503 once `beginShutdown()`
 * has been called. Reads stay open — answering a `GET` on the way down is
 * harmless and makes a rolling restart less abrupt.
 *
 * A module-level flag rather than something threaded through `createApp()`:
 * only `src/server.ts` ever sets it, and the test suites never do, so an app
 * built by `createApp()` in a test is permanently in the "running" state.
 */
let shuttingDown = false;

export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
