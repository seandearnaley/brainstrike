import type {
  McpHostOperation,
  McpHostOperationResult,
  McpHostPort,
  McpHostServerSnapshot,
  McpHostSnapshot,
  McpHostWatchEvent,
  McpHostWatchFilter,
} from '@brainstrike/assistant-contract';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  createMcpContentApplicationPort,
  MCP_CONTENT_APPLICATION_MAX_REQUEST_BYTES,
  MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES,
  McpContentApplicationError,
  type McpContentApplicationErrorCategory,
  type McpContentApplicationErrorCode,
  type McpContentApplicationRequest,
} from '../mcp-content-application-port.js';

const SERVER_ID = parseConfiguredMcpServerId('linear');
const ISSUE_URI = 'linear://issue/BST-1578';
const AUTHORITY = { configuredServerId: SERVER_ID, generation: 7 } as const;
const CIRCULAR: Record<string, unknown> = {};
CIRCULAR['self'] = CIRCULAR;
const LOSSY_JSON_VALUES = [
  undefined,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  new Date('2026-09-01T00:00:00Z'),
  new (class NonJsonValue {})(),
  (): void => undefined,
  Symbol('not-json'),
  1n,
  CIRCULAR,
  new Map(),
] as const;
const HUGE = '😀'.repeat(65_536);
const ANNOTATIONS = {
  audience: ['user'],
  lastModified: '2026-09-01T00:00:00Z',
  priority: 0.8,
} as const;
const FEATURES = {
  completion: true,
  promptListChanged: false,
  prompts: true,
  resourceListChanged: false,
  resourceSubscriptions: false,
  resources: true,
  toolListChanged: false,
  tools: true,
} as const;
const RICH_RESOURCE_RESULT = {
  cacheScope: 'private',
  contents: [
    { mimeType: 'text/markdown', text: '# BST-1578', uri: ISSUE_URI },
    { blob: 'AAEC', mimeType: 'application/octet-stream', uri: `${ISSUE_URI}/attachment` },
  ],
  ttlMs: 1000,
} as const satisfies Extract<McpHostOperationResult, { type: 'resources/read' }>['result'];
type PromptResult = Extract<McpHostOperationResult, { type: 'prompts/get' }>['result'];
type PromptMessage = PromptResult['messages'][number];
function promptMessage(
  content: PromptMessage['content'],
  role: PromptMessage['role'] = 'assistant'
): PromptMessage {
  return { content, role };
}
const RICH_PROMPT_RESULT = {
  cacheScope: 'private',
  description: 'A mixed-content prompt',
  messages: [
    promptMessage({ annotations: ANNOTATIONS, text: 'Summarize it', type: 'text' }, 'user'),
    promptMessage({ data: 'aW1hZ2U=', mimeType: 'image/png', type: 'image' }),
    promptMessage({ data: 'YXVkaW8=', mimeType: 'audio/wav', type: 'audio' }),
    promptMessage({
      resource: { mimeType: 'text/markdown', text: '# BST-1578', uri: ISSUE_URI },
      type: 'resource',
    }),
  ],
  ttlMs: 2000,
} as const satisfies PromptResult;
function server(generation: number): McpHostServerSnapshot {
  return {
    catalog: {
      errors: {},
      features: FEATURES,
      subscription: { mode: 'none', state: 'unsupported' },
    },
    configuredProtocol: '2026-07-28',
    configuredServerId: SERVER_ID,
    generation,
    negotiated: { era: 'modern', revision: '2026-07-28' },
    state: 'connected',
    transport: 'streamable-http',
  };
}
class FakeContentHost {
  private readonly listeners = new Set<(event: McpHostWatchEvent) => void>();
  private state: McpHostSnapshot = { revision: 1, servers: [server(7)] };
  readonly invoke = vi.fn<McpHostPort['invoke']>(
    async (operation): Promise<McpHostOperationResult> => resultFor(operation)
  );
  onSnapshot: (() => void) | undefined;
  onWatchRegistered: (() => void) | undefined;
  snapshot(): McpHostSnapshot {
    this.onSnapshot?.();
    return structuredClone(this.state);
  }
  watch(filter: McpHostWatchFilter, listener: (event: McpHostWatchEvent) => void): () => void {
    expect(filter).toEqual({ configuredServerIds: [SERVER_ID] });
    this.listeners.add(listener);
    this.onWatchRegistered?.();
    return () => {
      this.listeners.delete(listener);
    };
  }
  replaceGeneration(generation: number): void {
    this.state = { revision: this.state.revision + 1, servers: [server(generation)] };
    const event = structuredClone(this.state);
    for (const listener of this.listeners) {
      listener(event);
    }
  }
  replaceGenerationSilently(generation: number): void {
    this.state = { revision: this.state.revision + 1, servers: [server(generation)] };
  }
  setServer(snapshot: McpHostServerSnapshot): void {
    this.state = { revision: this.state.revision + 1, servers: [snapshot] };
  }
  removeServer(): void {
    this.state = { revision: this.state.revision + 1, servers: [] };
    const event = structuredClone(this.state);
    for (const listener of this.listeners) {
      listener(event);
    }
  }
  listenerCount(): number {
    return this.listeners.size;
  }
}
class PendingAbortContentHost extends FakeContentHost {
  private invocationSignal: AbortSignal | undefined;
  constructor() {
    super();
    this.invoke.mockImplementation(async (_operation, options) => {
      this.invocationSignal = options?.signal;
      if (this.invocationSignal === undefined) {
        throw new Error('Expected MCP content invocation signal');
      }
      await new Promise<void>((resolve) =>
        this.invocationSignal?.addEventListener('abort', () => resolve(), { once: true })
      );
      throw this.invocationSignal.reason;
    });
  }
  async waitForInvocation(): Promise<AbortSignal> {
    await vi.waitFor(() => expect(this.invocationSignal).toBeDefined());
    if (this.invocationSignal === undefined) {
      throw new Error('Expected pending MCP content invocation');
    }
    return this.invocationSignal;
  }
}
function connectedServerWithFeature(
  feature: 'completion' | 'prompts' | 'resources',
  supported: boolean
): McpHostServerSnapshot {
  const snapshot = server(7);
  if (snapshot.state !== 'connected' || snapshot.catalog === undefined) {
    throw new Error('Expected connected MCP content test authority');
  }
  const features = { ...snapshot.catalog.features, [feature]: supported };
  return { ...snapshot, catalog: { ...snapshot.catalog, features } };
}
function unavailableServer(state: 'connecting' | 'disconnected' | 'error'): McpHostServerSnapshot {
  const base = {
    configuredProtocol: '2026-07-28' as const,
    configuredServerId: SERVER_ID,
    generation: 7,
    transport: 'streamable-http' as const,
  };
  return state === 'error'
    ? { ...base, error: { category: 'connection', code: 'offline', message: 'Offline' }, state }
    : { ...base, state };
}
function resultFor(operation: McpHostOperation): McpHostOperationResult {
  switch (operation.type) {
    case 'resources/read':
      return {
        result: structuredClone(RICH_RESOURCE_RESULT),
        type: operation.type,
      };
    case 'prompts/get':
      return {
        result: structuredClone(RICH_PROMPT_RESULT),
        type: operation.type,
      };
    case 'completion/complete':
      return {
        result: { completion: { hasMore: false, total: 1, values: ['BST-1578'] } },
        type: operation.type,
      };
    default:
      throw new Error(`Unexpected operation: ${operation.type}`);
  }
}
const requests = [
  {
    _meta: { trace: 'resource-read' },
    authority: AUTHORITY,
    type: 'resources/read',
    uri: ISSUE_URI,
  },
  {
    _meta: { trace: 'prompt-get' },
    arguments: { identifier: 'BST-1578' },
    authority: AUTHORITY,
    name: 'summarize',
    type: 'prompts/get',
  },
  {
    _meta: { trace: 'completion' },
    argument: { name: 'identifier', value: 'BST' },
    authority: AUTHORITY,
    context: { arguments: { project: 'Brainstrike' } },
    ref: { name: 'summarize', type: 'ref/prompt' },
    type: 'completion/complete',
  },
] as const satisfies readonly McpContentApplicationRequest[];
function requestWithSerializedBytes(
  byteLength: number,
  includeMultibyte: boolean
): McpContentApplicationRequest {
  const base = {
    _meta: { padding: '' },
    authority: AUTHORITY,
    type: 'resources/read' as const,
    uri: ISSUE_URI,
  };
  const baseBytes = new TextEncoder().encode(JSON.stringify(base)).byteLength;
  const remaining = byteLength - baseBytes;
  if (remaining < 0) {
    throw new Error('Requested MCP content test payload is smaller than its fixed fields');
  }
  const emojiCount = includeMultibyte ? Math.floor(remaining / 4) : 0;
  const padding = `${'😀'.repeat(emojiCount)}${'a'.repeat(remaining - emojiCount * 4)}`;
  return { ...base, _meta: { padding } };
}
async function expectContentError(
  work: Promise<unknown>,
  category: McpContentApplicationErrorCategory,
  code: McpContentApplicationErrorCode
): Promise<void> {
  await expect(work).rejects.toMatchObject({ category, code });
}
describe('MCP content application port (BST-1578)', () => {
  it.each([false, true])(
    'accepts a request at the exact UTF-8 byte limit %#',
    async (multibyte) => {
      const host = new FakeContentHost();
      const request = requestWithSerializedBytes(
        MCP_CONTENT_APPLICATION_MAX_REQUEST_BYTES,
        multibyte
      );
      expect(new TextEncoder().encode(JSON.stringify(request))).toHaveLength(
        MCP_CONTENT_APPLICATION_MAX_REQUEST_BYTES
      );
      await expect(createMcpContentApplicationPort(host).execute(request)).resolves.toMatchObject({
        type: 'resources/read',
      });
      expect(host.invoke).toHaveBeenCalledOnce();
    }
  );
  it('rejects a multibyte request one serialized UTF-8 byte over the limit', async () => {
    const host = new FakeContentHost();
    const request = requestWithSerializedBytes(MCP_CONTENT_APPLICATION_MAX_REQUEST_BYTES + 1, true);
    await expectContentError(
      createMcpContentApplicationPort(host).execute(request),
      'request-too-large',
      'mcp_content_request_too_large'
    );
    expect(host.invoke).not.toHaveBeenCalled();
  });
  it.each([
    {
      fields: 'resource _meta and URI',
      request: { ...requests[0], _meta: { huge: HUGE }, uri: HUGE },
    },
    {
      fields: 'prompt _meta, name, and arguments',
      request: {
        ...requests[1],
        _meta: { huge: HUGE },
        arguments: { huge: HUGE },
        name: HUGE,
      },
    },
    {
      fields: 'completion _meta, argument, context, and ref',
      request: {
        ...requests[2],
        _meta: { huge: HUGE },
        argument: { name: 'huge', value: HUGE },
        context: { arguments: { huge: HUGE } },
        ref: { name: HUGE, type: 'ref/prompt' },
      },
    },
  ] satisfies readonly { fields: string; request: McpContentApplicationRequest }[])(
    'counts $fields in the request limit',
    async ({ request }) => {
      const host = new FakeContentHost();
      await expectContentError(
        createMcpContentApplicationPort(host).execute(request),
        'request-too-large',
        'mcp_content_request_too_large'
      );
      expect(host.invoke).not.toHaveBeenCalled();
    }
  );
  it.each([
    null,
    undefined,
    {},
    { authority: null, type: 'resources/read', uri: ISSUE_URI },
    { ...requests[1], arguments: { identifier: 1578 } },
    ...LOSSY_JSON_VALUES.map((invalid) => ({ ...requests[0], _meta: { invalid } })),
  ])('maps malformed runtime request %# to the stable invalid-request error', async (request) => {
    const port = createMcpContentApplicationPort(new FakeContentHost());
    await expectContentError(
      port.execute(request as McpContentApplicationRequest),
      'configuration',
      'mcp_content_request_invalid'
    );
  });
  it.each(requests)(
    'routes only the closed $type operation through the existing host',
    async (request) => {
      const host = new FakeContentHost();
      const port = createMcpContentApplicationPort(host);
      const response = await port.execute(request);
      expect(response.type).toBe(request.type);
      expect(structuredClone(request)).toEqual(request);
      expect(structuredClone(response)).toEqual(response);
      expect(host.invoke).toHaveBeenCalledOnce();
      const { authority, ...operation } = request;
      expect(host.invoke.mock.calls[0]?.[0]).toEqual({
        ...operation,
        configuredServerId: authority.configuredServerId,
      });
      expect(host.listenerCount()).toBe(0);
    }
  );
  it('preserves exact resource and prompt MIME, media, annotations, and cache metadata', async () => {
    const port = createMcpContentApplicationPort(new FakeContentHost());
    await expect(port.execute(requests[0])).resolves.toEqual({
      result: RICH_RESOURCE_RESULT,
      type: 'resources/read',
    });
    await expect(port.execute(requests[1])).resolves.toEqual({
      result: RICH_PROMPT_RESULT,
      type: 'prompts/get',
    });
  });
  it('rejects stale and unknown authority before invoking the host', async () => {
    const host = new FakeContentHost();
    const port = createMcpContentApplicationPort(host);
    await expectContentError(
      port.execute({
        authority: { configuredServerId: SERVER_ID, generation: 6 },
        type: 'resources/read',
        uri: ISSUE_URI,
      }),
      'generation-retired',
      'mcp_content_generation_retired'
    );
    host.removeServer();
    await expectContentError(
      port.execute(requests[0]),
      'configuration',
      'mcp_content_server_unknown'
    );
    expect(host.invoke).not.toHaveBeenCalled();
  });
  it.each([
    {
      request: requests[0],
      snapshot: connectedServerWithFeature('resources', false),
      state: 'resources unsupported',
    },
    {
      request: requests[1],
      snapshot: connectedServerWithFeature('prompts', false),
      state: 'prompts unsupported',
    },
    {
      request: requests[2],
      snapshot: connectedServerWithFeature('completion', false),
      state: 'completion unsupported',
    },
    {
      request: requests[0],
      snapshot: { ...server(7), catalog: undefined },
      state: 'catalog missing',
    },
  ])('rejects $state authority before invocation', async ({ request, snapshot }) => {
    const host = new FakeContentHost();
    host.setServer(snapshot);
    await expectContentError(
      createMcpContentApplicationPort(host).execute(request),
      'unsupported',
      'mcp_content_operation_unsupported'
    );
    expect(host.invoke).not.toHaveBeenCalled();
  });
  it.each(['disconnected', 'connecting', 'error'] as const)(
    'rejects $state authority before invocation',
    async (state) => {
      const host = new FakeContentHost();
      host.setServer(unavailableServer(state));
      await expectContentError(
        createMcpContentApplicationPort(host).execute(requests[0]),
        'not-connected',
        'mcp_content_server_not_connected'
      );
      expect(host.invoke).not.toHaveBeenCalled();
    }
  );
  it('closes the snapshot-to-watch race before invoking', async () => {
    const host = new FakeContentHost();
    host.onWatchRegistered = () => host.replaceGeneration(8);
    await expectContentError(
      createMcpContentApplicationPort(host).execute(requests[0]),
      'generation-retired',
      'mcp_content_generation_retired'
    );
    expect(host.invoke).not.toHaveBeenCalled();
    expect(host.listenerCount()).toBe(0);
  });
  it('closes the caller-abort-to-listener race before invoking', async () => {
    const host = new FakeContentHost();
    const caller = new AbortController();
    host.onSnapshot = () => {
      host.onSnapshot = undefined;
      caller.abort();
    };
    await expectContentError(
      createMcpContentApplicationPort(host).execute(requests[0], { signal: caller.signal }),
      'cancelled',
      'mcp_content_cancelled'
    );
    expect(host.invoke).not.toHaveBeenCalled();
    expect(host.listenerCount()).toBe(0);
  });
  it('cancels in-flight host work and rejects a replacement race', async () => {
    const host = new PendingAbortContentHost();
    const pending = createMcpContentApplicationPort(host).execute(requests[0]);
    const invocationSignal = await host.waitForInvocation();
    host.replaceGeneration(8);
    await expectContentError(pending, 'generation-retired', 'mcp_content_generation_retired');
    expect(invocationSignal.aborted).toBe(true);
    expect(host.listenerCount()).toBe(0);
  });
  it('rejects a replacement observed after the host operation resolves', async () => {
    const host = new FakeContentHost();
    host.invoke.mockImplementationOnce(async (operation) => {
      host.replaceGenerationSilently(8);
      return resultFor(operation);
    });
    await expectContentError(
      createMcpContentApplicationPort(host).execute(requests[0]),
      'generation-retired',
      'mcp_content_generation_retired'
    );
    expect(host.listenerCount()).toBe(0);
  });
  it('keeps caller cancellation distinct and releases its watcher', async () => {
    const host = new PendingAbortContentHost();
    const caller = new AbortController();
    const pending = createMcpContentApplicationPort(host).execute(requests[0], {
      signal: caller.signal,
    });
    const invocationSignal = await host.waitForInvocation();
    caller.abort();
    await expectContentError(pending, 'cancelled', 'mcp_content_cancelled');
    expect(invocationSignal.aborted).toBe(true);
    expect(host.listenerCount()).toBe(0);
  });
  it('rejects malformed, mismatched, and oversized results with stable typed errors', async () => {
    const host = new FakeContentHost();
    const port = createMcpContentApplicationPort(host);
    host.invoke.mockResolvedValueOnce({ result: { messages: [] }, type: 'prompts/get' });
    await expectContentError(
      port.execute(requests[0]),
      'protocol',
      'mcp_content_result_type_mismatch'
    );
    const malformedResult: Extract<McpHostOperationResult, { type: 'resources/read' }> = {
      result: {
        _meta: { invalidOpenField: Number.NaN },
        contents: [{ text: 'invalid', uri: 'linear://issue/BST-1578' }],
      },
      type: 'resources/read',
    };
    host.invoke.mockResolvedValueOnce(malformedResult);
    await expectContentError(port.execute(requests[0]), 'protocol', 'mcp_content_result_invalid');
    host.invoke.mockResolvedValueOnce({
      result: {
        contents: [
          {
            text: '😀'.repeat(Math.ceil(MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES / 4)),
            uri: 'linear://issue/BST-1578',
          },
        ],
      },
      type: 'resources/read',
    });
    await expectContentError(
      port.execute(requests[0]),
      'result-too-large',
      'mcp_content_result_too_large'
    );
  });
  it('maps host failures without leaking untyped causes', async () => {
    const host = new FakeContentHost();
    host.invoke.mockRejectedValueOnce({
      category: 'authorization',
      code: 'mcp-authorization-denied',
      message: 'Authorization denied',
    });
    let thrown: unknown;
    try {
      await createMcpContentApplicationPort(host).execute(requests[0]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpContentApplicationError);
    expect(thrown).toMatchObject({
      category: 'host',
      code: 'mcp_content_host_operation_failed',
      hostError: {
        category: 'authorization',
        code: 'mcp-authorization-denied',
        message: 'Authorization denied',
      },
    });
    expect(thrown).not.toHaveProperty('cause');
  });
});
