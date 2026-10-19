import { describe, expect, it } from 'vitest';
import { MEMORY_RECALL_TELEMETRY_TYPE, readMemoryRecallTelemetry } from '../tool-telemetry';

describe('readMemoryRecallTelemetry (BST-2225)', () => {
  const chunk = {
    latencyMs: 120,
    messages: 3,
    scope: 'resource',
    topK: 4,
    type: MEMORY_RECALL_TELEMETRY_TYPE,
  };

  it('reads a recall chunk, with or without its topK', () => {
    expect(readMemoryRecallTelemetry(chunk)).toEqual({
      latencyMs: 120,
      messages: 3,
      scope: 'resource',
      topK: 4,
    });
    const { topK: _topK, ...unconfigured } = chunk;
    expect(readMemoryRecallTelemetry({ ...unconfigured, scope: 'thread' })).toEqual({
      latencyMs: 120,
      messages: 3,
      scope: 'thread',
    });
  });

  it.each([
    ['another chunk type', { ...chunk, type: 'text-delta' }],
    ['a negative latency', { ...chunk, latencyMs: -1 }],
    ['a fractional message count', { ...chunk, messages: 1.5 }],
    ['an unknown scope', { ...chunk, scope: 'workspace' }],
    ['a zero topK', { ...chunk, topK: 0 }],
    ['no object', 'brainstrike.memory.recall'],
  ])('reads nothing from %s', (_label, value) => {
    expect(readMemoryRecallTelemetry(value)).toBeUndefined();
  });
});
