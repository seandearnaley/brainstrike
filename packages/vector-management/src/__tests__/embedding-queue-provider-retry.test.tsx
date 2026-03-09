import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../embedding-queue-provider');

import {
  EmbeddingQueueProvider,
  setBrowserEmbeddingQueueLoaderForTests,
  useEmbeddingQueueSafe,
} from '../embedding-queue-provider';

function createQueueAdapter(): QueueAdapter {
  const queueResult: QueueResult = {
    type: 'result',
    id: 'test-result',
    vectors: [],
    metadata: {
      model: 'test-model',
      device: 'wasm',
      dtype: 'fp16',
      batchSize: 0,
      elapsedMs: 0,
      fallbackApplied: false,
      dimensions: 0,
    },
  };

  return {
    add: async () => queueResult,
    addBulk: async () => [queueResult],
    cancel: async () => {},
    drain: async () => {},
    onProgress: () => () => {},
    pause: () => {},
    resume: () => {},
    isPaused: false,
    isProcessing: false,
  };
}

describe('EmbeddingQueueProvider retry behavior', () => {
  afterEach(() => {
    setBrowserEmbeddingQueueLoaderForTests(null);
  });

  it('retries browser queue creation after an initial rejection', async () => {
    const queue = createQueueAdapter();
    let createAttempts = 0;

    setBrowserEmbeddingQueueLoaderForTests(async () => {
      createAttempts += 1;
      if (createAttempts === 1) {
        throw new Error('queue boot failed');
      }
      return queue;
    });

    function Harness(): ReactNode {
      const context = useEmbeddingQueueSafe();
      return <div data-testid="queue-state">{context ? 'ready' : 'missing'}</div>;
    }

    const firstView = render(
      <EmbeddingQueueProvider>
        <Harness />
      </EmbeddingQueueProvider>
    );

    await waitFor(() => {
      expect(createAttempts).toBe(1);
      expect(screen.getByTestId('queue-state').textContent).toBe('missing');
    });
    firstView.unmount();

    render(
      <EmbeddingQueueProvider>
        <Harness />
      </EmbeddingQueueProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('queue-state').textContent).toBe('ready');
    });
    expect(createAttempts).toBe(2);
  });
});
