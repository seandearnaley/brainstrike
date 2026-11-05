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
      component: 'observer',
      httpStatus: 401,
      modelId: 'openai::gpt-4.1-mini',
      step: 'observe',
    });
    expect(decode(failure)).toEqual(failure);
    expect(failure).toEqual({
      category: 'authorization',
      code: MEMORY_FAILURE_CODES.observer,
      kind: 'fault',
      message: 'Memory observe failed because its observer model (OpenAI gpt-4.1-mini) failed.',
      providerEvidence: 'OpenAI returned HTTP 401.',
      remedy:
        'Check the OpenAI API key in Settings → Providers, or choose another observer model in Settings → Assistant Memory.',
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
    expect(
      memoryComponentFailure({
        component: 'observer',
        httpStatus: 400,
        modelId: 'openai::m',
        step: 'save',
      }).category
    ).toBe('configuration');
  });

  it('keeps a producer’s model-safe classification and an unknown provider unnamed', () => {
    expect(
      memoryComponentFailure({
        component: 'observer',
        detail: 'The provider is rate limiting requests; try again later.',
        httpStatus: 429,
        modelId: 'openai::gpt-4.1-mini',
        step: 'observe',
      }).message
    ).toBe(
      'Memory observe failed because its observer model (OpenAI gpt-4.1-mini) failed: The provider is rate limiting requests; try again later.'
    );
    const unknown = memoryComponentFailure({
      component: 'observer',
      httpStatus: 401,
      modelId: 'fixture-observer-4',
      step: 'observe',
    });
    expect(unknown).toMatchObject({
      message: 'Memory observe failed because its observer model (fixture-observer-4) failed.',
      providerEvidence: 'The provider returned HTTP 401.',
      remedy:
        'Check the provider’s API key in Settings → Providers, or choose another observer model in Settings → Assistant Memory.',
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
