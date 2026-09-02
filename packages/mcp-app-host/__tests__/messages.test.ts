import * as McpAppsSchemas from '@modelcontextprotocol/ext-apps';
import { describe, expect, it } from 'vitest';
import {
  MCP_APPS_STABLE_METHODS,
  type McpAppMessageDirection,
  parseMcpAppMessage,
} from '../src/index.js';

const STABLE_MESSAGES: readonly [McpAppMessageDirection, unknown][] = [
  [
    'app-to-host',
    {
      id: 1,
      jsonrpc: '2.0',
      method: 'ui/initialize',
      params: {
        appCapabilities: {},
        appInfo: { name: 'Weather', version: '1.0.0' },
        protocolVersion: '2026-01-26',
      },
    },
  ],
  ['app-to-host', { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }],
  [
    'app-to-host',
    {
      id: 'open-link',
      jsonrpc: '2.0',
      method: 'ui/open-link',
      params: { url: 'https://example.com' },
    },
  ],
  [
    'app-to-host',
    {
      id: 'message',
      jsonrpc: '2.0',
      method: 'ui/message',
      params: { content: [{ text: 'Hello', type: 'text' }], role: 'user' },
    },
  ],
  [
    'app-to-host',
    {
      id: 'display-mode',
      jsonrpc: '2.0',
      method: 'ui/request-display-mode',
      params: { mode: 'fullscreen' },
    },
  ],
  [
    'app-to-host',
    {
      id: 'context',
      jsonrpc: '2.0',
      method: 'ui/update-model-context',
      params: { structuredContent: { temperature: 72 } },
    },
  ],
  [
    'app-to-host',
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { height: 480, width: 640 },
    },
  ],
  ['host-to-app', { id: 'teardown', jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} }],
  // Review of #2914: ping is issued by either peer, and the host calls an
  // app-declared tool through tools/call.
  ['host-to-app', { id: 'liveness', jsonrpc: '2.0', method: 'ping', params: {} }],
  [
    'host-to-app',
    {
      id: 'app-tool',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'app-declared' },
    },
  ],
  [
    'host-to-app',
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: { city: 'London' } },
    },
  ],
  [
    'host-to-app',
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input-partial',
      params: { arguments: { city: 'Lon' } },
    },
  ],
  [
    'host-to-app',
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { content: [{ text: 'Sunny', type: 'text' }] },
    },
  ],
  [
    'host-to-app',
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-cancelled',
      params: { reason: 'user action' },
    },
  ],
  [
    'host-to-app',
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: { theme: 'dark' },
    },
  ],
  [
    'sandbox-to-host',
    { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} },
  ],
  [
    'host-to-sandbox',
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: {
        csp: { connectDomains: ['https://api.example.com'] },
        html: '<!doctype html><html></html>',
        permissions: { geolocation: {} },
      },
    },
  ],
];

function upstreamSchema(name: string): {
  safeParse(value: unknown): { readonly success: boolean };
} {
  const schema: unknown = Reflect.get(McpAppsSchemas, name);
  if (typeof schema !== 'object' || schema === null) {
    throw new Error(`MCP Apps test schema ${name} is unavailable`);
  }
  const safeParse: unknown = Reflect.get(schema, 'safeParse');
  if (typeof safeParse !== 'function') {
    throw new Error(`MCP Apps test schema ${name} has no safeParse method`);
  }
  return schema as { safeParse(value: unknown): { readonly success: boolean } };
}

