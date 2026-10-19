import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
  AssistantDetailLevelProvider,
} from '../assistant-detail-level-context';
import type { OmMeterState } from '../context-usage-meter';
import { ContextUsagePopoverContent } from '../context-usage-popover';

const OBSERVED_AT = Date.UTC(2026, 9, 18, 21, 30, 5);
const BUFFERED_AT = Date.UTC(2026, 9, 18, 21, 31, 0);
const READ_AT = Date.UTC(2026, 9, 18, 21, 31, 30);
const MODELS = {
  embedder: {
    dimensions: 384,
    distance: 'cosine',
    dtype: 'fp16',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    provider: 'local',
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
    <AssistantDetailLevelProvider>
      <ContextUsagePopoverContent
        contextWindow={200_000}
        effectiveInputBudget={126_000}
        isEstimated={false}
        omSegment={omSegment}
        percentage={10}
        usedTokens={12_600}
      />
    </AssistantDetailLevelProvider>
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
    window.localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, 'developer');
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
      'local · Xenova/all-MiniLM-L6-v2 · 384 dims · cosine · fp16'
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
      code: 'memory.embedder-device-unavailable',
      kind: 'error',
      reason: 'The on-device memory embedder has no execution device.',
    });
    expect(row('error')).toHaveTextContent(
      'The on-device memory embedder has no execution device.'
    );
    expect(row('error-code')).toHaveTextContent('memory.embedder-device-unavailable');
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
    expect(row('embedder')).toHaveTextContent('local · Xenova/all-MiniLM-L6-v2');
  });
});
