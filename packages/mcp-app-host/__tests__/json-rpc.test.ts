import { describe, expect, it } from 'vitest';
import { McpAppRequestCorrelator, parseMcpAppResponse } from '../src/index.js';
import { INITIALIZE_RESULT } from './frame-test-fixtures.js';

describe('bounded MCP Apps JSON-RPC responses', () => {
  it('rejects an empty ui/initialize result against the pinned canonical schema', () => {
    expect(() =>
      parseMcpAppResponse({ id: 'initialize', jsonrpc: '2.0', result: {} }, 'ui/initialize')
    ).toThrow(/ui\/initialize.*canonical result schema/);
  });

  it.each([
    ['ui/initialize', INITIALIZE_RESULT],
    ['ui/request-display-mode', { mode: 'fullscreen' }],
    ['resources/read', { contents: [] }],
    ['ui/update-model-context', {}],
  ] as const)('accepts the canonical result shape for %s', (method, result) => {
    expect(parseMcpAppResponse({ id: method, jsonrpc: '2.0', result }, method)).toEqual({
      id: method,
      jsonrpc: '2.0',
      result,
    });
  });

  it.each([
    ['ui/request-display-mode', {}],
    ['resources/read', {}],
    ['ui/update-model-context', { unexpected: true }],
    ['tools/call', { isError: 'yes' }],
  ] as const)('rejects a non-canonical result shape for %s', (method, result) => {
    expect(() => parseMcpAppResponse({ id: method, jsonrpc: '2.0', result }, method)).toThrow(
      /canonical result schema/
    );
  });

  it.each([
    { id: 1, jsonrpc: '2.0', result: {} },
    {
      error: { code: -32_000, data: { denied: true }, message: 'Denied' },
      id: 'request',
      jsonrpc: '2.0',
    },
  ])('accepts an exact success or error response', (response) => {
    expect(parseMcpAppResponse(response, 'ping')).toEqual(response);
  });

  it('preserves a null-id error response as JSON-RPC 2.0 requires, but never routes it', () => {
    // Review of #2914: §5 mandates `id: null` when the responder could not
    // read the request id. The payload is kept for diagnostics; the
    // correlator refuses to settle anything with it.
    const response = { error: { code: -32_700, message: 'Parse error' }, id: null, jsonrpc: '2.0' };
    expect(parseMcpAppResponse(response, 'ping')).toEqual(response);
    const correlation = new McpAppRequestCorrelator();
    correlation.register('r1', 'ping');
    expect(() => correlation.settle(response)).toThrow(/no routable id: -32700 Parse error/);
    expect(correlation.pendingCount).toBe(1);
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
    expect(() => parseMcpAppResponse(response, 'ping')).toThrow(/MCP Apps response/);
  });

  it('rejects deeply nested and oversized response payloads', () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 66; depth += 1) {
      nested = { nested };
    }
    expect(() => parseMcpAppResponse({ id: 1, jsonrpc: '2.0', result: nested }, 'ping')).toThrow(
      /maximum JSON depth/
    );
    expect(() =>
      parseMcpAppResponse({ id: 1, jsonrpc: '2.0', result: { text: 'x'.repeat(262_145) } }, 'ping')
    ).toThrow(/maximum encoded size/);
  });
});

