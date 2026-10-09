import {
  CallToolResultSchema,
  CompleteResultSchema,
  EmptyResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ConfiguredMcpServerId,
  MCP_CONNECTION_STATES,
  MCP_CORE_SERVER_PROJECTION,
  MCP_HOST_CATALOG_SECTIONS,
  MCP_STABLE_ERROR_CATEGORIES,
  McpConfiguredProtocolSchema,
  type McpConnectionState,
  type McpHostCloseReport,
  type McpHostControlRequest,
  McpHostErrorSchema,
  type McpHostOperation,
  type McpHostOperationResult,
  type McpHostPort,
  type McpHostServerSnapshot,
  McpStatusTransportSchema,
  parseConfiguredMcpServerId,
  parseMcpHostConfig,
  parseMcpHostControlRequest,
  parseMcpHostOperation,
  resolveMcpHostControlActions,
} from '../mcp-host.js';
import {
  parseMcpHostCatalog,
  parseMcpHostCloseReport,
  parseMcpHostOperationResult,
  parseMcpNegotiatedStatus,
} from '../mcp-host-runtime.js';
import {
  parseMcpHostOperationResultWire,
  parseMcpHostServerSnapshot,
  parseMcpHostSnapshot,
} from '../mcp-host-status.js';
import type { McpConfiguredProtocol, McpStatusTransport } from '../mcp-status.js';

const id = parseConfiguredMcpServerId('😀'.repeat(65));
const uuid = '123e4567-e89b-42d3-a456-426614174000';
const SAFE_CONFIG = `{"servers":[{"auth":{"type":"none"},"configuredProtocol":"legacy","configuredServerId":"stdio-server","startup":"automatic","transport":{"configRef":"${uuid}","type":"stdio"}},{"auth":{"type":"oauth-user"},"configuredProtocol":"auto","configuredServerId":"http-server","startup":"authentication-required","transport":{"configRef":"${uuid}","type":"streamable-http"}},{"auth":{"credential":{"id":"${uuid}","store":"mcp-credentials"},"type":"bearer"},"configuredProtocol":"legacy","configuredServerId":"sse-server","startup":"automatic","transport":{"configRef":"${uuid}","type":"sse"}}]}`;
const LIST_ENVELOPE =
  '{"_meta":{"io.modelcontextprotocol/serverInfo":{"name":"linear","version":"1"}},"nextCursor":"next","tools":[{"_meta":{"vendor":"linear"},"annotations":{"readOnlyHint":true},"description":"Get issue","execution":{"taskSupport":"optional"},"icons":[{"mimeType":"image/svg+xml","sizes":["any"],"src":"https://linear.app/icon.svg","theme":"dark"}],"inputSchema":{"properties":{"id":{"type":"string"}},"type":"object"},"name":"issue.get","outputSchema":{"$schema":"https://json-schema.org/draft/2020-12/schema"},"title":"Get issue"}]}';
const CALL_ENVELOPE =
  '{"_meta":{"trace":"secret-looking-reference-not-a-credential"},"content":[{"_meta":{"source":"linear"},"annotations":{"audience":["user"],"lastModified":"2026-08-29T00:00:00Z","priority":1},"text":"sk-like tool output is data","type":"text"},{"data":"base64","mimeType":"image/png","type":"image"},{"data":"base64","mimeType":"audio/wav","type":"audio"},{"icons":[{"src":"https://linear.app/icon.svg"}],"name":"issue","type":"resource_link","uri":"linear://issue/1"},{"resource":{"text":"issue","uri":"linear://issue/1"},"type":"resource"}],"isError":false,"structuredContent":{"issue":"BST-1502"}}';
type ListResult = Extract<McpHostOperationResult, { type: 'tools/list' }>['result'];
type CallResult = Extract<McpHostOperationResult, { type: 'tools/call' }>['result'];

