import { once } from 'node:events';
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { closeHttpServerForShutdown } from '../../assistant-server/close-http-server';

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('missing address');
  }
  return address.port;
}

describe('closeHttpServerForShutdown', () => {
  it('keeps repeated shutdown idempotent after the listener has closed', async () => {
    const server = http.createServer();
    await listen(server);
    await closeHttpServerForShutdown(server);
    await expect(closeHttpServerForShutdown(server)).resolves.toBeUndefined();
  });

  it('resolves while a streaming response is still open', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: open\n\n');
      // Deliberately never ended: the run behind it is still streaming.
    });
    const port = await listen(server);
    const request = http.get({ host: '127.0.0.1', path: '/stream', port });
    const [response] = (await once(request, 'response')) as [http.IncomingMessage];
    await once(response, 'data');

    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        closeHttpServerForShutdown(server).then(() => 'closed' as const),
        new Promise<'timed-out'>((resolve) => {
          timer = setTimeout(() => resolve('timed-out'), 1500);
        }),
      ]);

      expect(outcome).toBe('closed');
      expect(Date.now() - startedAt).toBeLessThan(1500);
    } finally {
      clearTimeout(timer);
      request.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
