import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('provider-factory embeddings-only providers', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * An EMBEDDINGS-ONLY provider has no chat model for the factory to construct.
   *
   * The refusal is the point, and it is DERIVED from `capabilities.llm` rather
   * than branching on the provider id — so cohere and voyage refuse the same
   * way. Nothing substitutes another engine, and nothing returns a model that
   * would fail on its first token instead.
   */
  it.each(['cohere', 'voyage'] as const)(
    'refuses to build a chat model for %s',
    async (provider) => {
      const { createProvider } = await import('../providers/provider-factory');

      expect(() => createProvider(provider)).toThrow(
        new RegExp(`Provider ${provider} serves embeddings only`)
      );
    }
  );

  it('refuses from the broad package entrypoint too', async () => {
    const { createProvider } = await import('..');

    expect(() => createProvider('cohere')).toThrow(/serves embeddings only/);
  });
});
