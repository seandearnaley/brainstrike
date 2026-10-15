import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('provider-factory built-in local provider', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * The built-in `local` provider is EMBEDDINGS-ONLY: its chat model (Gemma 4
   * E2B through transformers.js) was retired, so the registry has no default
   * model for it and the factory has nothing to construct.
   *
   * The refusal is the point. Nothing substitutes another engine, and nothing
   * returns a model that would fail on its first token instead.
   */
  it('refuses to build a chat model for the embeddings-only local provider', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    expect(() => createProvider('local')).toThrow(
      /No default model configured for provider: local/
    );
  });

  it('refuses from the broad package entrypoint too', async () => {
    const { createProvider } = await import('..');

    expect(() => createProvider('local')).toThrow(
      /No default model configured for provider: local/
    );
  });
});
