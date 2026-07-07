import { afterEach, describe, expect, test } from 'vitest';
import { disposeClients, getClient, initClients } from '../../mcp';

describe('mcp-clients (sse)', () => {
  afterEach(async () => {
    await disposeClients();
  });

  test('initializes sse client without throwing and returns error object for unhandled tool', async () => {
    initClients({
      servers: [
        {
          headers: { Authorization: 'Bearer test' },
          name: 'web',
          transport: 'sse',
          url: 'http://127.0.0.1:7801/sse', // likely not running; client must ignore failures
        },
      ],
    });
    const client = getClient('web');
    expect(client).toBeTruthy();
    const res = (await client?.callTool('web.ping')) as { error?: string } | undefined;
    expect(res && typeof res === 'object' && 'error' in res).toBe(true);
  });
});
