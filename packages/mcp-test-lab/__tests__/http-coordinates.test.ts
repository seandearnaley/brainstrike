import { describe, expect, it, vi } from 'vitest';
import { oauthFaultMethod, protocolCoordinate } from '../src/http-coordinates';

const MODERN_VERSION = '2026-07-28';

function modernParams(params: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ...params,
    _meta: {
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'brainstrike-coordinate-test', version: '1' },
      'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
    },
  };
}

function mcpRequest(
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  url = 'http://mcp-lab.invalid/mcp'
): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  });
}

function modernRequest(
  method: string,
  params: Readonly<Record<string, unknown>> = {},
  headers: Readonly<Record<string, string>> = {}
): Request {
  return mcpRequest(
    { id: 1, jsonrpc: '2.0', method, params: modernParams(params) },
    {
      'mcp-method': method,
      'mcp-protocol-version': MODERN_VERSION,
      ...headers,
    }
  );
}

describe('MCP HTTP fault coordinates', () => {
  it.each([
    ['GET', '/.well-known/oauth-protected-resource/mcp', 'oauth/protected-resource'],
    ['GET', '/.well-known/oauth-authorization-server', 'oauth/authorization-server'],
    ['POST', '/register', 'oauth/register'],
    ['GET', '/authorize?client_id=client', 'oauth/authorize'],
    ['POST', '/token', 'oauth/token'],
  ] as const)('maps exact OAuth route ownership for %s %s', (method, pathname, expected) => {
    expect(oauthFaultMethod(new Request(`http://127.0.0.1:43123${pathname}`, { method }))).toBe(
      expected
    );
  });

  it.each([
    ['POST', '/authorize'],
    ['GET', '/token'],
    ['POST', '/.well-known/oauth-authorization-server'],
    ['GET', '/register'],
    ['POST', '/authorize/extra'],
    ['GET', '/.well-known/oauth-authorization-server?unexpected=1'],
  ] as const)('rejects wrong OAuth coordinate %s %s', (method, pathname) => {
    expect(
      oauthFaultMethod(new Request(`http://127.0.0.1:43123${pathname}`, { method }))
    ).toBeUndefined();
  });

  it('derives a modern client request through the pinned SDK classifier and schemas', async () => {
    const request = modernRequest('tools/list');
    const clone = vi.spyOn(request, 'clone');
    try {
      await expect(protocolCoordinate(request, 'modern')).resolves.toEqual({
        method: 'tools/list',
        parsedBody: expect.objectContaining({ method: 'tools/list' }),
        phase: 'operation',
      });
      expect(clone).toHaveBeenCalledTimes(1);
    } finally {
      clone.mockRestore();
    }
  });

  it('accepts the exact executable legacy request and notification shapes', async () => {
    await expect(
      protocolCoordinate(
        mcpRequest({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
        'legacy'
      )
    ).resolves.toEqual({
      method: 'tools/list',
      parsedBody: expect.objectContaining({ method: 'tools/list' }),
      phase: 'operation',
    });
    await expect(
      protocolCoordinate(
        mcpRequest({
          jsonrpc: '2.0',
          method: 'notifications/roots/list_changed',
          params: {},
        }),
        'legacy'
      )
    ).resolves.toEqual({
      method: 'notifications/roots/list_changed',
      parsedBody: expect.objectContaining({ method: 'notifications/roots/list_changed' }),
      phase: 'subscription',
    });
  });

  it('requires modern method, version, envelope, and tools/call name agreement', async () => {
    const validCall = modernRequest(
      'tools/call',
      { arguments: {}, name: 'echo' },
      { 'mcp-name': 'echo' }
    );
    await expect(protocolCoordinate(validCall, 'modern')).resolves.toEqual(
      expect.objectContaining({ method: 'tools/call', phase: 'operation' })
    );
    await expect(
      protocolCoordinate(
        modernRequest(
          'tools/call',
          { arguments: {}, name: 'echo' },
          { 'mcp-name': '=?base64?ZWNobw==?=' }
        ),
        'modern'
      )
    ).resolves.toEqual(expect.objectContaining({ method: 'tools/call' }));

    const body = { id: 1, jsonrpc: '2.0', method: 'tools/list', params: modernParams() };
    for (const request of [
      mcpRequest(body, { 'mcp-protocol-version': MODERN_VERSION }),
      mcpRequest(body, {
        'mcp-method': 'tools/call',
        'mcp-protocol-version': MODERN_VERSION,
      }),
      mcpRequest(body, {
        'mcp-method': 'tools/list',
        'mcp-protocol-version': '2025-11-25',
      }),
      modernRequest('tools/call', { arguments: {}, name: 'echo' }),
      modernRequest('tools/call', { arguments: {}, name: 'echo' }, { 'mcp-name': 'different' }),
      modernRequest(
        'tools/call',
        { arguments: {}, name: 'echo' },
        { 'mcp-name': '=?base64?***?=' }
      ),
    ]) {
      await expect(protocolCoordinate(request, 'modern')).resolves.toBeUndefined();
    }
  });

  it('allows an omitted modern notification method header but rejects disagreement', async () => {
    const body = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: modernParams({ progress: 1, progressToken: 'token' }),
    };
    await expect(
      protocolCoordinate(mcpRequest(body, { 'mcp-protocol-version': MODERN_VERSION }), 'modern')
    ).resolves.toEqual(expect.objectContaining({ method: 'notifications/progress' }));
    await expect(
      protocolCoordinate(
        mcpRequest(body, {
          'mcp-method': 'notifications/cancelled',
          'mcp-protocol-version': MODERN_VERSION,
        }),
        'modern'
      )
    ).resolves.toBeUndefined();
  });

  it('does not admit malformed, wrong-direction, wrong-era, or unexecutable SDK messages', async () => {
    for (const [request, era] of [
      [mcpRequest({ id: 1, method: 'tools/list' }), 'legacy'],
      [mcpRequest({ jsonrpc: '2.0', method: 'tools/list' }), 'legacy'],
      [mcpRequest({ id: 1, jsonrpc: '2.0', method: 'notifications/initialized' }), 'legacy'],
      [modernRequest('sampling/createMessage'), 'modern'],
      [modernRequest('notifications/subscriptions/acknowledged'), 'modern'],
      [modernRequest('tools/list'), 'legacy'],
      [mcpRequest({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }), 'modern'],
    ] as const) {
      await expect(protocolCoordinate(request, era)).resolves.toBeUndefined();
    }
  });

  it('does not admit bodyless, malformed, wrong-route, wrong-verb, or wrong-content traffic', async () => {
    const malformed = new Request('http://mcp-lab.invalid/mcp', {
      body: '{"broken":',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    for (const request of [
      new Request('http://mcp-lab.invalid/mcp', { method: 'GET' }),
      new Request('http://mcp-lab.invalid/mcp', { method: 'POST' }),
      malformed,
      mcpRequest(
        { id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} },
        {},
        'http://mcp-lab.invalid/other'
      ),
      mcpRequest(
        { id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} },
        {},
        'http://mcp-lab.invalid/mcp?query=1'
      ),
      new Request('http://mcp-lab.invalid/mcp', {
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
        headers: { 'content-type': 'text/plain' },
        method: 'POST',
      }),
    ]) {
      await expect(protocolCoordinate(request, 'legacy')).resolves.toBeUndefined();
    }
  });
});
