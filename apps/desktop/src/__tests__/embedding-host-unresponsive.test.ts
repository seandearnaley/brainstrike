// @vitest-environment node

import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { canonicalError, canonicalFault } from '../canonical-utility-protocol';
import {
  EMBEDDING_HOST_UNRESPONSIVE_CODE,
  embeddingHostUnresponsiveError,
  findEmbeddingHostUnresponsive,
} from '../embedding-host-unresponsive';

const WINDOW_MS = 60_000;

describe('an unresponsive embedding host (BST-2104)', () => {
  it.each([
    {
      lastProgress: undefined,
      message:
        'The embedding model stopped responding before it started on a batch. It sent no progress for 1 min (1 min after the batch started).',
    },
    {
      lastProgress: { stage: 'setup' as const },
      message:
        'The embedding model stopped responding while it was loading. It sent no progress for 1 min (3 min 12 s after the batch started).',
    },
    {
      lastProgress: { completed: 12, stage: 'inference' as const },
      message:
        'The embedding model stopped responding after 12 of 64 chunks in a batch. It sent no progress for 1 min (3 min 12 s after the batch started).',
    },
  ])(
    'names the stage and the elapsed time in plain words: $message',
    ({ lastProgress, message }) => {
      const error = embeddingHostUnresponsiveError({
        elapsedMs: lastProgress === undefined ? WINDOW_MS : 192_000,
        lastProgress,
        texts: 64,
        windowMs: WINDOW_MS,
      });
      expect(error.failure).toEqual({
        category: 'availability',
        code: EMBEDDING_HOST_UNRESPONSIVE_CODE,
        // A refusal: only a person's Retry indexing recovers it, never an automatic re-open.
        kind: 'refusal',
        message,
        remedy: 'Retry indexing restarts the embedding model and resumes indexing.',
      });
      expect(error.message).toBe(message);
    }
  );

  it('is found however retirement and ingestion wrap it, and survives the utility boundary', () => {
    const unresponsive = embeddingHostUnresponsiveError({
      elapsedMs: WINDOW_MS,
      lastProgress: { stage: 'setup' },
      texts: 1,
      windowMs: WINDOW_MS,
    });
    const wrapped = new AggregateError(
      [
        new AggregateError(
          [unresponsive, new Error('stop failed')],
          'Document embedding interruption required failed host retirement.'
        ),
      ],
      'Canonical inference and retirement failed.',
      { cause: new Error('scan aborted') }
    );
    expect(findEmbeddingHostUnresponsive(wrapped)).toBe(unresponsive);
    expect(findEmbeddingHostUnresponsive(new Error('outer', { cause: unresponsive }))).toBe(
      unresponsive
    );

    const received = findEmbeddingHostUnresponsive(canonicalError(canonicalFault(wrapped)));
    expect(received).toBeInstanceOf(BoundaryFailureError);
    expect(received?.failure).toEqual(unresponsive.failure);
  });

  it('is not found in other failures', () => {
    const cycle = new Error('cycle');
    Object.assign(cycle, { cause: cycle });
    expect(findEmbeddingHostUnresponsive(new Error('Workspace walk failed.'))).toBeUndefined();
    expect(findEmbeddingHostUnresponsive(cycle)).toBeUndefined();
    expect(findEmbeddingHostUnresponsive('timed out')).toBeUndefined();
  });
});
