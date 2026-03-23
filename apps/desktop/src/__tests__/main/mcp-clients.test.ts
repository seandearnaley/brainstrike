import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { disposeClients, getClient, initClients } from '../../mcp';

const require = createRequire(import.meta.url);
const filesystemServerPackageJsonPath = require.resolve(
  '@modelcontextprotocol/server-filesystem/package.json'
);
const filesystemServerEntrypoint = path.join(
  path.dirname(filesystemServerPackageJsonPath),
  'dist/index.js'
);

describe('mcp-clients', () => {
  afterEach(async () => {
    await disposeClients();
  });

  test('initializes a stdio MCP client and discovers server tools', async () => {
    initClients({
      servers: [
        {
          transport: 'stdio',
          name: 'filesystem',
          command: process.execPath,
          args: [filesystemServerEntrypoint, '/tmp'],
          env: {},
        },
      ],
    });
    const client = getClient('filesystem');
    expect(client).toBeTruthy();
    const tools = await client?.listTools();
    expect(tools).toBeTruthy();
    expect(tools).toHaveProperty('filesystem.list_directory');
    expect(tools).toHaveProperty('filesystem.read_file');
  }, 30_000);

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

  test('stdio MCP client can execute filesystem server tools', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-'));
    try {
      const realTmp = await fsp.realpath(tmp);
      await fsp.mkdir(path.join(tmp, 'docs'));
      await fsp.writeFile(path.join(tmp, 'foo.txt'), 'hello');
      await fsp.writeFile(path.join(tmp, 'docs', 'bar.md'), '# bar');
      await fsp.writeFile(path.join(tmp, 'docs', 'readme.md'), '# readme');

      initClients({
        servers: [
          {
            transport: 'stdio',
            name: 'filesystem',
            command: process.execPath,
            args: [filesystemServerEntrypoint, realTmp],
            env: {},
          },
        ],
      });
      const client = getClient('filesystem');
      expect(client).toBeTruthy();
      const res = (await client?.callTool('filesystem.list_directory', {
        path: realTmp,
      })) as { content?: Array<{ text?: string; type: string }>; isError?: boolean };
      expect(res?.isError).not.toBe(true);
      expect(res?.content?.[0]?.text).toContain('foo.txt');
      expect(res?.content?.[0]?.text).toContain('docs');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
