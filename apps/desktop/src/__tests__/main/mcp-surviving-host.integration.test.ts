import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ObservedMcpHostRequest,
  startStatefulMcpHostServer,
} from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { describe, expect, test } from 'vitest';
import {
  createSecretsMcpBearerCredentialAuthority,
  mcpBearerCredentialStorageKey,
} from '../../mcp/bearer-credential';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import { runProductionMcpConformanceClient } from '../../mcp/official-conformance-client';

const stdioLifecycleServerEntrypoint = fileURLToPath(
  import.meta.resolve('@brainstrike/agent/test-fixtures/mcp-stdio-host-lifecycle-server.mjs')
);

interface StdioLifecycleFixture {
  readonly directory: string;
  readonly env: Readonly<Record<string, string>>;
  readonly pidFile: string;
  readonly stateFile: string;
}

async function createStdioLifecycleFixture(
  prefix: string,
  connectDelayMs?: number
): Promise<StdioLifecycleFixture> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const pidFile = path.join(directory, 'pid');
  const stateFile = path.join(directory, 'state.json');
  return {
    directory,
    env: {
      ...(connectDelayMs === undefined
        ? {}
        : { BRAINSTRIKE_STDIO_TEST_CONNECT_DELAY_MS: String(connectDelayMs) }),
      BRAINSTRIKE_STDIO_TEST_PID_FILE: pidFile,
      BRAINSTRIKE_STDIO_TEST_STATE_FILE: stateFile,
    },
    pidFile,
    stateFile,
  };
}

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
    throw new Error('Desktop stdio lifecycle fixture wrote an invalid pid');
  }
  return pid;
}

function requestMethod(body: unknown): string | undefined {
  if (!(typeof body === 'object' && body !== null && 'method' in body)) {
    return;
  }
  const method = body.method;
  return typeof method === 'string' ? method : undefined;
}

function observedProtocolMethods(requests: readonly ObservedMcpHostRequest[]): string[] {
  return requests.flatMap(({ body }) => {
    const entries = Array.isArray(body) ? body : [body];
    return entries.flatMap((entry) => {
      const method = requestMethod(entry);
      return method === undefined ? [] : [method];
    });
  });
}

