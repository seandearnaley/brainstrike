import { type McpHostOperation, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcpIpc from '../../ipc-mcp';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import { loadMcpConfig } from '../../mcp-loader';

type RegisteredHandler = (...args: unknown[]) => unknown | Promise<unknown>;

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('../../mcp-loader', () => ({
  getDefaultMcpConfigTemplate: vi.fn(() => '{\n  "servers": []\n}'),
  getMcpConfigPath: vi.fn(),
  loadMcpConfig: vi.fn(),
  readMcpConfigText: vi.fn(),
  setCustomMcpConfigPath: vi.fn(),
  watchMcpConfig: vi.fn(async () => ({ close: vi.fn() })),
  writeMcpConfigText: vi.fn(),
}));

vi.mock('../../secrets', () => ({
  getSecretsService: vi.fn(() => ({
    deleteKey: vi.fn(),
    getKey: vi.fn(async () => 'test-api-key'),
    listProviders: vi.fn(async () => ['openai']),
    saveKey: vi.fn(),
  })),
}));

const SERVER_ID = parseConfiguredMcpServerId('team.linear.prod');
const RESOURCE_URI = 'linear://issue/BST-1585';
const CLEAN_CLOSE = {
  callbacksClosed: 0,
  childProcessesClosed: 0,
  clientsClosed: 1,
  failures: [],
  loopbackPortsClosed: 0,
  probesClosed: 0,
  requestsSettled: 0,
  subscriptionsClosed: 0,
} as const;
const CATALOG = {
  errors: {},
  features: {
    completion: true,
    promptListChanged: false,
    prompts: true,
    resourceListChanged: false,
    resourceSubscriptions: false,
    resources: true,
    toolListChanged: false,
    tools: true,
  },
  subscription: { mode: 'none', state: 'unsupported' },
} as const;
type Runtime = ReturnType<typeof createDesktopMcpHostRuntime>;
type Invoke = (operation: McpHostOperation) => unknown;

function defaultResult(operation: McpHostOperation): unknown {
  switch (operation.type) {
    case 'resources/read':
      return { contents: [{ text: '# BST-1585', uri: operation.uri }] };
    case 'prompts/get':
      return {
        description: 'Issue summary',
        messages: [
          {
            content: { text: `Summarize ${operation.arguments?.['identifier']}`, type: 'text' },
            role: 'user',
          },
        ],
      };
    case 'completion/complete':
      return { completion: { hasMore: false, total: 1, values: ['BST-1585'] } };
    default:
      throw new Error(`Unexpected MCP content operation: ${operation.type}`);
  }
}

function createRuntime(invoke: Invoke = defaultResult): {
  invocations: McpHostOperation[];
  runtime: Runtime;
} {
  const invocations: McpHostOperation[] = [];
  const runtime = createDesktopMcpHostRuntime({
    createActorClient: () => ({
      catalog: () => CATALOG,
      close: vi.fn(async () => CLEAN_CLOSE),
      invoke: vi.fn(async (operation) => {
        invocations.push(operation);
        return await invoke(operation);
      }),
      negotiated: { era: 'modern', revision: '2026-07-28' },
    }),
    onInternalError: vi.fn(),
  });
  return { invocations, runtime };
}

describe('mcp:content:* IPC handlers (BST-1585)', () => {
  let handlers: Map<string, RegisteredHandler>;
  let unregister: (() => void) | undefined;
  let runtime: Runtime | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, handler: RegisteredHandler) => {
      handlers.set(channel, handler);
    }) as typeof ipcMain.handle);
    vi.mocked(loadMcpConfig).mockResolvedValue({
      exists: false,
      path: '/tmp/mcp.config.json',
    } as never);
  });

  afterEach(async () => {
    if (runtime) {
      await mcpIpc.resumeMcpRuntimeAfterFactoryReset(runtime);
    }
    unregister?.();
    await runtime?.host.close();
    unregister = undefined;
    runtime = undefined;
  });

  async function connect(target: Runtime): Promise<{
    configuredServerId: string;
    generation: number;
  }> {
    runtime = target;
    unregister = mcpIpc.registerMcpIpcHandlers({ runtime: target });
    // Startup discovery holds the lifecycle barrier; `mcp:status:get` waits on it.
    await requireHandler('mcp:status:get')();
    await target.replaceResolvedConfig({
      servers: [
        {
          name: SERVER_ID,
          protocol: 'auto',
          startup: 'automatic',
          transport: 'streamable-http',
          url: 'https://linear.example/mcp',
        },
      ],
    });
    await target.host.control({ action: 'connect', configuredServerId: SERVER_ID });
    const server = target.host.snapshot().servers[0];
    if (server?.state !== 'connected') {
      throw new Error('Expected a connected MCP content authority');
    }
    return { configuredServerId: server.configuredServerId, generation: server.generation };
  }

  function requireHandler(channel: string): RegisteredHandler {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`${channel} handler not registered`);
    }
    return handler;
  }

  it('executes each verb through the content port with the type forced per channel', async () => {
    const { invocations, runtime: target } = createRuntime();
    const authority = await connect(target);

    await expect(
      requireHandler('mcp:content:readResource')(undefined, { authority, uri: RESOURCE_URI })
    ).resolves.toEqual({
      result: { contents: [{ text: '# BST-1585', uri: RESOURCE_URI }] },
      type: 'resources/read',
    });
    await expect(
      requireHandler('mcp:content:getPrompt')(undefined, {
        arguments: { identifier: 'BST-1585' },
        authority,
        name: 'issue-summary',
      })
    ).resolves.toMatchObject({
      result: { messages: [{ content: { text: 'Summarize BST-1585', type: 'text' } }] },
      type: 'prompts/get',
    });
    await expect(
      requireHandler('mcp:content:complete')(undefined, {
        argument: { name: 'identifier', value: 'BST' },
        authority,
        context: { arguments: { team: 'BST' } },
        ref: { name: 'issue-summary', type: 'ref/prompt' },
      })
    ).resolves.toEqual({
      result: { completion: { hasMore: false, total: 1, values: ['BST-1585'] } },
      type: 'completion/complete',
    });
    expect(invocations.map((operation) => operation.type)).toEqual([
      'resources/read',
      'prompts/get',
      'completion/complete',
    ]);
    expect(invocations[2]).toMatchObject({
      configuredServerId: SERVER_ID,
      context: { arguments: { team: 'BST' } },
      ref: { name: 'issue-summary', type: 'ref/prompt' },
    });
  });

  it('rejects payloads that try to choose the verb or that do not fit the channel', async () => {
    const { invocations, runtime: target } = createRuntime();
    const authority = await connect(target);

    await expect(
      requireHandler('mcp:content:readResource')(undefined, {
        authority,
        type: 'tools/call',
        uri: RESOURCE_URI,
      })
    ).rejects.toMatchObject({ category: 'configuration', code: 'mcp_content_request_invalid' });
    await expect(
      requireHandler('mcp:content:readResource')(undefined, { authority, name: 'issue-summary' })
    ).rejects.toMatchObject({ code: 'mcp_content_request_invalid' });
    await expect(
      requireHandler('mcp:content:getPrompt')(undefined, {
        authority: { ...authority, configuredServerId: 'team.other.server' },
        name: 'issue-summary',
      })
    ).rejects.toMatchObject({ category: 'configuration', code: 'mcp_content_server_unknown' });
    expect(invocations).toEqual([]);
  });

  it('maps port failures to the fixed public taxonomy without forwarding causes', async () => {
    const { runtime: target } = createRuntime(async () => {
      throw new Error('bearer token sk-secret leaked by transport');
    });
    const authority = await connect(target);

    const rejection = await Promise.resolve(
      requireHandler('mcp:content:readResource')(undefined, { authority, uri: RESOURCE_URI })
    ).then(
      () => {
        throw new Error('Expected the content request to reject');
      },
      (error: unknown) => error
    );
    if (!(rejection instanceof Error)) {
      throw new Error('Expected an Error rejection');
    }
    // The actor retires the errored transport, so the port's authority watch
    // wins the race; only the fixed public taxonomy crosses IPC either way.
    expect(rejection).toMatchObject({
      category: 'not-connected',
      code: 'mcp_content_server_not_connected',
      message:
        'MCP content server not connected (not-connected · mcp_content_server_not_connected)',
    });
    expect(rejection).not.toHaveProperty('cause');
    expect(rejection).not.toHaveProperty('hostError');
    expect(JSON.stringify(rejection, Object.getOwnPropertyNames(rejection))).not.toContain(
      'sk-secret'
    );
    await expect(
      requireHandler('mcp:content:readResource')(undefined, {
        authority: { ...authority, generation: authority.generation + 1 },
        uri: RESOURCE_URI,
      })
    ).rejects.toMatchObject({
      category: 'generation-retired',
      code: 'mcp_content_generation_retired',
    });
  });

  it('rejects while the MCP lifecycle is closed for factory reset', async () => {
    const { invocations, runtime: target } = createRuntime();
    const authority = await connect(target);

    await mcpIpc.resetMcpRuntimeForFactoryReset(target);
    await expect(
      requireHandler('mcp:content:readResource')(undefined, { authority, uri: RESOURCE_URI })
    ).rejects.toThrow('MCP lifecycle is closed for cleanup');
    expect(invocations).toEqual([]);
  });
});