describe('MCP Apps request correlation', () => {
  it('validates a response against the method it answers and consumes the slot either way', () => {
    // One request, one response (JSON-RPC 2.0): a reply that fails its
    // canonical result schema is still the reply, so the slot is released
    // rather than retained (review of #2914). A later well-formed answer to
    // the same id is a replay and is refused.
    const correlation = new McpAppRequestCorrelator();
    correlation.register('initialize', 'ui/initialize');
    expect(() => correlation.settle({ id: 'initialize', jsonrpc: '2.0', result: {} })).toThrow(
      /ui\/initialize.*canonical result schema/
    );
    expect(correlation.pendingCount).toBe(0);
    expect(() =>
      correlation.settle({ id: 'initialize', jsonrpc: '2.0', result: INITIALIZE_RESULT })
    ).toThrow(/not pending/);
    const fresh = new McpAppRequestCorrelator();
    fresh.register('initialize', 'ui/initialize');
    expect(
      fresh.settle({ id: 'initialize', jsonrpc: '2.0', result: INITIALIZE_RESULT })
    ).toMatchObject({ result: INITIALIZE_RESULT });
  });

  it('correlates type-distinct ids exactly once', () => {
    const correlation = new McpAppRequestCorrelator();
    correlation.register(1, 'ping');
    correlation.register('1', 'ping');
    expect(correlation.settle({ id: 1, jsonrpc: '2.0', result: {} }).id).toBe(1);
    expect(correlation.settle({ id: '1', jsonrpc: '2.0', result: {} }).id).toBe('1');
    expect(correlation.pendingCount).toBe(0);
  });

  it('rejects duplicate, unknown, and replayed ids', () => {
    const correlation = new McpAppRequestCorrelator();
    correlation.register('one', 'ping');
    expect(() => correlation.register('one', 'ping')).toThrow(/already pending/);
    expect(() => correlation.settle({ id: 'unknown', jsonrpc: '2.0', result: {} })).toThrow(
      /not pending/
    );
    correlation.settle({ id: 'one', jsonrpc: '2.0', result: {} });
    expect(() => correlation.register('one', 'ping')).toThrow(/already used/);
    expect(() => correlation.settle({ id: 'one', jsonrpc: '2.0', result: {} })).toThrow(
      /not pending/
    );

    const bounded = new McpAppRequestCorrelator();
    for (let id = 0; id < 256; id += 1) {
      bounded.register(id, 'ping');
    }
    expect(() => bounded.register(256, 'ping')).toThrow(/exceeds 256 entries/);
  });

  it('bounds replay memory to a recent-id ring instead of a session lifetime', () => {
    const correlation = new McpAppRequestCorrelator();
    for (let id = 0; id < 4097; id += 1) {
      correlation.register(id, 'ping');
      correlation.settle({ id, jsonrpc: '2.0', result: {} });
    }
    // The most recent ids are still refused as replays…
    expect(() => correlation.register(4096, 'ping')).toThrow(/already used/);
    expect(() => correlation.register(1, 'ping')).toThrow(/already used/);
    // …while the oldest has been evicted, so a long session never wedges.
    correlation.register(0, 'ping');
    expect(correlation.pendingCount).toBe(1);
  });

  it('releases the slot when the answer to a pending id fails validation', () => {
    // Review of #2914: a malformed reply used to leave its id pending forever,
    // so 256 bad answers wedged the channel for the life of the instance.
    const correlation = new McpAppRequestCorrelator();
    correlation.register('r1', 'ping');
    expect(() =>
      correlation.settle({ id: 'r1', jsonrpc: '2.0', result: { text: 'x'.repeat(262_145) } })
    ).toThrow(/maximum encoded size/);
    expect(correlation.pendingCount).toBe(0);
    // Ids are one-shot (BST-1570): the released id cannot be re-registered,
    // but a fresh id proves the slot itself was released.
    expect(() => correlation.register('r1', 'ping')).toThrow(/already used/);
    correlation.register('r2', 'ping');
    expect(() => correlation.settle({ id: 'r2', jsonrpc: '1.0', result: {} })).toThrow(/jsonrpc/);
    expect(correlation.pendingCount).toBe(0);
  });

  it('cancels one abandoned request and clears all on close', () => {
    const correlation = new McpAppRequestCorrelator();
    correlation.register(1, 'ping');
    correlation.register(2, 'ping');
    expect(correlation.cancel(1)).toBe(true);
    expect(correlation.cancel(1)).toBe(false);
    expect(correlation.pendingCount).toBe(1);
    correlation.clear();
    expect(correlation.pendingCount).toBe(0);
    expect(() => correlation.settle({ id: 2, jsonrpc: '2.0', result: {} })).toThrow(/not pending/);
  });
});