describe('stable MCP Apps message allowlist', () => {
  it('pins the exact stable extension method vocabulary', () => {
    expect(MCP_APPS_STABLE_METHODS).toEqual([
      'ui/initialize',
      'ui/notifications/initialized',
      'ui/open-link',
      'ui/message',
      'ui/request-display-mode',
      'ui/update-model-context',
      'ui/notifications/size-changed',
      'ui/resource-teardown',
      'ui/notifications/tool-input',
      'ui/notifications/tool-input-partial',
      'ui/notifications/tool-result',
      'ui/notifications/tool-cancelled',
      'ui/notifications/host-context-changed',
      'ui/notifications/sandbox-proxy-ready',
      'ui/notifications/sandbox-resource-ready',
      'tools/call',
      'resources/read',
      'notifications/message',
      'ping',
    ]);
  });

  it.each(STABLE_MESSAGES)('accepts a stable %s message', (direction, message) => {
    expect(parseMcpAppMessage(message, direction)).toEqual(message);
  });

  it('accepts the v1.7.5 Implementation and experimental capability schema', () => {
    const message = {
      id: 'initialize-v1.7.5',
      jsonrpc: '2.0',
      method: 'ui/initialize',
      params: {
        appCapabilities: {
          experimental: {
            'com.example/weather': { liveRadar: true },
          },
        },
        appInfo: {
          description: 'Interactive weather dashboard',
          icons: [
            {
              mimeType: 'image/svg+xml',
              sizes: ['any'],
              src: 'https://example.com/weather.svg',
              theme: 'dark',
            },
          ],
          name: 'Weather',
          title: 'Weather Dashboard',
          version: '1.7.5',
          websiteUrl: 'https://example.com/weather',
        },
        protocolVersion: '2026-01-26',
      },
    } as const;

    expect(parseMcpAppMessage(message, 'app-to-host')).toEqual(message);
  });

  it('snapshots nested JSON fields and rejects cyclic values', () => {
    const structuredContent = { weather: { temperature: 72 } };
    const parsed = parseMcpAppMessage(
      {
        id: 'context',
        jsonrpc: '2.0',
        method: 'ui/update-model-context',
        params: { structuredContent },
      },
      'app-to-host'
    );

    structuredContent.weather.temperature = 90;
    const parsedStructuredContent = parsed.params?.['structuredContent'];
    expect(parsedStructuredContent).toEqual({ weather: { temperature: 72 } });
    expect(Object.isFrozen(parsedStructuredContent)).toBe(true);
    if (
      typeof parsedStructuredContent !== 'object' ||
      parsedStructuredContent === null ||
      !('weather' in parsedStructuredContent)
    ) {
      throw new Error('expected parsed structured content with weather data');
    }
    expect(Object.isFrozen(parsedStructuredContent.weather)).toBe(true);

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() =>
      parseMcpAppMessage(
        {
          id: 'context',
          jsonrpc: '2.0',
          method: 'ui/update-model-context',
          params: { structuredContent: cyclic },
        },
        'app-to-host'
      )
    ).toThrow(/must not contain cycles/);
  });

  it('preserves own __proto__ JSON fields without prototype mutation', () => {
    const structuredContent: unknown = JSON.parse('{"__proto__":{"isTrusted":true}}');
    const parsed = parseMcpAppMessage(
      {
        id: 'context',
        jsonrpc: '2.0',
        method: 'ui/update-model-context',
        params: { structuredContent },
      },
      'app-to-host'
    );
    const snapshot = parsed.params?.['structuredContent'];
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
      throw new Error('expected structured content object');
    }

    expect(Object.hasOwn(snapshot, '__proto__')).toBe(true);
    expect(Reflect.get(snapshot, '__proto__')).toEqual({ isTrusted: true });
    expect(Reflect.get(snapshot, 'isTrusted')).toBeUndefined();
  });

  it('rejects JSON payloads beyond the bounded nesting depth', () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 66; depth += 1) {
      nested = { nested };
    }
    expect(() =>
      parseMcpAppMessage(
        {
          id: 'context',
          jsonrpc: '2.0',
          method: 'ui/update-model-context',
          params: { structuredContent: nested },
        },
        'app-to-host'
      )
    ).toThrow(/maximum JSON depth/);
  });

  it.each(['', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test'])(
    'rejects unsafe external URLs: %j',
    (url) => {
      expect(() =>
        parseMcpAppMessage(
          { id: 'open-link', jsonrpc: '2.0', method: 'ui/open-link', params: { url } },
          'app-to-host'
        )
      ).toThrow(/MCP Apps message ui\/open-link\.params\.url/);
    }
  );

  it.each([
    ['app-to-host', { id: 1, jsonrpc: '2.0', method: 'ui/download-file', params: {} }],
    ['app-to-host', { jsonrpc: '2.0', method: 'ui/notifications/request-teardown', params: {} }],
    ['app-to-host', { id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }],
    ['app-to-host', { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} }],
  ] as const)('rejects a draft-only or non-extension %s message: %j', (direction, message) => {
    expect(() => parseMcpAppMessage(message, direction)).toThrow(/stable MCP Apps method/);
  });

  it('rejects a stable method in the wrong direction', () => {
    expect(() =>
      parseMcpAppMessage(
        {
          id: 1,
          jsonrpc: '2.0',
          method: 'ui/open-link',
          params: { url: 'https://example.com' },
        },
        'host-to-app'
      )
    ).toThrow(/not allowed in direction/);
  });

  it.each([
    { id: 'tool', jsonrpc: '2.0', method: 'tools/call', params: { name: 'refresh' } },
    {
      id: 'resource',
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: 'ui://weather/dashboard' },
    },
    {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { data: { ready: true }, level: 'info' },
    },
    { id: 'ping', jsonrpc: '2.0', method: 'ping' },
  ])('accepts the stable standard MCP subset: $method', (message) => {
    expect(parseMcpAppMessage(message, 'app-to-host')).toEqual(message);
  });

  it('uses the pinned generated empty teardown shape until the stable prose conflict is resolved', () => {
    expect(() =>
      parseMcpAppMessage(
        {
          id: 'teardown',
          jsonrpc: '2.0',
          method: 'ui/resource-teardown',
          params: { reason: 'replacement' },
        },
        'host-to-app'
      )
    ).toThrow(/unsupported field "reason"/);
  });

  it.each([
    {
      direction: 'app-to-host' as const,
      message: {
        id: 'missing-text',
        jsonrpc: '2.0',
        method: 'ui/message',
        params: { content: [{ type: 'text' }], role: 'user' },
      },
      schema: upstreamSchema('McpUiMessageRequestSchema'),
    },
    {
      direction: 'host-to-app' as const,
      message: {
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: { theme: 7 },
      },
      schema: upstreamSchema('McpUiHostContextChangedNotificationSchema'),
    },
    {
      direction: 'host-to-app' as const,
      message: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: { content: [{ type: 'text' }] },
      },
      schema: upstreamSchema('McpUiToolResultNotificationSchema'),
    },
  ])(
    'rejects $message.method whenever the pinned schema rejects it',
    ({ direction, message, schema }) => {
      expect(schema.safeParse({ method: message.method, params: message.params }).success).toBe(
        false
      );
      expect(() => parseMcpAppMessage(message, direction)).toThrow(/canonical schema/);
    }
  );

  it.each([
    ['missing JSON-RPC version', { id: 1, method: 'ui/open-link', params: { url: 'x' } }],
    [
      'fractional JSON-RPC request id',
      {
        id: 1.5,
        jsonrpc: '2.0',
        method: 'ui/open-link',
        params: { url: 'https://example.com' },
      },
    ],
    [
      'extra envelope field',
      {
        draft: true,
        id: 1,
        jsonrpc: '2.0',
        method: 'ui/open-link',
        params: { url: 'https://example.com' },
      },
    ],
    [
      'request without id',
      { jsonrpc: '2.0', method: 'ui/open-link', params: { url: 'https://example.com' } },
    ],
    [
      'notification with id',
      { id: 1, jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} },
    ],
    [
      'required notification params omitted',
      { jsonrpc: '2.0', method: 'ui/notifications/size-changed' },
    ],
    [
      'extra request params',
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'ui/open-link',
        params: { target: '_blank', url: 'https://example.com' },
      },
    ],
    [
      'wrong stable protocol version',
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'ui/initialize',
        params: {
          appCapabilities: {},
          appInfo: { name: 'Weather', version: '1.0.0' },
          protocolVersion: 'draft',
        },
      },
    ],
    [
      'extra app capability',
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'ui/initialize',
        params: {
          appCapabilities: { downloads: {} },
          appInfo: { name: 'Weather', version: '1.0.0' },
          protocolVersion: '2026-01-26',
        },
      },
    ],
    [
      'non-object experimental capability',
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'ui/initialize',
        params: {
          appCapabilities: { experimental: { 'com.example/weather': [] } },
          appInfo: { name: 'Weather', version: '1.7.5' },
          protocolVersion: '2026-01-26',
        },
      },
    ],
    [
      'malformed implementation icon',
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'ui/initialize',
        params: {
          appCapabilities: {},
          appInfo: {
            icons: [{ src: 'https://example.com/weather.svg', theme: 'system' }],
            name: 'Weather',
            version: '1.7.5',
          },
          protocolVersion: '2026-01-26',
        },
      },
    ],
  ])('rejects a malformed stable message: %s', (_label, message) => {
    expect(() => parseMcpAppMessage(message, 'app-to-host')).toThrow(/MCP Apps message/);
  });
});
