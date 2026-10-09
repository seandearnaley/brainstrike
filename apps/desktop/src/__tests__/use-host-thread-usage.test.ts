import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { EMPTY_THREAD_CUMULATIVE_USAGE_DISPLAY } from '@brainstrike/assistant-data';
import richRecording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json';
import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { HostThreadLedger } from '../renderer/host-thread-ledger';
import { useHostThreadUsage } from '../renderer/use-host-thread-usage';

// Two recorded runs of two model steps each (1 input / 25 output per step).
// The runtime shape commits a time on every row and a provider::model run model.
const BASE = Date.parse('2026-10-08T12:00:00Z');
function recordedRows(modelId: string) {
  return richRecording.map((raw) => {
    const row = HostLogRowSchema.parse(raw);
    const event = row.event.type === 'run.started' ? { ...row.event, modelId } : row.event;
    return { ...row, event, ts: BASE + row.seq * 1000 };
  });
}
const rows = recordedRows('openrouter::anthropic/claude-sonnet-4.6');
const threadId = rows[0]?.threadId ?? '';
const firstStart = rows.findIndex((row) => row.event.type === 'run.started');

test("the meter's thread total follows the committed log, priced at the catalog rate", () => {
  const ledger = new HostThreadLedger();
  const { result } = renderHook(() => useHostThreadUsage(ledger, threadId));
  // Not folded yet: no thread total, so the meter keeps its context fraction.
  expect(result.current).toBeUndefined();
  act(() => ledger.accept(threadId, rows.slice(0, firstStart + 1)));
  // Folded with no provider call: the honest zero baseline.
  expect(result.current).toBe(EMPTY_THREAD_CUMULATIVE_USAGE_DISPLAY);
  act(() => ledger.accept(threadId, rows));
  // 4 input and 100 output tokens at the catalog's $3 / $15 per million.
  expect(result.current).toEqual({
    bySource: [{ estimated: false, inputTokens: 4, kind: 'chat', outputTokens: 100 }],
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cost: { available: true, provenance: 'captured-usage-estimate', usdAmount: 0.001_512 },
    inputTokens: 4,
    outputTokens: 100,
    totalTokens: 104,
  });
});

test('a model without a catalog rate shows its tokens and no cost', () => {
  const ledger = new HostThreadLedger();
  const unpriced = recordedRows('openrouter::example/unlisted-model');
  ledger.accept(threadId, unpriced);
  const { result } = renderHook(() => useHostThreadUsage(ledger, threadId));
  expect(result.current).toMatchObject({
    cost: { available: false, reason: 'unpriced_model' },
    totalTokens: 104,
  });
});
