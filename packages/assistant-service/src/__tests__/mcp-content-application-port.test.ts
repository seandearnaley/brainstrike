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
  type McpContentApplicationRequest,
} from '../mcp-content-application-port.js';

const SERVER_ID = parseConfiguredMcpServerId('linear');
const ISSUE_URI = 'linear://issue/BST-1578';
const AUTHORITY = { configuredServerId: SERVER_ID, generation: 7 } as const;
const CIRCULAR: Record<string, unknown> = {};
CIRCULAR['self'] = CIRCULAR;
const LOSSY_JSON_VALUES = [
  ...[undefined, Number.NaN, Number.POSITIVE_INFINITY],
  new Date('2026-09-01T00:00:00Z'),
  ...[(): void => undefined, Symbol('not-json'), 1n],
  CIRCULAR,
  new Map(),
] as const;
const HUGE = '😀'.repeat(65_536);
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
const RICH_PROMPT_RESULT = {
  cacheScope: 'private',
  messages: [
    {
      content: {
        annotations: { audience: ['user'], lastModified: '2026-09-01T00:00:00Z', priority: 0.8 },
        text: 'Summarize it',
        type: 'text',
      },
      role: 'user',
    },
    { content: { data: 'aW1hZ2U=', mimeType: 'image/png', type: 'image' }, role: 'assistant' },
  ],
  ttlMs: 2000,
} as const satisfies Extract<McpHostOperationResult, { type: 'prompts/get' }>['result'];
function server(generation: number) {
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
  } as const;
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
  replaceGeneration(generation: number, publish = true): void {
    this.state = { revision: this.state.revision + 1, servers: [server(generation)] };
    if (!publish) {
      return;
    }
    const event = structuredClone(this.state);
    for (const listener of this.listeners) {
      listener(event);
    }
  }
  setServers(...servers: McpHostServerSnapshot[]): void {
    this.state = { revision: this.state.revision + 1, servers };
  }
  listenerCount(): number {
    return this.listeners.size;
  }
}
function pendingHost() {
  const host = new FakeContentHost();
  const invoked = Promise.withResolvers<AbortSignal>();
  host.invoke.mockImplementation(async (_operation, options) => {
    const signal = options?.signal;
    if (!signal) {
      throw new Error('Expected MCP content invocation signal');
    }
    invoked.resolve(signal);
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true })
    );
    throw signal.reason;
  });
  return { host, invoked: invoked.promise };
}
function portFor(
  host: Pick<McpHostPort, 'invoke' | 'snapshot' | 'watch'>,
  onInternalError = vi.fn()
) {
  return createMcpContentApplicationPort(host, { onInternalError });
}
function connectedServerWithFeature(
  feature: 'completion' | 'prompts' | 'resources',
  supported: boolean
): McpHostServerSnapshot {
  const snapshot = server(7);
  const features = { ...snapshot.catalog.features, [feature]: supported };
  return { ...snapshot, catalog: { ...snapshot.catalog, features } };
}
function resultFor(operation: McpHostOperation): McpHostOperationResult {
  switch (operation.type) {
    case 'resources/read':
      return { result: structuredClone(RICH_RESOURCE_RESULT), type: operation.type };
    case 'prompts/get':
      return { result: structuredClone(RICH_PROMPT_RESULT), type: operation.type };
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
function paddingForSerializedBytes(
  base: unknown,
  byteLength: number,
  includeMultibyte: boolean
): string {
  const remaining = byteLength - new TextEncoder().encode(JSON.stringify(base)).byteLength;
  const emojiCount = includeMultibyte ? Math.floor(remaining / 4) : 0;
  return `${'😀'.repeat(emojiCount)}${'a'.repeat(remaining - emojiCount * 4)}`;
}
function requestWithSerializedBytes(
  byteLength: number,
  includeMultibyte: boolean
): McpContentApplicationRequest {
  const base = { ...requests[0], _meta: { padding: '' } };
  return {
    ...base,
    _meta: { padding: paddingForSerializedBytes(base, byteLength, includeMultibyte) },
  };
}
function resultWithSerializedBytes(byteLength: number, includeMultibyte: boolean) {
  const base = {
    result: { contents: [{ text: '', uri: ISSUE_URI }] },
    type: 'resources/read' as const,
  };
  const text = paddingForSerializedBytes(base, byteLength, includeMultibyte);
  return { ...base, result: { contents: [{ text, uri: ISSUE_URI }] } };
}
async function expectContentError(
  work: Promise<unknown>,
  category: McpContentApplicationError['category'],
  code: McpContentApplicationError['code']
): Promise<void> {
  await expect(work).rejects.toMatchObject({ category, code });
}
async function expectPreflightRejection(
  request: unknown,
  category: McpContentApplicationError['category'],
  code: McpContentApplicationError['code'],
  host = new FakeContentHost()
): Promise<void> {
  await expectContentError(
    portFor(host).execute(request as McpContentApplicationRequest),
    category,
    code
  );
  expect(host.invoke).not.toHaveBeenCalled();
}
describe('MCP content application port (BST-1578)', () => {
  it.each([false, true])(
    'accepts requests and results at their exact UTF-8 byte limits %#',
    async (multibyte) => {
      const host = new FakeContentHost();
      const request = requestWithSerializedBytes(
        MCP_CONTENT_APPLICATION_MAX_REQUEST_BYTES,
        multibyte
      );
      expect(new TextEncoder().encode(JSON.stringify(request))).toHaveLength(
        MCP_CONTENT_APPLICATION_MAX_REQUEST_BYTES
      );
      await expect(portFor(host).execute(request)).resolves.toMatchObject({
        type: 'resources/read',
      });
      const result = resultWithSerializedBytes(MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES, multibyte);
      host.invoke.mockResolvedValueOnce(result);
      expect(new TextEncoder().encode(JSON.stringify(result))).toHaveLength(
        MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES
      );
      await expect(portFor(host).execute(requests[0])).resolves.toEqual(result);
    }
  );
  it('rejects requests and results one serialized UTF-8 byte over their limits', async () => {
    const request = requestWithSerializedBytes(MCP_CONTENT_APPLICATION_MAX_REQUEST_BYTES + 1, true);
    await expectPreflightRejection(request, 'request-too-large', 'mcp_content_request_too_large');
    const resultHost = new FakeContentHost();
    resultHost.invoke.mockResolvedValueOnce(
      resultWithSerializedBytes(MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES + 1, true)
    );
    await expectContentError(
      portFor(resultHost).execute(requests[0]),
      'result-too-large',
      'mcp_content_result_too_large'
    );
  });
  it('classifies JSON serialization RangeError as an oversized result', async () => {
    const host = new FakeContentHost();
    const rangeError = new RangeError('credential-bearing oversized detail');
    host.invoke.mockResolvedValueOnce({
      toJSON: () => {
        throw rangeError;
      },
    } as unknown as McpHostOperationResult);
    const execution = portFor(host).execute(requests[0]);
    await expectContentError(execution, 'result-too-large', 'mcp_content_result_too_large');
    await expect(execution).rejects.not.toHaveProperty('cause');
  });
  it.each([
    ['resource URI', { ...requests[0], uri: HUGE }],
    ['prompt arguments', { ...requests[1], arguments: { huge: HUGE } }],
    ['completion context', { ...requests[2], context: { arguments: { huge: HUGE } } }],
  ] satisfies readonly (readonly [string, McpContentApplicationRequest])[])(
    'counts %s in the request limit',
    async (_fields, request) => {
      await expectPreflightRejection(request, 'request-too-large', 'mcp_content_request_too_large');
    }
  );
  it.each([
    [
      'unknown authority member',
      { ...requests[0], authority: { ...AUTHORITY, serverId: 'other' } },
    ],
    [
      'well-formed tools/call',
      { arguments: {}, authority: AUTHORITY, name: 'x', type: 'tools/call' },
    ],
    ['caller configuredServerId', { ...requests[0], configuredServerId: SERVER_ID }],
    ...LOSSY_JSON_VALUES.map((invalid): readonly [string, unknown] => [
      `lossy ${typeof invalid}`,
      { ...requests[0], _meta: { invalid } },
    ]),
  ] satisfies readonly (readonly [string, unknown])[])(
    'rejects $0 with the exact closed-request error',
    async (_case, request) => {
      await expectPreflightRejection(request, 'configuration', 'mcp_content_request_invalid');
    }
  );
  it.each(requests)(
    'routes only the closed $type operation through the existing host',
    async (request) => {
      const host = new FakeContentHost();
      const port = portFor(host);
      const response = await port.execute(request);
      if (response.type === 'resources/read') {
        expect(response.result).toEqual(RICH_RESOURCE_RESULT);
      } else if (response.type === 'prompts/get') {
        expect(response.result).toEqual(RICH_PROMPT_RESULT);
      }
      expect(host.invoke).toHaveBeenCalledOnce();
      const { authority, ...operation } = request;
      expect(host.invoke.mock.calls[0]?.[0]).toEqual({
        ...operation,
        configuredServerId: authority.configuredServerId,
      });
      expect(host.listenerCount()).toBe(0);
    }
  );
  it('rejects stale and unknown authority before invoking the host', async () => {
    const host = new FakeContentHost();
    await expectPreflightRejection(
      { ...requests[0], authority: { ...AUTHORITY, generation: 6 } },
      'generation-retired',
      'mcp_content_generation_retired',
      host
    );
    host.setServers();
    await expectPreflightRejection(
      requests[0],
      'configuration',
      'mcp_content_server_unknown',
      host
    );
  });
  it('rejects unsupported, missing-catalog, and disconnected authority before invocation', async () => {
    for (const [request, feature] of [
      [requests[0], 'resources'],
      [requests[1], 'prompts'],
      [requests[2], 'completion'],
    ] as const) {
      const host = new FakeContentHost();
      host.setServers(connectedServerWithFeature(feature, false));
      await expectPreflightRejection(
        request,
        'unsupported',
        'mcp_content_operation_unsupported',
        host
      );
    }
    for (const snapshot of [
      { ...server(7), catalog: undefined },
      {
        configuredProtocol: '2026-07-28' as const,
        configuredServerId: SERVER_ID,
        generation: 7,
        state: 'disconnected' as const,
        transport: 'streamable-http' as const,
      },
    ]) {
      const host = new FakeContentHost();
      host.setServers(snapshot);
      const unavailable = snapshot.state === 'connected' ? 'unsupported' : 'not-connected';
      await expectPreflightRejection(
        requests[0],
        unavailable,
        unavailable === 'unsupported'
          ? 'mcp_content_operation_unsupported'
          : 'mcp_content_server_not_connected',
        host
      );
    }
  });
  it('closes generation and caller-abort races before invocation', async () => {
    const generationHost = new FakeContentHost();
    generationHost.onWatchRegistered = () => generationHost.replaceGeneration(8);
    await expectContentError(
      portFor(generationHost).execute(requests[0]),
      'generation-retired',
      'mcp_content_generation_retired'
    );
    expect(generationHost.invoke).not.toHaveBeenCalled();
    expect(generationHost.listenerCount()).toBe(0);
    const callerHost = new FakeContentHost();
    const caller = new AbortController();
    callerHost.onSnapshot = () => {
      callerHost.onSnapshot = undefined;
      caller.abort();
    };
    await expectContentError(
      portFor(callerHost).execute(requests[0], { signal: caller.signal }),
      'cancelled',
      'mcp_content_cancelled'
    );
    expect(callerHost.invoke).not.toHaveBeenCalled();
    expect(callerHost.listenerCount()).toBe(0);
  });
  it('cancels in-flight host work and rejects a replacement race', async () => {
    const { host, invoked } = pendingHost();
    const pending = portFor(host).execute(requests[0]);
    await invoked;
    host.replaceGeneration(8);
    await expectContentError(pending, 'generation-retired', 'mcp_content_generation_retired');
    expect(host.listenerCount()).toBe(0);
  });
  it('rejects a replacement observed after the host operation resolves', async () => {
    const host = new FakeContentHost();
    host.invoke.mockImplementationOnce(async (operation) => {
      host.replaceGeneration(8, false);
      return resultFor(operation);
    });
    await expectContentError(
      portFor(host).execute(requests[0]),
      'generation-retired',
      'mcp_content_generation_retired'
    );
    expect(host.listenerCount()).toBe(0);
  });
  it('keeps caller cancellation distinct and releases its watcher', async () => {
    const { host, invoked } = pendingHost();
    const caller = new AbortController();
    const pending = portFor(host).execute(requests[0], {
      signal: caller.signal,
    });
    await invoked;
    caller.abort();
    await expectContentError(pending, 'cancelled', 'mcp_content_cancelled');
    expect(host.listenerCount()).toBe(0);
  });
  it('rejects mismatched results with a stable typed error', async () => {
    const host = new FakeContentHost();
    const port = portFor(host);
    host.invoke.mockResolvedValueOnce({ result: { messages: [] }, type: 'prompts/get' });
    await expectContentError(
      port.execute(requests[0]),
      'protocol',
      'mcp_content_result_type_mismatch'
    );
  });
  it.each([
    ['snapshot', 'host', 'mcp-content-host-snapshot-failed', 'mcp_content_host_snapshot_failed'],
    ['watch', 'host', 'mcp-content-host-watch-failed', 'mcp_content_host_watch_failed'],
    ['invoke', 'host', 'mcp-content-host-invoke-failed', 'mcp_content_host_invoke_failed'],
    [
      'validation',
      'protocol',
      'mcp-content-result-validation-failed',
      'mcp_content_result_invalid',
    ],
  ] as const)(
    'preserves %s provenance without exposing its cause',
    async (phase, category, diagnosticCode, publicCode) => {
      const cause = new Error('credential-bearing internal detail');
      const host = new FakeContentHost();
      const onInternalError = vi.fn();
      const throwCause = (): never => {
        throw cause;
      };
      if (phase === 'snapshot') {
        vi.spyOn(host, 'snapshot').mockImplementation(throwCause);
      } else if (phase === 'watch') {
        vi.spyOn(host, 'watch').mockImplementation(throwCause);
      } else if (phase === 'invoke') {
        host.invoke.mockRejectedValueOnce(cause);
      } else {
        host.invoke.mockResolvedValueOnce(undefined as never);
      }
      const execution = portFor(host, onInternalError).execute(requests[0]);
      await expect(execution).rejects.toMatchObject({ category, code: publicCode });
      await expect(execution).rejects.not.toHaveProperty('cause');
      await expect(execution).rejects.not.toHaveProperty('hostError');
      expect(onInternalError.mock.calls).toEqual([
        [diagnosticCode, phase === 'validation' ? expect.anything() : cause],
      ]);
    }
  );
  it('maps typed remote host failures without leaking untyped causes', async () => {
    const host = new FakeContentHost();
    host.invoke.mockRejectedValueOnce({
      category: 'authorization',
      code: 'mcp-authorization-denied',
      evidence: { secret: 'must-not-cross' },
      message: 'Authorization denied',
    });
    const thrown: unknown = await portFor(host)
      .execute(requests[0])
      .catch((error: unknown) => error);
    if (!(thrown instanceof McpContentApplicationError)) {
      throw new Error('Expected typed MCP content application error');
    }
    expect(thrown).toMatchObject({ category: 'host', code: 'mcp_content_host_operation_failed' });
    expect(thrown.hostError).toEqual({
      category: 'authorization',
      code: 'mcp-authorization-denied',
      message: 'Authorization denied',
    });
    expect(thrown).not.toHaveProperty('cause');
    expect(thrown).not.toHaveProperty('hostError.evidence');
    expect(Object.isFrozen(thrown.hostError)).toBe(true);
  });
});
