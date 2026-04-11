import { describe, expect, it } from 'vitest';

describe('agent entrypoints', () => {
  it('keeps the client entrypoint free of the local llm backend export', async () => {
    const clientModule = await import('../client');

    expect('LocalLlmBackend' in clientModule).toBe(false);
  });

  it('exports the local llm backend from the dedicated local-llm entrypoint', async () => {
    const localLlmModule = await import('../local-llm');

    expect(typeof localLlmModule.LocalLlmBackend).toBe('function');
  });
});
