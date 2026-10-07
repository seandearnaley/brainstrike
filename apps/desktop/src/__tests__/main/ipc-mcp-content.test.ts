import { type McpHostOperation, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { McpContentApplicationError } from '@brainstrike/assistant-service/mcp-content-application-port';
import { ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcpIpc from '../../ipc-mcp';
import { toMcpContentIpcFailure } from '../../mcp/content-ipc';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import { loadMcpConfig } from '../../mcp-loader';
import { createAllowlistedSenderFrame } from '../helpers/desktop-ipc-sender-frame-test-allowlist';

type RegisteredHandler = (...args: unknown[]) => unknown | Promise<unknown>;

const { getWindowRoleByWebContentsIdMock } = vi.hoisted(() => ({
  getWindowRoleByWebContentsIdMock: vi.fn(),
}));

vi.mock('../../window-role', () => ({
  getWindowRoleByWebContentsId: getWindowRoleByWebContentsIdMock,
}));

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
// The registry resolves the sender role from `event.sender.id` before any
// payload is parsed; the mocked resolver answers `visible-ui` by default.
const VISIBLE_UI_EVENT = { sender: { id: 1 }, senderFrame: createAllowlistedSenderFrame() };
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
    getWindowRoleByWebContentsIdMock.mockReturnValue('visible-ui');
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
    await requireHandler('mcp:status:get')(VISIBLE_UI_EVENT);
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
      requireHandler('mcp:content:readResource')(VISIBLE_UI_EVENT, { authority, uri: RESOURCE_URI })
    ).resolves.toEqual({
      ok: true,
      result: {
        result: { contents: [{ text: '# BST-1585', uri: RESOURCE_URI }] },
        type: 'resources/read',
      },
    });
    await expect(
      requireHandler('mcp:content:getPrompt')(VISIBLE_UI_EVENT, {
        arguments: { identifier: 'BST-1585' },
        authority,
        name: 'issue-summary',
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        result: { messages: [{ content: { text: 'Summarize BST-1585', type: 'text' } }] },
        type: 'prompts/get',
      },
    });
    await expect(
      requireHandler('mcp:content:complete')(VISIBLE_UI_EVENT, {
        argument: { name: 'identifier', value: 'BST' },
        authority,
        context: { arguments: { team: 'BST' } },
        ref: { name: 'issue-summary', type: 'ref/prompt' },
      })
    ).resolves.toEqual({
      ok: true,
      result: {
        result: { completion: { hasMore: false, total: 1, values: ['BST-1585'] } },
        type: 'completion/complete',
      },
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
      requireHandler('mcp:content:readResource')(VISIBLE_UI_EVENT, {
        authority,
        type: 'tools/call',
        uri: RESOURCE_URI,
      })
    ).resolves.toMatchObject({
      error: { category: 'configuration', code: 'mcp_content_request_invalid' },
      ok: false,
    });
    await expect(
      requireHandler('mcp:content:readResource')(VISIBLE_UI_EVENT, {
        authority,
        name: 'issue-summary',
      })
    ).resolves.toMatchObject({ error: { code: 'mcp_content_request_invalid' }, ok: false });
    await expect(
      requireHandler('mcp:content:getPrompt')(VISIBLE_UI_EVENT, {
        authority: { ...authority, configuredServerId: 'team.other.server' },
        name: 'issue-summary',
      })
    ).resolves.toMatchObject({
      error: { category: 'configuration', code: 'mcp_content_server_unknown' },
      ok: false,
    });
    expect(invocations).toEqual([]);
  });

  it('maps port failures to the fixed public taxonomy without forwarding causes', async () => {
    const { runtime: target } = createRuntime(async () => {
      throw new Error('bearer token sk-secret leaked by transport');
    });
    const authority = await connect(target);

    const response = await requireHandler('mcp:content:readResource')(VISIBLE_UI_EVENT, {
      authority,
      uri: RESOURCE_URI,
    });
    // This request was accepted before the actor retired the errored transport.
    // Only the fixed retirement taxonomy crosses IPC, never the transport cause.
    expect(response).toEqual({
      error: {
        category: 'generation-retired',
        code: 'mcp_content_generation_retired',
        message: 'MCP content generation retired',
      },
      ok: false,
    });
    expect(JSON.stringify(response)).not.toContain('sk-secret');
    await expect(
      requireHandler('mcp:content:readResource')(VISIBLE_UI_EVENT, {
        authority: { ...authority, generation: authority.generation + 1 },
        uri: RESOURCE_URI,
      })
    ).resolves.toMatchObject({
      error: { category: 'generation-retired', code: 'mcp_content_generation_retired' },
      ok: false,
    });
  });

  it('never forwards server-originated host error text', () => {
    const failure = toMcpContentIpcFailure(
      new McpContentApplicationError('hostFailed', {
        category: 'transport',
        code: 'server_exploded',
        message: 'upstream said: bearer sk-secret is invalid',
      })
    );
    expect(failure).toEqual({
      category: 'host',
      code: 'mcp_content_host_operation_failed',
      message: expect.any(String),
    });
    expect(JSON.stringify(failure)).not.toContain('sk-secret');
    expect(JSON.stringify(failure)).not.toContain('server_exploded');
    expect(toMcpContentIpcFailure(new Error('raw cause with /abs/path'))).toEqual({
      category: 'host',
      code: 'mcp_content_request_failed',
      message: 'MCP content request failed',
    });
  });

  it('rejects while the MCP lifecycle is closed for factory reset', async () => {
    const { invocations, runtime: target } = createRuntime();
    const authority = await connect(target);

    await mcpIpc.resetMcpRuntimeForFactoryReset(target);
    await expect(
      requireHandler('mcp:content:readResource')(VISIBLE_UI_EVENT, { authority, uri: RESOURCE_URI })
    ).resolves.toEqual({
      error: {
        category: 'not-connected',
        code: 'mcp_content_lifecycle_closed',
        message: 'MCP lifecycle is closed for cleanup',
      },
      ok: false,
    });
    expect(invocations).toEqual([]);
  });

  it.each(['chunking-host', 'embedding-host', 'llm-host', undefined])(
    'rejects every content verb before dispatch for sender role %s',
    async (role) => {
      const { invocations, runtime: target } = createRuntime();
      const authority = await connect(target);
      getWindowRoleByWebContentsIdMock.mockReturnValue(role);
      const event = { sender: { id: 7 }, senderFrame: createAllowlistedSenderFrame() };
      for (const [channel, request] of [
        ['mcp:content:readResource', { authority, uri: RESOURCE_URI }],
        ['mcp:content:getPrompt', { authority, name: 'issue-summary' }],
        [
          'mcp:content:complete',
          {
            argument: { name: 'identifier', value: 'BST' },
            authority,
            ref: { name: 'issue-summary', type: 'ref/prompt' },
          },
        ],
      ] as const) {
        await expect(requireHandler(channel)(event, request)).rejects.toThrow(
          /requires sender role visible-ui/u
        );
      }
      expect(invocations).toEqual([]);
    }
  );
});