const CORE_FEATURE_RESULTS = {
  'completion/complete': {
    completion: { hasMore: true, total: 3, values: ['formal', 'friendly'] },
  },
  'prompts/get': {
    description: 'A mixed-content prompt',
    messages: [
      { content: { text: 'Summarize BST-1471', type: 'text' }, role: 'user' },
      { content: { data: 'aW1hZ2U=', mimeType: 'image/png', type: 'image' }, role: 'assistant' },
      { content: { data: 'YXVkaW8=', mimeType: 'audio/wav', type: 'audio' }, role: 'assistant' },
      {
        content: {
          name: 'BST-1471',
          type: 'resource_link',
          uri: 'linear://issue/BST-1471',
        },
        role: 'assistant',
      },
      {
        content: {
          resource: {
            mimeType: 'text/markdown',
            text: '# BST-1471',
            uri: 'linear://issue/BST-1471',
          },
          type: 'resource',
        },
        role: 'assistant',
      },
    ],
  },
  'prompts/list': {
    cacheScope: 'private',
    nextCursor: 'prompt-page-2',
    prompts: [
      {
        arguments: [{ description: 'Desired tone', name: 'tone', required: false }],
        description: 'Summarize one issue',
        icons: [{ mimeType: 'image/png', src: 'data:image/png;base64,aWNvbg==' }],
        name: 'summarize-issue',
        title: 'Summarize issue',
      },
    ],
    ttlMs: 5000,
  },
  'resources/list': {
    cacheScope: 'private',
    nextCursor: 'resource-page-2',
    resources: [
      {
        annotations: { audience: ['user'], priority: 0.9 },
        description: 'Issue body',
        icons: [{ mimeType: 'image/svg+xml', src: 'https://example.test/issue.svg' }],
        mimeType: 'text/markdown',
        name: 'BST-1471',
        size: 1471,
        title: 'MCP core server features',
        uri: 'linear://issue/BST-1471',
      },
    ],
    ttlMs: 2500,
  },
  'resources/read': {
    cacheScope: 'private',
    contents: [
      {
        mimeType: 'text/markdown',
        text: '# BST-1471',
        uri: 'linear://issue/BST-1471',
      },
      {
        blob: 'AAEC',
        mimeType: 'application/octet-stream',
        uri: 'linear://issue/BST-1471/attachment',
      },
    ],
    ttlMs: 1000,
  },
  'resources/subscribe': {},
  'resources/templates/list': {
    cacheScope: 'public',
    nextCursor: 'template-page-2',
    resourceTemplates: [
      {
        description: 'Issue by identifier',
        mimeType: 'text/markdown',
        name: 'issue',
        title: 'Issue',
        uriTemplate: 'linear://issue/{identifier}',
      },
    ],
    ttlMs: 7500,
  },
  'resources/unsubscribe': {},
} as const;

