import { describe, expect, it } from 'vitest';
import { McpAppRequestCorrelator, parseMcpAppResponse } from '../src/index.js';

describe('bounded MCP Apps JSON-RPC responses', () => {
  it.each([
    { id: 1, jsonrpc: '2.0', result: {} },
    {
      error: { code: -32_000, data: { denied: true }, message: 'Denied' },
      id: 'request',
      jsonrpc: '2.0',
    },
  ])('accepts an exact success or error response', (response) => {
    expect(parseMcpAppResponse(response)).toEqual(response);
  });

  it.each([
    { id: null, jsonrpc: '2.0', result: {} },
    { id: 1.5, jsonrpc: '2.0', result: {} },
    { error: { code: -1, message: 'both' }, id: 1, jsonrpc: '2.0', result: [] },
    { id: 1, jsonrpc: '2.0', result: [] },
    { error: { code: 1.5, message: 'fractional' }, id: 1, jsonrpc: '2.0' },
    { error: { code: -1, message: 42 }, id: 1, jsonrpc: '2.0' },
    { error: { code: -1, extra: true, message: 'bad' }, id: 1, jsonrpc: '2.0' },
  ])('rejects malformed response envelopes: %j', (response) => {
    expect(() => parseMcpAppResponse(response)).toThrow(/MCP Apps response/);
  });

  it('rejects deeply nested and oversized response payloads', () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 66; depth += 1) {
      nested = { nested };
    }
    expect(() => parseMcpAppResponse({ id: 1, jsonrpc: '2.0', result: nested })).toThrow(
      /maximum JSON depth/
    );
    expect(() =>
      parseMcpAppResponse({ id: 1, jsonrpc: '2.0', result: { text: 'x'.repeat(262_145) } })
    ).toThrow(/maximum encoded size/);
  });
});

describe('MCP Apps request correlation', () => {
  it('correlates type-distinct ids exactly once', () => {
    const correlation = new McpAppRequestCorrelator();
    correlation.register(1);
    correlation.register('1');
    expect(correlation.settle({ id: 1, jsonrpc: '2.0', result: {} }).id).toBe(1);
    expect(correlation.settle({ id: '1', jsonrpc: '2.0', result: {} }).id).toBe('1');
    expect(correlation.pendingCount).toBe(0);
  });

  it('rejects duplicate, unknown, and replayed ids', () => {
    const correlation = new McpAppRequestCorrelator();
    correlation.register('one');
    expect(() => correlation.register('one')).toThrow(/already pending/);
    expect(() => correlation.settle({ id: 'unknown', jsonrpc: '2.0', result: {} })).toThrow(
      /not pending/
    );
    correlation.settle({ id: 'one', jsonrpc: '2.0', result: {} });
    expect(() => correlation.settle({ id: 'one', jsonrpc: '2.0', result: {} })).toThrow(
      /not pending/
    );

    const bounded = new McpAppRequestCorrelator();
    for (let id = 0; id < 256; id += 1) {
      bounded.register(id);
    }
    expect(() => bounded.register(256)).toThrow(/exceeds 256 entries/);
  });
});