describe('surviving Desktop MCP host integration', () => {
  test('observes methods inside JSON-RPC batch bodies', () => {
    expect(
      observedProtocolMethods([
        {
          body: [
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { id: 1, jsonrpc: '2.0', method: 'tools/call' },
          ],
          method: 'POST',
          pathname: '/mcp',
        },
      ])
    ).toEqual(['notifications/initialized', 'tools/call']);
  });

  test('returns a bounded client error for malformed fixture JSON', async () => {
    const server = await startStatefulMcpHostServer();
    try {
      const response = await fetch(server.url, {
        body: '{',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toBe('MCP fixture request failed');
    } finally {
      await server.close();
    }
  });

  test('desktop host owns and closes the official stdio client graph', async () => {
    const fixture = await createStdioLifecycleFixture('desktop-mcp-graph-');
    const configuredServerId = parseConfiguredMcpServerId('stdio.graph');
    const runtime = createDesktopMcpHostRuntime();
    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            args: [stdioLifecycleServerEntrypoint],
            command: process.execPath,
            env: fixture.env,
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'stdio',
          },
        ],
      });
      await expect(
        runtime.host.invoke({ configuredServerId, type: 'tools/list' })
      ).resolves.toMatchObject({
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({ name: 'host_lifecycle_probe' }),
          ]),
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
      await fsp.rm(fixture.directory, { force: true, recursive: true });
    }
  }, 30_000);

  test('desktop host reaps its real stdio child process on close', async () => {
    const fixture = await createStdioLifecycleFixture('desktop-mcp-reaping-');
    const configuredServerId = parseConfiguredMcpServerId('stdio.reaping');
    const runtime = createDesktopMcpHostRuntime();
    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            args: [stdioLifecycleServerEntrypoint],
            command: process.execPath,
            env: fixture.env,
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'stdio',
          },
        ],
      });
      await runtime.host.invoke({ configuredServerId, type: 'tools/list' });
      await expect
        .poll(() => fsp.readFile(fixture.pidFile, 'utf8'), { timeout: 5000 })
        .toMatch(/^[1-9]\d*$/u);
      const pid = parsePositivePid(await fsp.readFile(fixture.pidFile, 'utf8'));

      await expect(runtime.host.close()).resolves.toMatchObject({
        childProcessesClosed: 1,
        clientsClosed: 1,
        failures: [],
        requestsSettled: 1,
      });
      await expect.poll(() => processIsGone(pid), { timeout: 10_000 }).toBe(true);
      await expect(fsp.readFile(fixture.stateFile, 'utf8').then(JSON.parse)).resolves.toMatchObject(
        {
          listToolCalls: 2,
          starts: 1,
        }
      );
    } finally {
      await runtime.host.close();
      await fsp.rm(fixture.directory, { force: true, recursive: true });
    }
  }, 30_000);

  test('keeps startup responsive while user-paced stdio authorization exceeds ten seconds', async () => {
    const fixture = await createStdioLifecycleFixture('desktop-mcp-auth-startup-', 10_100);
    const configuredServerId = parseConfiguredMcpServerId('stdio.auth-wait');
    const runtime = createDesktopMcpHostRuntime();
    try {
      const startedAt = performance.now();
      await runtime.replaceResolvedConfig({
        servers: [
          {
            args: [stdioLifecycleServerEntrypoint],
            command: process.execPath,
            env: fixture.env,
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

      const connecting = runtime.host.control({ action: 'connect', configuredServerId });
      await expect.poll(() => runtime.host.snapshot().servers[0]?.state).toBe('authorizing');
      await expect(connecting).resolves.toMatchObject({ state: 'connected' });
      await expect(fsp.stat(fixture.pidFile)).resolves.toBeTruthy();
    } finally {
      await runtime.host.close();
      await fsp.rm(fixture.directory, { force: true, recursive: true });
    }
  }, 30_000);

  test('cancels user-paced authorization out of band and reaps the stdio child', async () => {
    const fixture = await createStdioLifecycleFixture('desktop-mcp-auth-cancel-', 10_000);
    const configuredServerId = parseConfiguredMcpServerId('stdio.auth-cancel');
    const runtime = createDesktopMcpHostRuntime();
    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            args: [stdioLifecycleServerEntrypoint],
            command: process.execPath,
            env: fixture.env,
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'authentication-required',
            transport: 'stdio',
          },
        ],
      });

      const connecting = runtime.host.control({ action: 'connect', configuredServerId });
      const connectRejected = expect(connecting).rejects.toBeDefined();
      await expect
        .poll(() => fsp.readFile(fixture.pidFile, 'utf8'), { timeout: 5000 })
        .toMatch(/^[1-9]\d*$/u);
      const pid = parsePositivePid(await fsp.readFile(fixture.pidFile, 'utf8'));

      await expect(
        runtime.host.control({ action: 'cancel', configuredServerId })
      ).resolves.toMatchObject({ state: 'authentication-required' });
      await connectRejected;
      await expect.poll(() => processIsGone(pid), { timeout: 10_000 }).toBe(true);
    } finally {
      await runtime.host.close();
      await fsp.rm(fixture.directory, { force: true, recursive: true });
    }
  }, 30_000);

  test('desktop host closes its real Streamable HTTP session after settled work', async () => {
    const server = await startStatefulMcpHostServer();
    const configuredServerId = parseConfiguredMcpServerId('linear.lifecycle');
    const runtime = createDesktopMcpHostRuntime();
    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'streamable-http',
            url: server.url,
          },
        ],
      });
      await runtime.host.invoke({ configuredServerId, type: 'tools/list' });

      await expect(runtime.host.close()).resolves.toMatchObject({
        childProcessesClosed: 0,
        clientsClosed: 1,
        failures: [],
        requestsSettled: 1,
      });
      expect(server.requests.at(-1)).toMatchObject({ method: 'DELETE', pathname: '/mcp' });
    } finally {
      await runtime.host.close();
      await server.close();
    }
  }, 30_000);

  test('resolves an opaque bearer reference only at the real transport boundary', async () => {
    const server = await startStatefulMcpHostServer();
    const configuredServerId = parseConfiguredMcpServerId('bearer.transport');
    const reference = {
      id: '00000000-0000-4000-8000-000000000001',
      store: 'mcp-credentials',
    } as const;
    const secret = 'real-transport-secret-sentinel';
    let storedCredential: string | null = secret;
    const authority = createSecretsMcpBearerCredentialAuthority({
      getKey: async () => storedCredential,
      listProviders: async () =>
        storedCredential === null ? [] : [mcpBearerCredentialStorageKey(reference)],
    });
    const runtime = createDesktopMcpHostRuntime({ bearerCredentialAuthority: authority });
    const config = {
      servers: [
        {
          auth: { credential: reference, type: 'bearer' as const },
          name: configuredServerId,
          protocol: 'auto' as const,
          startup: 'automatic' as const,
          transport: 'streamable-http' as const,
          url: server.url,
        },
      ],
    };

    try {
      const snapshot = await runtime.replaceResolvedConfig(config);
      expect(snapshot.servers[0]).toMatchObject({
        auth: { credentialState: 'stored', type: 'bearer' },
      });
      expect(JSON.stringify({ config, snapshot })).not.toContain(secret);

      await expect(
        runtime.host.invoke({
          arguments: {},
          configuredServerId,
          toolName: 'host_lifecycle_probe',
          type: 'tools/call',
        })
      ).resolves.toMatchObject({
        result: { content: [{ text: 'ok', type: 'text' }] },
        type: 'tools/call',
      });
      expect(server.requests.length).toBeGreaterThan(0);
      expect(
        server.requests.every(({ authorization }) => authorization === `Bearer ${secret}`)
      ).toBe(true);

      const requestCountBeforeReset = server.requests.length;
      storedCredential = null;
      const failure = runtime.host.invoke({
        arguments: {},
        configuredServerId,
        toolName: 'host_lifecycle_probe',
        type: 'tools/call',
      });
      await expect(failure).rejects.toMatchObject({
        category: 'authentication',
        code: 'mcp-bearer-credential-missing',
      });
      expect(server.requests).toHaveLength(requestCountBeforeReset);
      expect(String(await failure.catch((error: unknown) => error))).not.toContain(secret);
      expect(runtime.host.snapshot().servers[0]).toMatchObject({
        auth: { credentialState: 'missing', type: 'bearer' },
      });
    } finally {
      await runtime.host.close();
      await server.close();
    }
  }, 30_000);

  test('fails an initial real transport connection with the fixed missing-credential code', async () => {
    const server = await startStatefulMcpHostServer();
    const configuredServerId = parseConfiguredMcpServerId('bearer.missing');
    const authority = createSecretsMcpBearerCredentialAuthority({
      getKey: async () => null,
      listProviders: async () => [],
    });
    const runtime = createDesktopMcpHostRuntime({ bearerCredentialAuthority: authority });

    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            auth: {
              credential: {
                id: '00000000-0000-4000-8000-000000000001',
                store: 'mcp-credentials',
              },
              type: 'bearer',
            },
            name: configuredServerId,
            protocol: 'auto',
            startup: 'automatic',
            transport: 'streamable-http',
            url: server.url,
          },
        ],
      });

      await expect(
        runtime.host.invoke({ configuredServerId, type: 'tools/list' })
      ).rejects.toMatchObject({
        category: 'authentication',
        code: 'mcp-bearer-credential-missing',
      });
      expect(server.requests).toEqual([]);
    } finally {
      await runtime.host.close();
      await server.close();
    }
  }, 30_000);

  test('drives official initialize through the production host without calling a tool', async () => {
    const server = await startStatefulMcpHostServer();
    try {
      await runProductionMcpConformanceClient({
        protocolVersion: '2025-11-25',
        scenario: 'initialize',
        serverUrl: server.url,
      });

      const methods = observedProtocolMethods(server.requests);
      expect(methods).toEqual(
        expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list'])
      );
      expect(methods).not.toContain('tools/call');
    } finally {
      await server.close();
    }
  }, 30_000);

  test('rejects unknown auth scenarios instead of substituting core behavior', async () => {
    await expect(
      runProductionMcpConformanceClient({
        protocolVersion: '2026-07-28',
        scenario: 'auth/not-canonical',
        serverUrl: 'https://mcp.example.test/mcp',
      })
    ).rejects.toThrow(/scenario/u);
  });

  test('rejects initialize outside its canonical legacy applicability window', async () => {
    await expect(
      runProductionMcpConformanceClient({
        protocolVersion: '2026-07-28',
        scenario: 'initialize',
        serverUrl: 'https://mcp.example.test/mcp',
      })
    ).rejects.toThrow(/protocolVersion/u);
  });

  test('rejects credential-bearing conformance URLs through the production config parser', async () => {
    await expect(
      runProductionMcpConformanceClient({
        protocolVersion: '2026-07-28',
        scenario: 'tools_call',
        serverUrl: 'https://user:secret@mcp.example.test/mcp',
      })
    ).rejects.toThrow(/must not include credentials/u);
  });
});
