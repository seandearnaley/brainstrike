import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

  test('filesystem.search finds files by substring', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-'));
    try {
      await fsp.mkdir(path.join(tmp, 'docs'));
      await fsp.writeFile(path.join(tmp, 'foo.txt'), 'hello');
      await fsp.writeFile(path.join(tmp, 'docs', 'bar.md'), '# bar');
      await fsp.writeFile(path.join(tmp, 'docs', 'readme.md'), '# readme');

      initClients({
        servers: [
          {
            transport: 'stdio',
            name: 'filesystem',
            command: 'node',
            args: ['-e', '', tmp],
            env: {},
          },
        ],
      });
      const client = getClient('filesystem');
      expect(client).toBeTruthy();
      const res = (await client?.callTool('filesystem.search', {
        query: 'md',
        path: tmp,
        maxResults: 10,
      })) as Array<{ name: string; type: string; path: string }>;
      expect(Array.isArray(res)).toBe(true);
      const names = res.map((r) => r.name);
      expect(names.some((n) => n.endsWith('.md'))).toBe(true);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
