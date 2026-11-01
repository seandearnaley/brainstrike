import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAssistantDetailLevel } from '../assistant-detail-level-store.ts';
import type { OmMeterState } from '../context-usage-meter';
import { ContextUsagePopoverContent } from '../context-usage-popover';

const OBSERVED_AT = Date.UTC(2026, 9, 18, 21, 30, 5);
const BUFFERED_AT = Date.UTC(2026, 9, 18, 21, 31, 0);
const READ_AT = Date.UTC(2026, 9, 18, 21, 31, 30);
const MODELS = {
  embedder: {
    dimensions: 1536,
    distance: 'cosine',
    modelId: 'text-embedding-3-small',
    provider: 'openai',
  },
  observer: 'openai::gpt-5-mini',
} as const;
const LIVE: OmMeterState = {
  bufferedObservationTokens: 120,
  compactionSavedTokens: 5000,
  kind: 'stats',
  lifecycle: {
    generationCount: 2,
    isBufferingObservation: true,
    isBufferingReflection: false,
    isObserving: false,
    isReflecting: true,
    lastBufferedAtTime: BUFFERED_AT,
    lastObservedAt: OBSERVED_AT,
    originType: 'reflection',
    reflectionTokenThreshold: 40_000,
  },
  messageTokenThreshold: 30_000,
  models: MODELS,
  observationTokens: 900,
  pendingMessageTokens: 4000,
  readAt: READ_AT,
};

function popover(omSegment: OmMeterState) {
  return render(
    <ContextUsagePopoverContent
      contextWindow={200_000}
      effectiveInputBudget={126_000}
      isEstimated={false}
      omSegment={omSegment}
      percentage={10}
      usedTokens={12_600}
    />
  );
}

