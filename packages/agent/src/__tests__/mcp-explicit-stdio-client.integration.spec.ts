import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SdkErrorCode } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpClientExtensionRegistry } from '../mcp/client-extension-registry';
import type { McpProtocol } from '../mcp/config';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';
import {
  createDeferredTestExtension,
  TEST_EXTENSION_ID,
  TEST_EXTENSION_SETTINGS,
} from './fixtures/mcp-client-extension-registry';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/mcp-stdio-lifecycle-server.mjs', import.meta.url)
);
const MODERN_CAPABILITIES_FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/mcp-modern-capabilities-stdio-server.mjs', import.meta.url)
);
const FIXTURE_TOOL_NAMES = ['inspect_env', 'exit_once', 'invalid_output'];

interface FixtureState {
  exitToolCalls: number;
  starts: number;
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  const tasks = cleanupTasks.splice(0).reverse();
  const errors: unknown[] = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Explicit stdio MCP test cleanup failed');
  }
});

async function createFixture(
  protocol: McpProtocol = 'legacy',
  extensionRegistry?: McpClientExtensionRegistry,
  fixturePath = FIXTURE_PATH
): Promise<{
  capabilitiesFile: string;
  client: ExplicitStdioMcpClient;
  stateFile: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'brainstrike-mcp-stdio-'));
  cleanupTasks.push(() => rm(directory, { force: true, recursive: true }));
  const capabilitiesFile = join(directory, 'capabilities.json');
  const stateFile = join(directory, 'state.json');
  const client = new ExplicitStdioMcpClient({
    args: [fixturePath],
    command: process.execPath,
    env: {
      BRAINSTRIKE_STDIO_TEST_CAPABILITIES_FILE: capabilitiesFile,
      BRAINSTRIKE_STDIO_TEST_OVERLAY: 'configured-overlay',
      BRAINSTRIKE_STDIO_TEST_STATE_FILE: stateFile,
    },
    name: 'stdio-lifecycle-canary',
    protocol,
    ...(extensionRegistry ? { extensionRegistry } : {}),
  });
  cleanupTasks.push(() => client.close());
  return { capabilitiesFile, client, stateFile };
}

async function readStateFile(stateFile: string): Promise<FixtureState> {
  return JSON.parse(await readFile(stateFile, 'utf8')) as FixtureState;
}

describe('ExplicitStdioMcpClient integration', () => {
  it('does not advertise an unimplemented client extension', async () => {
    const { capabilitiesFile, client } = await createFixture();

    await client.callTool({ arguments: {}, name: 'inspect_env' });

    await expect(readFile(capabilitiesFile, 'utf8').then(JSON.parse)).resolves.toEqual({});
  });

  it('advertises a registered complete extension over stdio', async () => {
    const extension = createDeferredTestExtension();
    const { capabilitiesFile, client } = await createFixture('legacy', extension.registry);
    extension.register();
    await client.callTool({ arguments: {}, name: 'inspect_env' });
    await expect(readFile(capabilitiesFile, 'utf8').then(JSON.parse)).resolves.toEqual({
      extensions: { [TEST_EXTENSION_ID]: TEST_EXTENSION_SETTINGS },
    });
  });

  it('projects registered extensions onto pinned-modern stdio requests', async () => {
    const extension = createDeferredTestExtension();
    const { capabilitiesFile, client } = await createFixture(
      '2026-07-28',
      extension.registry,
      MODERN_CAPABILITIES_FIXTURE_PATH
    );
    extension.register();
    await client.callTool({ arguments: {}, name: 'inspect_env' });
    await expect(readFile(capabilitiesFile, 'utf8').then(JSON.parse)).resolves.toEqual({
      extensions: { [TEST_EXTENSION_ID]: TEST_EXTENSION_SETTINGS },
    });
  });

  it('auto-probes with a disposable child and exposes the steady legacy metadata', async () => {
    const { client, stateFile } = await createFixture('auto');

    await client.connect();

    await expect(readStateFile(stateFile)).resolves.toEqual({
      exitToolCalls: 0,
      starts: 2,
    });
    expect(client.getProtocolEra()).toBe('legacy');
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(client.getServerVersion()).toEqual({
      name: 'brainstrike-stdio-lifecycle-fixture',
      version: '1.0.0',
    });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
  });

  it('pinned modern reaps its probe and never starts a legacy session child', async () => {
    const { client, stateFile } = await createFixture('2026-07-28');

    await expect(client.connect()).rejects.toMatchObject({
      code: SdkErrorCode.EraNegotiationFailed,
    });
    await expect(readStateFile(stateFile)).resolves.toEqual({
      exitToolCalls: 0,
      starts: 1,
    });
  });

  it('connects lazily once for concurrent requests and overlays configured environment', async () => {
    const { client, stateFile } = await createFixture();

    await expect(stat(stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const [, firstTools, secondTools] = await Promise.all([
      client.connect(),
      client.listTools(),
      client.listTools(),
    ]);
    const environment = await client.callTool({ arguments: {}, name: 'inspect_env' });

    expect(firstTools.tools.map((tool) => tool.name)).toEqual(FIXTURE_TOOL_NAMES);
    expect(secondTools.tools.map((tool) => tool.name)).toEqual(FIXTURE_TOOL_NAMES);
    expect(environment.structuredContent).toEqual({
      configuredValue: 'configured-overlay',
      inheritedPathPresent: true,
    });
    await expect(readStateFile(stateFile)).resolves.toEqual({
      exitToolCalls: 0,
      starts: 1,
    });
  });

  it('shares one terminal close operation and rejects later requests', async () => {
    const { client } = await createFixture();
    await client.connect();

    const firstClose = client.close();
    const secondClose = client.close();

    expect(secondClose).toBe(firstClose);
    await firstClose;
    await expect(client.listTools()).rejects.toThrow('Explicit stdio MCP client is closed');
  });

  it('does not replay a disconnected tool call and reconnects only for the next operation', async () => {
    const { client, stateFile } = await createFixture();
    await client.connect();

    await expect(client.callTool({ arguments: {}, name: 'exit_once' })).rejects.toThrow(
      /connection closed/i
    );
    await expect(readStateFile(stateFile)).resolves.toEqual({
      exitToolCalls: 1,
      starts: 1,
    });

    const reconnectedTools = await client.listTools();

    expect(reconnectedTools.tools.map((tool) => tool.name)).toEqual(FIXTURE_TOOL_NAMES);
    await expect(readStateFile(stateFile)).resolves.toEqual({
      exitToolCalls: 1,
      starts: 2,
    });
  });

  it('restores SDK tool metadata before the first call on a reconnected child', async () => {
    const { client, stateFile } = await createFixture();
    await client.listTools();
    await expect(client.callTool({ arguments: {}, name: 'exit_once' })).rejects.toThrow(
      /connection closed/i
    );

    await expect(client.callTool({ arguments: {}, name: 'invalid_output' })).rejects.toThrow(
      /structured content does not match/i
    );
    await expect(readStateFile(stateFile)).resolves.toEqual({
      exitToolCalls: 1,
      starts: 2,
    });
  });
});
