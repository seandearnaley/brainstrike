import { describe, expect, it } from 'vitest';
import { mapRunLedgerRow } from '../assistant-memory-repository';

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    billedCostUsd: null,
    completedAt: '2026-07-16T10:01:30.000Z',
    durationMs: '90000',
    editCount: '2',
    estimatedInputTokens: '0',
    estimatedOutputTokens: '0',
    failedToolCallCount: '1',
    inputTokens: '1400',
    model: 'claude-sonnet-5',
    outcomeDetail: null,
    outcomeSource: null,
    outcomeVerdict: null,
    outputTokens: '300',
    provider: 'anthropic',
    revertedEditCount: '1',
    runId: 'run-1',
    startedAt: '2026-07-16T10:00:00.000Z',
    status: 'completed',
    threadId: 'thread-1',
    toolCallCount: '3',
    ...overrides,
  };
}

describe('mapRunLedgerRow', () => {
  it('maps a well-formed row, coercing bigint-as-string aggregates', () => {
    const row = mapRunLedgerRow(baseRow());
    expect(row).toMatchObject({
      durationMs: 90_000,
      editCount: 2,
      failedToolCallCount: 1,
      inputTokens: 1400,
      model: 'claude-sonnet-5',
      outcomeSource: null,
      outcomeVerdict: null,
      outputTokens: 300,
      provider: 'anthropic',
      revertedEditCount: 1,
      runId: 'run-1',
      status: 'completed',
      threadId: 'thread-1',
      toolCallCount: 3,
    });
    expect(row.startedAt.toISOString()).toBe('2026-07-16T10:00:00.000Z');
    expect(row.completedAt?.toISOString()).toBe('2026-07-16T10:01:30.000Z');
    expect(row.billedCostUsd).toBeUndefined();
  });

  it('keeps durationMs/completedAt null for a still-open run', () => {
    const row = mapRunLedgerRow(baseRow({ completedAt: null, durationMs: null }));
    expect(row.completedAt).toBeNull();
    expect(row.durationMs).toBeNull();
  });

  it('carries an exact billed cost through when present', () => {
    expect(mapRunLedgerRow(baseRow({ billedCostUsd: '0.5' })).billedCostUsd).toBe(0.5);
  });

  it('carries the unreported-token remainder so partial exact costs stay honest', () => {
    const row = mapRunLedgerRow(
      baseRow({ billedCostUsd: '0.5', estimatedInputTokens: '400', estimatedOutputTokens: '100' })
    );
    expect(row.billedCostUsd).toBe(0.5);
    expect(row.estimatedInputTokens).toBe(400);
    expect(row.estimatedOutputTokens).toBe(100);
  });

  it('maps known outcome labels', () => {
    const row = mapRunLedgerRow(
      baseRow({ outcomeDetail: 'tests failed', outcomeSource: 'hook', outcomeVerdict: 'failed' })
    );
    expect(row.outcomeVerdict).toBe('failed');
    expect(row.outcomeSource).toBe('hook');
    expect(row.outcomeDetail).toBe('tests failed');
  });

  it('throws on an unknown verdict instead of coercing it', () => {
    expect(() => mapRunLedgerRow(baseRow({ outcomeVerdict: 'sorta' }))).toThrow(
      /invalid run outcome verdict/i
    );
  });

  it('throws on an unknown source instead of coercing it', () => {
    expect(() => mapRunLedgerRow(baseRow({ outcomeSource: 'vibes' }))).toThrow(
      /invalid run outcome source/i
    );
  });

  it('throws on negative aggregates instead of fabricating zeros', () => {
    expect(() => mapRunLedgerRow(baseRow({ toolCallCount: '-1' }))).toThrow();
    expect(() => mapRunLedgerRow(baseRow({ inputTokens: -5 }))).toThrow();
  });

  it('throws on a malformed run status', () => {
    expect(() => mapRunLedgerRow(baseRow({ status: 'exploded' }))).toThrow();
  });

  it('throws on an unparseable timestamp', () => {
    expect(() => mapRunLedgerRow(baseRow({ startedAt: 'not-a-date' }))).toThrow(
      /invalid timestamp/i
    );
  });
});
