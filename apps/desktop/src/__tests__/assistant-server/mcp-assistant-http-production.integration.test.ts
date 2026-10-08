import type { RuntimeData } from '@brainstrike/agent';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { app } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleAssistantRequest } from '../../assistant-server';
import { createDesktopMcpHostRuntime, getDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import { createRunRequest, MockResponse } from './_harness';

type DesktopMcpHostRuntime = ReturnType<typeof createDesktopMcpHostRuntime>;

const runtimeSlot = vi.hoisted(() => ({ current: undefined as DesktopMcpHostRuntime | undefined }));
const mockSecretsService = vi.hoisted(() => ({
  getCredential: vi.fn(async () => ({ key: 'local-test-key', type: 'api_key' as const })),
  getKey: vi.fn(async () => 'local-test-key'),
  listProviders: vi.fn(async () => ['local']),
}));

vi.mock('../../mcp/host-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp/host-runtime')>();
  return {
    ...actual,
    getDesktopMcpHostRuntime: vi.fn(() => {
      if (!runtimeSlot.current) {
        throw new Error('BST-1543 desktop MCP runtime was not installed');
      }
      return runtimeSlot.current;
    }),
  };
});
vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => ({
    exec: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [] })),
  })),
}));
vi.mock('../../secrets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets')>()),
  getSecretsService: vi.fn(() => mockSecretsService),
}));
vi.mock('../../agent-client-loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-client-loader')>()),
  getAgentProviderEnvKeys: vi.fn(() => []),
}));
vi.mock(
  '../../../../../packages/host-capabilities/src/native-tools/workspace-text-file-reader',
  () => ({
    readWorkspaceTextFile: vi.fn(async () => ({ content: '', path: '', size: 0 })),
  })
);

const runRequest = createRunRequest(handleAssistantRequest);
const SERVER_ID = parseConfiguredMcpServerId('linear.production');
const TOOL_ID = 'issues.create';
const MODEL_TOOL_ID = 'linear_production_issues_create';
let runtime: ReturnType<typeof createDesktopMcpHostRuntime> | undefined;
const originalIsPackagedDescriptor = Object.getOwnPropertyDescriptor(app, 'isPackaged');

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: false });
});

afterEach(async () => {
  runtimeSlot.current = undefined;
  try {
    await runtime?.host.close();
  } finally {
    runtime = undefined;
    if (originalIsPackagedDescriptor) {
      Object.defineProperty(app, 'isPackaged', originalIsPackagedDescriptor);
    } else {
      Reflect.deleteProperty(app, 'isPackaged');
    }
    vi.restoreAllMocks();
  }
});

it('copies Uint8Array chunks and handles bare ArrayBuffer chunks as bytes', () => {
  const response = new MockResponse();
  const typedBytes = Uint8Array.from([65]);
  response.write(typedBytes);
  typedBytes[0] = 66;
  response.write(Uint8Array.from([67]).buffer);

  expect(Buffer.concat(response.bodyChunks).toString('utf8')).toBe('AC');
});

// BST-1930: legacy threads carry no MCP. Even with a connected server configured,
// the legacy HTTP turn offers no MCP tool and never touches the MCP runtime.
it('runs the legacy assistant HTTP turn without MCP tools', async () => {
  const llmHostManager = {
    generateForMain: vi.fn(async () => ({
      finishReason: 'stop' as const,
      text: 'BST-1930 legacy turn passed.',
      usage: { completionTokens: 4, promptTokens: 12, totalTokens: 16 },
    })),
    warmupForMain: vi.fn(async () => undefined),
  };
  const transport = {
    callTool: vi.fn(async () => ({
      content: [{ text: 'Linear issue created', type: 'text' as const }],
    })),
    close: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({ completion: { values: [] } })),
    connect: vi.fn(async () => undefined),
    getNegotiatedProtocolVersion: vi.fn(() => '2026-07-28'),
    getPrompt: vi.fn(async () => ({ messages: [] })),
    getProtocolEra: vi.fn(() => 'modern' as const),
    getServerCapabilities: vi.fn(() => ({ tools: {} })),
    getServerVersion: vi.fn(() => ({ name: 'linear-fixture', version: '1.0.0' })),
    listen: vi.fn(async () => ({
      close: vi.fn(async () => undefined),
      closed: Promise.resolve('local' as const),
      honoredFilter: {},
    })),
    listPrompts: vi.fn(async () => ({ prompts: [] })),
    listResources: vi.fn(async () => ({ cacheScope: 'private', resources: [], ttlMs: 1000 })),
    listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
    listTools: vi.fn(async () => ({
      tools: [
        {
          description: 'Create a Linear issue',
          inputSchema: {
            additionalProperties: false,
            properties: { title: { type: 'string' } },
            required: ['title'],
            type: 'object' as const,
          },
          name: TOOL_ID,
        },
      ],
    })),
    readResource: vi.fn(async () => ({ contents: [] })),
    subscribeResource: vi.fn(async () => undefined),
    unsubscribeResource: vi.fn(async () => undefined),
    watchServerFeatures: vi.fn(() => vi.fn()),
  };
  const createHttpTransportClient = vi.fn(() => transport);
  const createStdioTransportClient = vi.fn(() => transport);
  runtime = createDesktopMcpHostRuntime({
    createHttpTransportClient,
    createStdioTransportClient,
  });
  runtimeSlot.current = runtime;
  await runtime.replaceResolvedConfig({
    servers: [
      {
        enabledTools: [TOOL_ID],
        name: SERVER_ID,
        protocol: 'auto',
        startup: 'automatic',
        transport: 'streamable-http',
        url: 'https://linear.invalid/mcp',
      },
    ],
  });
  const invoke = vi.spyOn(runtime.host, 'invoke');
  const close = vi.spyOn(runtime.host, 'close');
  const runtimeData: RuntimeData = {
    enabledNativeToolIds: [],
    model: 'onnx-community/gemma-4-E2B-it-ONNX',
    permissionPolicyRequest: {
      enforce: true,
      policies: { edit: 'deny', execute: 'deny', mcp: 'allow', read: 'allow' },
    },
    provider: 'local',
  };

  const response = await runRequest(
    {
      body: JSON.stringify({
        data: runtimeData,
        messages: [
          {
            id: 'bst-1543-user',
            parts: [{ text: 'Create the issue', type: 'text' }],
            role: 'user',
          },
        ],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    },
    { llmHostManager }
  );

  expect(response.status).toBe(200);
  expect(response.body).toContain('BST-1930 legacy turn passed.');
  expect(llmHostManager.generateForMain).toHaveBeenCalled();
  expect(JSON.stringify(llmHostManager.generateForMain.mock.calls)).not.toContain(MODEL_TOOL_ID);
  expect(getDesktopMcpHostRuntime).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  expect(transport.callTool).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
}, 30_000);
