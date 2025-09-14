import { afterEach, describe, expect, test } from 'vitest';
import { disposeClients, getClient, initClients } from '../../mcp-clients';

describe('mcp-clients', () => {
  afterEach(async () => {
    await disposeClients();
  });

  test('initializes filesystem stdio client and lists files from base dir', async () => {
    const base = process.cwd();
    initClients({
      servers: [
        {
          transport: 'stdio',
          name: 'filesystem',
          command: 'node',
          args: ['-e', ''],
          env: {},
        },
      ],
    });
    const client = getClient('filesystem');
    expect(client).toBeTruthy();
    const payload = (await client?.callTool('filesystem.list', { path: base })) as unknown;
    expect(payload).toBeTruthy();
    expect(Array.isArray(payload)).toBe(true);
  });

  test('hot re-init replaces clients', async () => {
    initClients({
      servers: [{ transport: 'stdio', name: 'filesystem', command: 'node', args: ['-e', ''] }],
    });
    const c1 = getClient('filesystem');
    expect(c1).toBeTruthy();
    initClients({ servers: [{ transport: 'sse', name: 'web', url: 'http://localhost:7801/sse' }] });
    const c2 = getClient('filesystem');
    expect(c2).toBeUndefined();
  });
});
