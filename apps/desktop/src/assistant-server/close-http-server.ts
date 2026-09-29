import type http from 'node:http';

/**
 * Stops the assistant HTTP server for shutdown. `server.close()` alone only
 * stops accepting connections and waits for every in-flight response to end;
 * an open assistant stream or a renderer keep-alive socket holds it past the
 * graceful-shutdown budget. Shutdown owns those connections: they are ended
 * here, and the run behind a severed stream sees the same socket close it sees
 * when a renderer disconnects.
 */
export function closeHttpServerForShutdown(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}
