import { describe, expect, it } from 'vitest';
import {
  type McpDiscoverySkip,
  makeMcpDiscoverySkipChunks,
  prependMcpDiscoverySkipChunks,
} from '../mastra/mcp-discovery-diagnostics';
import type { StreamChunk } from '../types';

async function* oneFinishChunk(): AsyncIterableIterator<StreamChunk> {
  yield {
    finishReason: 'stop',
    path: [],
    type: 'message-finish',
    usage: { completionTokens: 0, promptTokens: 0 },
  } as StreamChunk;
}

async function collect(stream: AsyncIterableIterator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

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

describe('prependMcpDiscoverySkipChunks', () => {
  it('prepends the skip rows ahead of the turn stream', async () => {
    const chunks = await collect(
      prependMcpDiscoverySkipChunks(
        [{ reason: 'boom', scope: 'server', serverName: 'alpha', timeoutMs: 5000 }],
        oneFinishChunk()
      )
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ type: 'run-event' });
    expect(chunks[1]).toMatchObject({ type: 'message-finish' });
  });

  it('passes the turn stream through untouched when there are no skips', async () => {
    const chunks = await collect(prependMcpDiscoverySkipChunks([], oneFinishChunk()));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'message-finish' });
  });
});
