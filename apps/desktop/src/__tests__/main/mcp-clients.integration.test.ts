import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, test } from 'vitest';
import { disposeClients, getClient, initClients } from '../../mcp';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';

const require = createRequire(import.meta.url);
const filesystemServerPackageJsonPath = require.resolve(
  '@modelcontextprotocol/server-filesystem/package.json'
);
const filesystemServerEntrypoint = path.join(
  path.dirname(filesystemServerPackageJsonPath),
  'dist/index.js'
);
const stdioLifecycleServerEntrypoint = path.resolve(
  import.meta.dirname,
  '../fixtures/mcp-stdio-lifecycle-server.mjs'
);

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return true;
    }
    if (code === 'EPERM') {
      return false;
    }
    throw error;
  }
}

function parsePositivePid(value: string): number {
  const pid = Number(value.trim());
  if (!(Number.isSafeInteger(pid) && pid > 0)) {
    throw new Error(
      `Desktop stdio lifecycle fixture wrote an invalid pid: ${JSON.stringify(value)}`
    );
  }
  return pid;
}

describe('mcp-clients', () => {
  afterEach(async () => {
    await disposeClients();
  });

  test('initializes a stdio MCP client and discovers server tools', async () => {
    initClients({
      servers: [
        {
          args: [filesystemServerEntrypoint, '/tmp'],
          command: process.execPath,
          env: {},
          name: 'filesystem',
          transport: 'stdio',
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

  test('desktop host owns and closes the official stdio client graph', async () => {
    const configuredServerId = parseConfiguredMcpServerId('filesystem.host');
    const runtime = createDesktopMcpHostRuntime();
    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            args: [filesystemServerEntrypoint, '/tmp'],
            command: process.execPath,
            env: {},
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'stdio',
          },
        ],
      });
      const listing = await runtime.host.invoke({ configuredServerId, type: 'tools/list' });
      expect(listing).toMatchObject({
        result: {
          tools: expect.arrayContaining([expect.objectContaining({ name: 'list_directory' })]),
        },
        type: 'tools/list',
      });
      await expect(runtime.host.close()).resolves.toMatchObject({
        callbacksClosed: 1,
        childProcessesClosed: 1,
        clientsClosed: 1,
        failures: [],
        requestsSettled: 1,
      });
    } finally {
      await runtime.host.close();
    }
  }, 30_000);

  test('desktop host reaps its real stdio child process on close', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'desktop-mcp-lifecycle-'));
    const pidFile = path.join(directory, 'pid');
    const stateFile = path.join(directory, 'state.json');
    const configuredServerId = parseConfiguredMcpServerId('stdio.lifecycle');
    const runtime = createDesktopMcpHostRuntime();
    let runtimeCloseAttempted = false;
    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            args: [stdioLifecycleServerEntrypoint],
            command: process.execPath,
            env: {
              BRAINSTRIKE_STDIO_TEST_PID_FILE: pidFile,
              BRAINSTRIKE_STDIO_TEST_STATE_FILE: stateFile,
            },
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'stdio',
          },
        ],
      });
      await runtime.host.invoke({ configuredServerId, type: 'tools/list' });
      const pid = parsePositivePid(await fsp.readFile(pidFile, 'utf8'));

      runtimeCloseAttempted = true;
      await expect(runtime.host.close()).resolves.toMatchObject({
        childProcessesClosed: 1,
        clientsClosed: 1,
        failures: [],
        requestsSettled: 1,
      });
      await expect.poll(() => processIsGone(pid), { timeout: 10_000 }).toBe(true);
      await expect(fsp.readFile(stateFile, 'utf8').then(JSON.parse)).resolves.toMatchObject({
        listToolCalls: 1,
        starts: 1,
      });
    } finally {
      if (!runtimeCloseAttempted) {
        await runtime.host.close();
      }
      await fsp.rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  test('keeps startup responsive while user-paced stdio authorization exceeds ten seconds', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'desktop-mcp-auth-startup-'));
    const pidFile = path.join(directory, 'pid');
    const stateFile = path.join(directory, 'state.json');
    const configuredServerId = parseConfiguredMcpServerId('stdio.auth-wait');
    const runtime = createDesktopMcpHostRuntime();
    try {
      const startedAt = performance.now();
      await runtime.replaceResolvedConfig({
        servers: [
          {
            args: [stdioLifecycleServerEntrypoint],
            command: process.execPath,
            env: {
              BRAINSTRIKE_STDIO_TEST_CONNECT_DELAY_MS: '10100',
              BRAINSTRIKE_STDIO_TEST_PID_FILE: pidFile,
              BRAINSTRIKE_STDIO_TEST_STATE_FILE: stateFile,
            },
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'authentication-required',
            transport: 'stdio',
          },
        ],
      });
      expect(performance.now() - startedAt).toBeLessThan(2000);
      expect(runtime.host.snapshot().servers[0]).toMatchObject({
        configuredServerId,
        state: 'authentication-required',
      });

      const connect = runtime.host.control({
        action: 'connect',
        configuredServerId,
      });
      await expect.poll(() => runtime.host.snapshot().servers[0]?.state).toBe('authorizing');
      const connected = await connect;
      expect(connected).toMatchObject({ state: 'connected' });
      await expect(fsp.stat(pidFile)).resolves.toBeTruthy();
    } finally {
      await runtime.host.close();
      await fsp.rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  test('cancels user-paced authorization out of band and reaps the stdio child', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'desktop-mcp-auth-cancel-'));
    const pidFile = path.join(directory, 'pid');
    const configuredServerId = parseConfiguredMcpServerId('stdio.auth-cancel');
    const runtime = createDesktopMcpHostRuntime();
    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            args: [stdioLifecycleServerEntrypoint],
            command: process.execPath,
            env: {
              BRAINSTRIKE_STDIO_TEST_CONNECT_DELAY_MS: '10000',
              BRAINSTRIKE_STDIO_TEST_PID_FILE: pidFile,
              BRAINSTRIKE_STDIO_TEST_STATE_FILE: path.join(directory, 'state.json'),
            },
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'authentication-required',
            transport: 'stdio',
          },
        ],
      });

      const connecting = runtime.host.control({ action: 'connect', configuredServerId });
      await expect
        .poll(() => fsp.readFile(pidFile, 'utf8'), { timeout: 5000 })
        .toMatch(/^[1-9]\d*$/u);
      const pid = parsePositivePid(await fsp.readFile(pidFile, 'utf8'));

      const cancelled = runtime.host.control({ action: 'cancel', configuredServerId });
      await expect(cancelled).resolves.toMatchObject({ state: 'authentication-required' });
      await expect(connecting).rejects.toBeDefined();
      await expect.poll(() => processIsGone(pid), { timeout: 10_000 }).toBe(true);
    } finally {
      await runtime.host.close();
      await fsp.rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  test('hot re-init replaces clients', async () => {
    initClients({
      servers: [{ args: ['-e', ''], command: 'node', name: 'filesystem', transport: 'stdio' }],
    });
    const c1 = getClient('filesystem');
    expect(c1).toBeTruthy();
    initClients({ servers: [{ name: 'web', transport: 'sse', url: 'http://localhost:7801/sse' }] });
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
            args: [filesystemServerEntrypoint, realTmp],
            command: process.execPath,
            env: {},
            name: 'filesystem',
            transport: 'stdio',
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
      await fsp.rm(tmp, { force: true, recursive: true });
    }
  }, 30_000);
});