describe('MCP host contract', () => {
  it('bounds configured server ids with specific diagnostics', () => {
    const invalidIds = [
      ['😀'.repeat(129), /at most 128 Unicode code points/u],
      ['__proto__', /reserved server name/u],
      ['constructor', /reserved server name/u],
      ['prototype', /reserved server name/u],
      ['linear\u202Eproduction', /Unicode control or format character/u],
    ] as const;

    for (const [value, diagnostic] of invalidIds) {
      expect(() => parseConfiguredMcpServerId(value)).toThrow(diagnostic);
    }
  });

  it('allows only legacy protocol on SSE transports', () => {
    const config = JSON.parse(SAFE_CONFIG) as { servers: Record<string, unknown>[] };
    const sse = config.servers[2]!;

    for (const configuredProtocol of ['auto', '2026-07-28']) {
      expect(() =>
        parseMcpHostConfig({
          servers: [{ ...sse, configuredProtocol }],
        })
      ).toThrow('SSE transport requires legacy protocol');
    }
  });

  it('rejects OAuth on stdio before host composition', () => {
    const config = JSON.parse(SAFE_CONFIG) as { servers: Record<string, unknown>[] };
    const stdio = config.servers[0]!;

    expect(() =>
      parseMcpHostConfig({
        servers: [
          {
            ...stdio,
            auth: { type: 'oauth-user' },
            startup: 'authentication-required',
          },
        ],
      })
    ).toThrow('OAuth user authentication requires an HTTP transport');
  });

  it('keeps runtime transport and stable-error vocabularies aligned with their types', () => {
    expectTypeOf(
      McpConfiguredProtocolSchema.parse('legacy')
    ).toEqualTypeOf<McpConfiguredProtocol>();
    expectTypeOf(McpStatusTransportSchema.parse('stdio')).toEqualTypeOf<McpStatusTransport>();
    for (const category of MCP_STABLE_ERROR_CATEGORIES) {
      expect(McpHostErrorSchema.parse({ category, code: 'stable_code', message: 'Safe' })).toEqual({
        category,
        code: 'stable_code',
        message: 'Safe',
      });
    }
    expect(() =>
      McpHostErrorSchema.parse({ category: 'sdk-private', code: 'bad', message: 'Unsafe' })
    ).toThrow();
  });

  it('centralizes identity and strictly parses cloned operation/config DTOs', () => {
    for (const value of ['', ' linear', 'linear ', '__proto__', 'linear\nproduction', 42]) {
      expect(() => parseConfiguredMcpServerId(value)).toThrow('Invalid configured MCP server id');
    }
    // @ts-expect-error routing identity cannot be inferred from a dotted tool name.
    const missing: McpHostOperation = { toolName: 'Linear.Display.issue.get', type: 'tools/call' };
    // @ts-expect-error plain strings must cross the configured-server parser.
    const unbranded: ConfiguredMcpServerId = 'configured-linear';
    expect([missing, unbranded]).toHaveLength(2);

    const operation = parseMcpHostOperation(
      structuredClone({
        arguments: { issueId: 'BST-1502' },
        configuredServerId: id,
        toolName: 'Linear.Display.issue.get',
        type: 'tools/call',
      })
    );
    const config = parseMcpHostConfig(structuredClone(JSON.parse(SAFE_CONFIG)));
    expect(operation.type).toBe('tools/call');
    expect(config.servers.map(({ auth }) => auth.type)).toEqual(['none', 'oauth-user', 'bearer']);
    expect(config.servers.map(({ startup }) => startup)).toEqual([
      'automatic',
      'authentication-required',
      'automatic',
    ]);
    expect(() => parseMcpHostConfig({ servers: [config.servers[0], config.servers[0]] })).toThrow(
      'duplicate configured server id'
    );

    const first = config.servers[0]!;
    const unsafe = [
      { settings: { Authorization: 'Bearer secret' } },
      { auth: { token: 'sk-live-secret', type: 'bearer' } },
      { auth: { credential: { id: 'sk-live-secret', store: 'mcp-credentials' }, type: 'bearer' } },
      { transport: { callback: () => 0, type: 'stdio' } },
    ];
    for (const patch of unsafe) {
      expect(() => parseMcpHostConfig({ servers: [{ ...first, ...patch }] })).toThrow();
    }
    expect(() =>
      parseMcpHostOperation({ ...operation, arguments: { callback: () => 0 } })
    ).toThrow();
    expect(() => parseMcpHostOperation({ toolName: 'x', type: 'tools/call' })).toThrow();
    expect(() => parseMcpHostOperation({ method: 'resources/read', type: 'request' })).toThrow();
  });

  it('preserves complete browser-safe SDK tool envelopes', () => {
    const listEnvelope = ListToolsResultSchema.parse(JSON.parse(LIST_ENVELOPE));
    const callEnvelope = CallToolResultSchema.parse(JSON.parse(CALL_ENVELOPE));
    const list = parseMcpHostOperationResult({
      result: { ...listEnvelope, type: 'server-owned' },
      type: 'tools/list',
    });
    const call = parseMcpHostOperationResult({ result: callEnvelope, type: 'tools/call' });
    expect(list.type).toBe('tools/list');
    expect(call.type).toBe('tools/call');
    expect(() => parseMcpHostOperationResult({ ...listEnvelope, type: 'tools/list' })).toThrow();
    if (list.type !== 'tools/list' || call.type !== 'tools/call') {
      throw new Error('Unexpected MCP host operation result type');
    }
    expectTypeOf(list.result).toEqualTypeOf<ListResult>();
    expectTypeOf(call.result).toEqualTypeOf<CallResult>();
    expect(list.result['type']).toBe('server-owned');
    const listResult = list.result;
    const callResult = call.result;
    const tool = structuredClone(listResult).tools[0];
    expect(tool?._meta).toEqual({ vendor: 'linear' });
    expect(tool?.annotations).toEqual({ readOnlyHint: true });
    expect(tool?.execution).toEqual({ taskSupport: 'optional' });
    expect(tool?.icons?.[0]?.theme).toBe('dark');
    expect([listResult.nextCursor, tool?.outputSchema?.$schema]).toEqual([
      'next',
      expect.any(String),
    ]);
    expect(
      structuredClone(callResult)
        .content.map(({ type }) => type)
        .join()
    ).toBe('text,image,audio,resource_link,resource');
  });

  it('strictly parses the complete closed core-server operation projection', () => {
    const operations = [
      { configuredServerId: id, cursor: 'resources-page-2', type: 'resources/list' },
      {
        configuredServerId: id,
        cursor: 'templates-page-2',
        type: 'resources/templates/list',
      },
      { configuredServerId: id, type: 'resources/read', uri: 'linear://issue/BST-1471' },
      { configuredServerId: id, cursor: 'prompts-page-2', type: 'prompts/list' },
      {
        arguments: { identifier: 'BST-1471', tone: 'terse' },
        configuredServerId: id,
        name: 'summarize-issue',
        type: 'prompts/get',
      },
      {
        argument: { name: 'tone', value: 'f' },
        configuredServerId: id,
        ref: { name: 'summarize-issue', type: 'ref/prompt' },
        type: 'completion/complete',
      },
      { configuredServerId: id, type: 'resources/subscribe', uri: 'linear://issue/BST-1471' },
      {
        configuredServerId: id,
        type: 'resources/unsubscribe',
        uri: 'linear://issue/BST-1471',
      },
    ] as const;

    expect(operations.map((operation) => parseMcpHostOperation(operation))).toEqual(operations);
    for (const operation of operations) {
      expect(() => parseMcpHostOperation({ ...operation, unsupported: true })).toThrow();
    }
  });

  it('rejects blank or whitespace-padded resource URIs at every host boundary', () => {
    const resourceOperations: readonly ((uri: string) => unknown)[] = [
      (uri) => ({ configuredServerId: id, type: 'resources/read', uri }),
      (uri) => ({
        argument: { name: 'identifier', value: 'BST-1471' },
        configuredServerId: id,
        ref: { type: 'ref/resource', uri },
        type: 'completion/complete',
      }),
      (uri) => ({ configuredServerId: id, type: 'resources/subscribe', uri }),
      (uri) => ({ configuredServerId: id, type: 'resources/unsubscribe', uri }),
    ];

    for (const uri of ['', ' ', ' linear://issue/BST-1471', 'linear://issue/BST-1471 ']) {
      for (const operation of resourceOperations) {
        expect(() => parseMcpHostOperation(operation(uri))).toThrow();
      }
      expect(() =>
        parseMcpHostCatalog({
          errors: {},
          features: {
            completion: false,
            promptListChanged: false,
            prompts: false,
            resourceListChanged: false,
            resourceSubscriptions: true,
            resources: true,
            toolListChanged: false,
            tools: false,
          },
          subscription: {
            honoredFilter: { resourceSubscriptions: [uri] },
            mode: 'modern-listen',
            state: 'listening',
          },
        })
      ).toThrow();
    }
  });

  it('preserves exact resources, templates, prompts, completion, media, and cache fields', () => {
    const schemas = {
      'completion/complete': CompleteResultSchema,
      'prompts/get': GetPromptResultSchema,
      'prompts/list': ListPromptsResultSchema,
      'resources/list': ListResourcesResultSchema,
      'resources/read': ReadResourceResultSchema,
      'resources/subscribe': EmptyResultSchema,
      'resources/templates/list': ListResourceTemplatesResultSchema,
      'resources/unsubscribe': EmptyResultSchema,
    } as const;

    for (const [type, fixture] of Object.entries(CORE_FEATURE_RESULTS)) {
      const schema = schemas[type as keyof typeof schemas];
      const parsed = schema.parse(structuredClone(fixture));
      expect(parseMcpHostOperationResult({ result: parsed, type })).toEqual({
        result: fixture,
        type,
      });
    }
  });

  it('projects catalog support, independent list errors, and modern listen state without content injection', () => {
    const catalogError = {
      category: 'operation',
      code: 'mcp-request-timeout',
      message: 'Catalog failed',
    } as const;
    const catalog = {
      errors: Object.fromEntries(
        MCP_HOST_CATALOG_SECTIONS.map((section) => [section, catalogError])
      ),
      features: {
        completion: true,
        promptListChanged: true,
        prompts: true,
        resourceListChanged: true,
        resourceSubscriptions: true,
        resources: true,
        toolListChanged: true,
        tools: true,
      },
      resources: CORE_FEATURE_RESULTS['resources/list'],
      resourceTemplates: CORE_FEATURE_RESULTS['resources/templates/list'],
      subscription: {
        honoredFilter: {
          promptsListChanged: true,
          resourceSubscriptions: ['linear://issue/BST-1471'],
          resourcesListChanged: true,
          toolsListChanged: true,
        },
        mode: 'modern-listen',
        state: 'listening',
      },
      tools: JSON.parse(LIST_ENVELOPE),
    } as const;

    expect(parseMcpHostCatalog(structuredClone(catalog))).toEqual(catalog);
    expect(Object.keys(catalog.errors).sort()).toEqual([...MCP_HOST_CATALOG_SECTIONS].sort());
    expect(MCP_CORE_SERVER_PROJECTION).toEqual({
      completion: {
        operations: ['completion/complete'],
        visibility: 'user-or-authorized-assistant',
      },
      eagerModelContext: false,
      prompts: {
        control: 'user',
        operations: ['prompts/list', 'prompts/get'],
        visibility: 'user-or-authorized-assistant',
      },
      resources: {
        control: 'application',
        operations: ['resources/list', 'resources/templates/list', 'resources/read'],
        visibility: 'user-or-authorized-assistant',
      },
    });
    expect(() =>
      parseMcpHostCatalog({
        ...catalog,
        subscription: { ...catalog.subscription, state: 'silently-degraded' },
      })
    ).toThrow();
  });

  it('rejects SDK-accepted non-JSON operation results', () => {
    const sdkAccepted = [
      { _meta: { callback: () => undefined }, content: [] },
      { content: [], structuredContent: { createdAt: new Date() } },
      { content: [], structuredContent: { count: Number.NaN } },
    ];

    for (const result of sdkAccepted) {
      expect(CallToolResultSchema.safeParse(result).success).toBe(true);
      expect(() => parseMcpHostOperationResult({ result, type: 'tools/call' })).toThrow(
        '$["result"]'
      );
    }

    const listResult = {
      tools: [{ inputSchema: { callback: () => undefined, type: 'object' }, name: 'unsafe' }],
    };
    expect(ListToolsResultSchema.safeParse(listResult).success).toBe(true);
    expect(() => parseMcpHostOperationResult({ result: listResult, type: 'tools/list' })).toThrow();

    const hostileResults = [
      JSON.parse('{"content":[],"__proto__":{"sentinel":true}}'),
      Object.defineProperty({ content: [] }, 'hidden', { get: () => true }),
    ];
    for (const result of hostileResults) {
      expect(CallToolResultSchema.safeParse(result).success).toBe(true);
      expect(() => parseMcpHostOperationResult({ result, type: 'tools/call' })).toThrow();
    }
  });

  it('exhaustively clones every lifecycle and remaining DTO family', () => {
    const base = {
      configuredProtocol: '2026-07-28' as const,
      configuredServerId: id,
      generation: 1,
      transport: 'streamable-http' as const,
    };
    const servers: readonly McpHostServerSnapshot[] = [
      { ...base, state: 'disconnected' },
      { ...base, state: 'connecting' },
      { ...base, state: 'authentication-required' },
      { ...base, state: 'authorizing' },
      { ...base, negotiated: { era: 'modern', revision: '2026-07-28' }, state: 'connected' },
      { ...base, state: 'closing' },
      {
        ...base,
        error: { category: 'protocol', code: 'bad', message: 'Rejected' },
        state: 'error',
      },
    ];
    const close = JSON.parse(
      '{"callbacksClosed":0,"childProcessesClosed":0,"clientsClosed":0,"failures":[],"loopbackPortsClosed":0,"probesClosed":0,"requestsSettled":0,"subscriptionsClosed":0}'
    ) as McpHostCloseReport;
    const dtos = {
      close,
      emptyEvent: { revision: 2, servers: [] },
      event: { revision: 1, servers: [servers[0]!] },
      filter: { configuredServerIds: [id] },
      snapshot: { revision: 1, servers },
    };
    expect(structuredClone(dtos)).toEqual(dtos);
    expect(servers.map(({ state }) => state)).toEqual(MCP_CONNECTION_STATES);
    expectTypeOf<McpHostServerSnapshot['state']>().toEqualTypeOf<McpConnectionState>();
    expectTypeOf<keyof McpHostPort>().toEqualTypeOf<
      'snapshot' | 'invoke' | 'watch' | 'replaceConfig' | 'control' | 'close'
    >();
    expectTypeOf<McpHostControlRequest['action']>().toEqualTypeOf<
      'connect' | 'retry' | 'cancel' | 'disconnect' | 'reauthorize'
    >();
    for (const action of ['connect', 'retry', 'cancel', 'disconnect', 'reauthorize'] as const) {
      expect(parseMcpHostControlRequest({ action, configuredServerId: id })).toEqual({
        action,
        configuredServerId: id,
      });
    }
    expect(() =>
      parseMcpHostControlRequest({ action: 'clear-all', configuredServerId: id })
    ).toThrow();
  });

  it('derives OAuth controls from authoritative state, error category, and credentials', () => {
    const base = {
      auth: {
        credentialState: 'stored' as const,
        grantedScopes: ['read'],
        requestedScopes: ['read'],
        resourceUrl: 'https://mcp.linear.app/mcp',
        type: 'oauth-user' as const,
      },
      configuredProtocol: 'auto' as const,
      configuredServerId: id,
      generation: 1,
      transport: 'streamable-http' as const,
    };
    expect(resolveMcpHostControlActions({ ...base, state: 'authentication-required' })).toEqual([
      'connect',
      'disconnect',
    ]);
    expect(
      resolveMcpHostControlActions({
        ...base,
        error: { category: 'transport', code: 'offline', message: 'Offline' },
        state: 'error',
      })
    ).toEqual(['retry', 'disconnect']);
    expect(
      resolveMcpHostControlActions({
        ...base,
        error: { category: 'authentication', code: 'expired', message: 'Expired' },
        state: 'error',
      })
    ).toEqual(['disconnect', 'reauthorize']);
    expect(
      resolveMcpHostControlActions({
        ...base,
        auth: { ...base.auth, credentialState: 'unreadable' },
        state: 'authentication-required',
      })
    ).toEqual(['disconnect']);
  });

  it('strictly parses negotiated status and close proof DTOs', () => {
    const identity = {
      description: 'Issue tracker',
      name: 'linear',
      title: 'Linear',
      version: '2.0.0',
      websiteUrl: 'https://linear.app',
    };
    expect(
      parseMcpNegotiatedStatus({
        advertisedCapabilityIds: ['tools'],
        era: 'modern',
        revision: '2026-07-28',
        serverIdentity: identity,
      })
    ).toEqual({
      advertisedCapabilityIds: ['tools'],
      era: 'modern',
      revision: '2026-07-28',
      serverIdentity: identity,
    });

    const close = {
      callbacksClosed: 0,
      childProcessesClosed: 1,
      clientsClosed: 1,
      failures: [],
      loopbackPortsClosed: 0,
      probesClosed: 0,
      requestsSettled: 2,
      subscriptionsClosed: 0,
    };
    expect(parseMcpHostCloseReport(close)).toEqual(close);

    const malformedStatuses = [
      { advertisedCapabilityIds: {}, era: 'modern', revision: '2026-07-28' },
      { era: 'future', revision: '2026-07-28' },
      { era: 'modern' },
      Object.assign(Object.create({ inherited: true }), {
        era: 'modern',
        revision: '2026-07-28',
      }),
    ];
    for (const status of malformedStatuses) {
      expect(() => parseMcpNegotiatedStatus(status)).toThrow();
    }

    for (const malformedClose of [
      { ...close, clientsClosed: -1 },
      { ...close, clientsClosed: 0.5 },
      { ...close, extra: true },
      { ...close, requestsSettled: Number.NaN },
      Object.fromEntries(Object.entries(close).filter(([key]) => key !== 'clientsClosed')),
    ]) {
      expect(() => parseMcpHostCloseReport(malformedClose)).toThrow();
    }
  });
});

