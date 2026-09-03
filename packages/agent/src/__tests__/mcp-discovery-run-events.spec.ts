import { describe, expect, it } from 'vitest';
import {
  boundMcpDiscoveryReason,
  MAX_MCP_DISCOVERY_REASON_CHARS,
  type McpDiscoverySkip,
  makeMcpDiscoverySkipChunks,
} from '../mastra/mcp-discovery-diagnostics';

describe('makeMcpDiscoverySkipChunks', () => {
  it('mints nothing when discovery was healthy', () => {
    expect(makeMcpDiscoverySkipChunks([])).toEqual([]);
  });

  it('mints ONE failed row for a client-wide skip, naming every server', () => {
    // One lost race is one fact. Fanning it out per server would report two
    // failures where one happened.
    const skip: McpDiscoverySkip = {
      reason: 'Connection closed',
      scope: 'client',
      serverNames: ['alpha', 'beta'],
      timeoutMs: 5000,
    };

    const chunks = makeMcpDiscoverySkipChunks([skip]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      event: {
        detail: 'alpha, beta skipped for this request — Connection closed',
        kind: 'mcp.tools.unavailable',
        label: 'MCP tools unavailable',
        metadata: {
          reason: 'Connection closed',
          scope: 'client',
          serverNames: ['alpha', 'beta'],
          timeoutMs: 5000,
        },
        status: 'failed',
      },
      type: 'run-event',
    });
  });

  it('mints one row per server-scope skip', () => {
    const chunks = makeMcpDiscoverySkipChunks([
      { reason: 'boom', scope: 'server', serverName: 'alpha', timeoutMs: 5000 },
      { reason: 'bang', scope: 'server', serverName: 'beta', timeoutMs: 5000 },
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      event: {
        detail: 'alpha skipped for this request — boom',
        kind: 'mcp.tools.unavailable',
        label: 'MCP server tools unavailable',
        metadata: { scope: 'server', serverName: 'alpha' },
        status: 'failed',
      },
    });
    expect(chunks[1]).toMatchObject({
      event: { detail: 'beta skipped for this request — bang' },
    });
  });

  it('never emits status running, so a row can never spin (pairing contract)', () => {
    // Pinned here as well as in the assistant-ui pairing contract, whose own
    // comment notes it can force a kind to be CLASSIFIED but cannot check the
    // classification against the emitter. This IS that check.
    const chunks = makeMcpDiscoverySkipChunks([
      { reason: 'boom', scope: 'server', serverName: 'alpha', timeoutMs: 5000 },
      { reason: 'bang', scope: 'client', serverNames: ['beta'], timeoutMs: 5000 },
    ]);

    for (const chunk of chunks) {
      expect(chunk).toMatchObject({ event: { status: 'failed' } });
    }
  });
});

describe('boundMcpDiscoveryReason', () => {
  it('strips credentials from a URL query string before persisting', () => {
    // Truncation is NOT redaction: this message is well under the bound, so a
    // length cap alone would persist the key verbatim into a durable,
    // always-visible row (PR #2938 review).
    const reason = boundMcpDiscoveryReason(
      new Error('fetch failed: 401 for https://host/mcp?api_key=SECRET123&x=1')
    );

    expect(reason).toBe('fetch failed: 401 for https://host/mcp?[redacted]');
    expect(reason).not.toContain('SECRET123');
  });

  it('strips credentials from URL userinfo', () => {
    const reason = boundMcpDiscoveryReason(new Error('connect https://alice:hunter2@host/mcp'));

    expect(reason).toBe('connect https://[redacted]@host/mcp');
    expect(reason).not.toContain('hunter2');
  });

  it('leaves an ordinary message with a question mark alone', () => {
    // The query-string rule is URL-anchored on purpose — a bare `?` in prose
    // must not be treated as credentials.
    expect(boundMcpDiscoveryReason(new Error('Connection closed. Did the server start?'))).toBe(
      'Connection closed. Did the server start?'
    );
  });

  it('bounds total length INCLUDING the ellipsis', () => {
    const reason = boundMcpDiscoveryReason(new Error('x'.repeat(500)));

    expect(Array.from(reason)).toHaveLength(MAX_MCP_DISCOVERY_REASON_CHARS);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair into a lone surrogate', () => {
    // `slice` cuts UTF-16 code units; an emoji straddling the bound would leave
    // half a pair in durable JSON.
    const reason = boundMcpDiscoveryReason(new Error('😀'.repeat(300)));

    expect(Array.from(reason)).toHaveLength(MAX_MCP_DISCOVERY_REASON_CHARS);
    expect(reason.isWellFormed()).toBe(true);
  });
});
