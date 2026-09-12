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
    const outcome = await Promise.race([
      closeHttpServerForShutdown(server).then(() => 'closed' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 1500)),
    ]);

    expect(outcome).toBe('closed');
    expect(Date.now() - startedAt).toBeLessThan(1500);
    request.destroy();
  });
});