function row(name: string): HTMLElement {
  return screen.getByTestId(`context-usage-memory-${name}`);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('the memory note at every detail level', () => {
  it('names why observations are unavailable instead of dropping the reason', () => {
    popover({ code: 'boundary.internal', kind: 'error', reason: 'The state store is closed.' });
    expect(screen.getByTestId('context-usage-om-note')).toHaveTextContent(
      'Observations unavailable: The state store is closed.'
    );
    // The panel is Developer-only.
    expect(screen.queryByTestId('context-usage-memory-panel')).not.toBeInTheDocument();
  });
});

describe('the Developer memory panel', () => {
  beforeEach(() => {
    setAssistantDetailLevel('developer');
  });

  it('shows the live flags, last observation and reflection, both thresholds and the models', () => {
    popover(LIVE);
    const panel = screen.getByTestId('context-usage-memory-panel');
    expect(within(panel).getByRole('heading', { name: 'Memory' })).toBeInTheDocument();
    expect(row('live')).toHaveTextContent('Reflecting · Buffering observation');
    const observed = within(row('last-observed')).getByText(
      (_, element) => element?.tagName === 'TIME'
    );
    expect(observed).toHaveAttribute('datetime', new Date(OBSERVED_AT).toISOString());
    expect(
      within(row('last-buffered')).getByText((_, element) => element?.tagName === 'TIME')
    ).toHaveAttribute('datetime', new Date(BUFFERED_AT).toISOString());
    expect(row('generation')).toHaveTextContent('2 (from a reflection)');
    expect(row('observe-threshold')).toHaveTextContent('4,000 / 30,000 message tokens');
    expect(row('reflect-threshold')).toHaveTextContent('900 / 40,000 observation tokens');
    expect(row('observer')).toHaveTextContent('openai::gpt-5-mini');
    expect(row('embedder')).toHaveTextContent(
      'openai · text-embedding-3-small · 1,536 dims · cosine'
    );
    expect(screen.queryByTestId('context-usage-memory-error')).not.toBeInTheDocument();
    // The flags are the record's as of this read.
    expect(
      within(row('read-at')).getByText((_, element) => element?.tagName === 'TIME')
    ).toHaveAttribute('datetime', new Date(READ_AT).toISOString());
  });

  it('says idle, never observed and the first generation for a fresh record', () => {
    if (LIVE.kind !== 'stats' || !LIVE.lifecycle) {
      throw new Error('LIVE is a stats segment with a lifecycle');
    }
    popover({
      ...LIVE,
      lifecycle: {
        ...LIVE.lifecycle,
        generationCount: 0,
        isBufferingObservation: false,
        isReflecting: false,
        lastBufferedAtTime: null,
        lastObservedAt: null,
        originType: 'initial',
      },
    });
    expect(row('live')).toHaveTextContent('Idle');
    expect(row('last-observed')).toHaveTextContent('Never');
    expect(row('last-buffered')).toHaveTextContent('Never');
    expect(row('generation')).toHaveTextContent('0 (initial)');
  });

  it('shows a read failure’s reason with its code', () => {
    popover({
      code: 'memory.credential-missing',
      kind: 'error',
      reason: 'The OpenAI memory embedder has no API key.',
    });
    expect(row('error')).toHaveTextContent('The OpenAI memory embedder has no API key.');
    expect(row('error-code')).toHaveTextContent('memory.credential-missing');
  });

  it('labels what the host did not report rather than inventing it', () => {
    popover({
      bufferedObservationTokens: 0,
      compactionSavedTokens: 0,
      kind: 'stats',
      messageTokenThreshold: 30_000,
      observationTokens: 0,
      pendingMessageTokens: 10,
    });
    expect(row('lifecycle')).toHaveTextContent('Not reported by this host');
    expect(row('observer')).toHaveTextContent('Not reported by this host');
    expect(row('embedder')).toHaveTextContent('Not reported by this host');
  });

  it('shows the last observation and reflection cycle, a failed one with its code and reference (BST-2224)', () => {
    const CYCLE_AT = Date.UTC(2026, 9, 19, 9, 0, 0);
    popover({
      ...LIVE,
      cycles: {
        observation: {
          at: CYCLE_AT,
          durationMs: 3200,
          failure: {
            code: 'memory.observer-failed',
            correlationId: '0b6a1f4e-6f1c-4d4b-9a51-2f0f6e0b9c11',
          },
          outcome: 'failed',
          trigger: 'async-buffer',
        },
        reflection: {
          durationMs: 900,
          outcome: 'completed',
          trigger: 'turn-sync',
          usage: { inputTokens: 4210, outputTokens: 312, totalTokens: 4522 },
        },
      },
    });
    const observation = row('last-observation-cycle');
    expect(observation).toHaveTextContent(
      'Failed · async-buffer · 3.2 s · memory.observer-failed · Reference: 0b6a1f4e-6f1c-4d4b-9a51-2f0f6e0b9c11'
    );
    expect(
      within(observation).getByText((_, element) => element?.tagName === 'TIME')
    ).toHaveAttribute('datetime', new Date(CYCLE_AT).toISOString());
    expect(row('last-reflection-cycle')).toHaveTextContent(
      'Completed · turn-sync · 0.9 s · 4,210 in / 312 out'
    );
  });

  it('shows the last recall this view saw live, and none before one (BST-2225)', () => {
    const RECALLED_AT = Date.UTC(2026, 9, 19, 10, 0, 0);
    const { unmount } = popover(LIVE);
    expect(screen.queryByTestId('context-usage-memory-last-recall')).toBeNull();
    unmount();
    popover({
      ...LIVE,
      recall: { at: RECALLED_AT, latencyMs: 1240, messages: 6, scope: 'resource', topK: 4 },
    });
    const recall = row('last-recall');
    expect(recall).toHaveTextContent('Last recall (live)');
    expect(recall).toHaveTextContent('6 messages · top 4 · all threads · 1,240 ms');
    expect(within(recall).getByText((_, element) => element?.tagName === 'TIME')).toHaveAttribute(
      'datetime',
      new Date(RECALLED_AT).toISOString()
    );
  });

  it('keeps the last live recall beside a failed read', () => {
    popover({
      code: 'memory.embedder-failed',
      kind: 'error',
      reason: 'Memory recall failed because its embedding model failed.',
      recall: {
        at: Date.UTC(2026, 9, 19, 10, 0, 0),
        latencyMs: 90,
        messages: 1,
        scope: 'thread',
      },
    });
    expect(row('last-recall')).toHaveTextContent('1 message · this thread · 90 ms');
  });

  it('shows no cycle rows before the thread’s first cycle', () => {
    popover(LIVE);
    expect(screen.queryByTestId('context-usage-memory-last-observation-cycle')).toBeNull();
    expect(screen.queryByTestId('context-usage-memory-last-reflection-cycle')).toBeNull();
  });

  it('shows the last failed cycle beside a failed read', () => {
    popover({
      code: 'memory.observer-failed',
      cycles: {
        observation: {
          failure: { code: 'memory.observer-failed' },
          outcome: 'failed',
          trigger: 'turn-sync',
        },
      },
      kind: 'error',
      reason: 'Memory observe failed because its observer model failed.',
    });
    expect(row('last-observation-cycle')).toHaveTextContent(
      'Failed · turn-sync · memory.observer-failed'
    );
  });

  it('names a waiting observer’s reason, and recall’s embedder while observations are off', () => {
    const { unmount } = popover({
      kind: 'awaiting-observer',
      models: {},
      reason: 'model-not-eligible',
    });
    expect(row('observer')).toHaveTextContent('Waiting (model-not-eligible)');
    expect(row('embedder')).toHaveTextContent('Off');
    unmount();
    popover({ kind: 'inactive', models: { embedder: MODELS.embedder } });
    expect(row('observer')).toHaveTextContent('Off');
    expect(row('embedder')).toHaveTextContent('openai · text-embedding-3-small');
  });
});
