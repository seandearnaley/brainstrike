import { describe, expect, it } from 'vitest';

import { composeCacheAwareInstructions } from '../mastra/anthropic-instruction-cache';

describe('composeCacheAwareInstructions', () => {
  it('splits anthropic instructions into a cached stable block and an uncached volatile block', () => {
    const result = composeCacheAwareInstructions({
      provider: 'anthropic',
      stableText: 'You are the assistant.\nBudget note.',
      volatileText: 'Current task list:\n- [ ] item',
    });

    expect(result).toEqual([
      {
        content: 'You are the assistant.\nBudget note.',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        role: 'system',
      },
      {
        content: 'Current task list:\n- [ ] item',
        role: 'system',
      },
    ]);
  });

  it('emits a single cached system message for anthropic when there is no volatile block', () => {
    const result = composeCacheAwareInstructions({
      provider: 'anthropic',
      stableText: 'You are the assistant.',
      volatileText: null,
    });

    expect(result).toEqual([
      {
        content: 'You are the assistant.',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        role: 'system',
      },
    ]);
  });

  it('returns the plain joined string for non-anthropic providers (behavior unchanged)', () => {
    const result = composeCacheAwareInstructions({
      provider: 'openai',
      stableText: 'You are the assistant.',
      volatileText: 'Task note.',
    });

    expect(result).toBe('You are the assistant.\nTask note.');
  });

  it('returns the plain joined string for the local provider', () => {
    const result = composeCacheAwareInstructions({
      provider: 'local',
      stableText: 'Compact instructions.',
      volatileText: null,
    });

    expect(result).toBe('Compact instructions.');
  });

  it('degrades to the joined string for anthropic when the stable block is empty (nothing cacheable)', () => {
    const result = composeCacheAwareInstructions({
      provider: 'anthropic',
      stableText: '',
      volatileText: 'Task note.',
    });

    expect(result).toBe('Task note.');
  });
});
