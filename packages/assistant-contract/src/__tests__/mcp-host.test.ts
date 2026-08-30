import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ConfiguredMcpServerId,
  MCP_CONNECTION_STATES,
  MCP_STABLE_ERROR_CATEGORIES,
  McpConfiguredProtocolSchema,
  type McpConnectionState,
  type McpHostCloseReport,
  McpHostErrorSchema,
  type McpHostOperation,
  type McpHostOperationResult,
  type McpHostPort,
  type McpHostServerSnapshot,
  McpStatusTransportSchema,
  parseConfiguredMcpServerId,
  parseMcpHostConfig,
  parseMcpHostOperation,
} from '../mcp-host.js';
import { parseMcpHostOperationResult } from '../mcp-host-runtime.js';
import type { McpConfiguredProtocol, McpStatusTransport } from '../mcp-status.js';

const id = parseConfiguredMcpServerId('😀'.repeat(65));
const uuid = '123e4567-e89b-42d3-a456-426614174000';
const SAFE_CONFIG = `{"servers":[{"auth":{"type":"none"},"configuredProtocol":"legacy","configuredServerId":"stdio-server","transport":{"configRef":"${uuid}","type":"stdio"}},{"auth":{"type":"oauth-user"},"configuredProtocol":"auto","configuredServerId":"http-server","transport":{"configRef":"${uuid}","type":"streamable-http"}},{"auth":{"credential":{"id":"${uuid}","store":"mcp-credentials"},"type":"bearer"},"configuredProtocol":"legacy","configuredServerId":"sse-server","transport":{"configRef":"${uuid}","type":"sse"}}]}`;
const LIST_ENVELOPE =
  '{"_meta":{"io.modelcontextprotocol/serverInfo":{"name":"linear","version":"1"}},"nextCursor":"next","tools":[{"_meta":{"vendor":"linear"},"annotations":{"readOnlyHint":true},"description":"Get issue","execution":{"taskSupport":"optional"},"icons":[{"mimeType":"image/svg+xml","sizes":["any"],"src":"https://linear.app/icon.svg","theme":"dark"}],"inputSchema":{"properties":{"id":{"type":"string"}},"type":"object"},"name":"issue.get","outputSchema":{"$schema":"https://json-schema.org/draft/2020-12/schema"},"title":"Get issue"}]}';
const CALL_ENVELOPE =
  '{"_meta":{"trace":"secret-looking-reference-not-a-credential"},"content":[{"_meta":{"source":"linear"},"annotations":{"audience":["user"],"lastModified":"2026-08-29T00:00:00Z","priority":1},"text":"sk-like tool output is data","type":"text"},{"data":"base64","mimeType":"image/png","type":"image"},{"data":"base64","mimeType":"audio/wav","type":"audio"},{"icons":[{"src":"https://linear.app/icon.svg"}],"name":"issue","type":"resource_link","uri":"linear://issue/1"},{"resource":{"text":"issue","uri":"linear://issue/1"},"type":"resource"}],"isError":false,"structuredContent":{"issue":"BST-1502"}}';
type ListResult = Extract<McpHostOperationResult, { type: 'tools/list' }>['result'];
type CallResult = Extract<McpHostOperationResult, { type: 'tools/call' }>['result'];

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
      '{"callbacksClosed":0,"childProcessesClosed":0,"clientsClosed":0,"loopbackPortsClosed":0,"probesClosed":0,"requestsSettled":0,"subscriptionsClosed":0}'
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
      'snapshot' | 'invoke' | 'watch' | 'replaceConfig' | 'close'
    >();
  });
});