describe('MCP host status at a process boundary (BST-1930 c5b)', () => {
  const base = {
    auth: { credentialState: 'stored', type: 'bearer' },
    configuredProtocol: 'legacy',
    configuredServerId: 'fixture.status',
    generation: 2,
    transport: 'streamable-http',
  } as const;

  it('keeps each server state with the fields that state carries', () => {
    const status = {
      revision: 4,
      servers: [
        { ...base, state: 'disconnected' },
        {
          ...base,
          configuredServerId: 'fixture.failed',
          error: { category: 'connection', code: 'mcp-connection-failed', message: 'refused' },
          state: 'error',
        },
        {
          ...base,
          configuredServerId: 'fixture.connected',
          negotiated: { era: 'legacy', revision: '2025-06-18' },
          state: 'connected',
        },
      ],
    };
    expect(parseMcpHostSnapshot(status)).toEqual(status);
  });

  it('refuses a server whose state lacks its facts, or a generation the host never mints', () => {
    expect(() => parseMcpHostServerSnapshot({ ...base, state: 'connected' })).toThrow();
    expect(() => parseMcpHostServerSnapshot({ ...base, state: 'error' })).toThrow();
    expect(() =>
      parseMcpHostServerSnapshot({ ...base, generation: 0, state: 'disconnected' })
    ).toThrow();
    expect(() =>
      parseMcpHostSnapshot({ revision: 1, servers: [{ ...base, extra: 1, state: 'disconnected' }] })
    ).toThrow();
  });
});

describe('MCP operation results in a browser (BST-1930 c5d)', () => {
  it('keeps an envelope whose result is strict JSON, as the host validated it', () => {
    const read = {
      result: { contents: [{ mimeType: 'text/plain', text: 'body', uri: 'echo://x' }] },
      type: 'resources/read',
    };
    expect(parseMcpHostOperationResultWire(read)).toEqual(read);
  });

  it('refuses an unknown operation, a non-object result, or non-JSON data', () => {
    expect(() => parseMcpHostOperationResultWire({ result: {}, type: 'tools/explode' })).toThrow();
    expect(() => parseMcpHostOperationResultWire({ result: [], type: 'tools/list' })).toThrow();
    expect(() =>
      parseMcpHostOperationResultWire({ result: { at: new Date(0) }, type: 'tools/list' })
    ).toThrow();
  });
});
