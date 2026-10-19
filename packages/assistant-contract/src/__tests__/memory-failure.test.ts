import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { BoundaryFailureSchema } from '../boundary-failure';
import {
  MEMORY_FAILURE_CODES,
  memoryComponentFailure,
  memoryConfigurationFault,
} from '../memory-failure';

const decode = Schema.decodeUnknownSync(BoundaryFailureSchema, {
  errors: 'all',
  onExcessProperty: 'error',
});

describe('memory failure codes (BST-2202)', () => {
  it('names a memory model’s own provider and status, never the chat provider’s', () => {
    const failure = memoryComponentFailure({
      component: 'embedder',
      httpStatus: 401,
      modelId: 'openai::text-embedding-3-small',
      step: 'recall',
    });
    expect(decode(failure)).toEqual(failure);
    expect(failure).toEqual({
      category: 'authorization',
      code: MEMORY_FAILURE_CODES.embedder,
      kind: 'fault',
      message:
        'Memory recall failed because its embedding model (OpenAI text-embedding-3-small) failed.',
      providerEvidence: 'OpenAI returned HTTP 401.',
      remedy:
        'Check the OpenAI API key in Settings → Providers, or choose another embedding model in Settings → Assistant Memory.',
    });
  });

  it('types each memory part by its own code and the provider’s status by category', () => {
    expect(
      memoryComponentFailure({
        component: 'observer',
        httpStatus: 503,
        modelId: 'openai::gpt-4.1-mini',
        step: 'observe',
      })
    ).toMatchObject({
      category: 'availability',
      code: 'memory.observer-failed',
      message: 'Memory observe failed because its observer model (OpenAI gpt-4.1-mini) failed.',
      providerEvidence: 'OpenAI returned HTTP 503.',
      remedy: 'Retry, or review Settings → Assistant Memory.',
    });
    expect(
      memoryComponentFailure({
        component: 'reflector',
        modelId: 'google::gemini-3-flash',
        step: 'observe',
      })
    ).toMatchObject({
      category: 'availability',
      code: 'memory.observer-failed',
      message:
        'Memory observe failed because its reflector model (Google AI Studio gemini-3-flash) failed.',
    });
    const vector = memoryComponentFailure({ component: 'vector-store', step: 'save' });
    expect(vector).toEqual({
      category: 'internal',
      code: 'memory.vector-store-failed',
      kind: 'fault',
      message: 'Memory save failed because its vector store failed.',
    });
    expect(
      memoryComponentFailure({
        component: 'embedder',
        httpStatus: 400,
        modelId: 'openai::m',
        step: 'save',
      }).category
    ).toBe('configuration');
  });

  it('keeps a producer’s model-safe classification and an unknown provider unnamed', () => {
    expect(
      memoryComponentFailure({
        component: 'embedder',
        detail: 'Embedding provider openai is rate limiting requests; try again later.',
        httpStatus: 429,
        modelId: 'openai::text-embedding-3-small',
        step: 'recall',
      }).message
    ).toBe(
      'Memory recall failed because its embedding model (OpenAI text-embedding-3-small) failed: Embedding provider openai is rate limiting requests; try again later.'
    );
    const unknown = memoryComponentFailure({
      component: 'embedder',
      httpStatus: 401,
      modelId: 'fixture-embedder-4',
      step: 'recall',
    });
    expect(unknown).toMatchObject({
      message: 'Memory recall failed because its embedding model (fixture-embedder-4) failed.',
      providerEvidence: 'The provider returned HTTP 401.',
      remedy:
        'Check the provider’s API key in Settings → Providers, or choose another embedding model in Settings → Assistant Memory.',
    });
  });

  it('describes a configuration that cannot run as a configuration fault', () => {
    expect(memoryConfigurationFault()).toEqual({
      category: 'configuration',
      code: 'memory.configuration-invalid',
      kind: 'fault',
      message: 'Memory cannot run with this configuration.',
      remedy: 'Review Settings → Assistant Memory, then retry.',
    });
  });
});
