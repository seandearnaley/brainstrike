import { describe, expect, it, vi } from 'vitest';

// The host must be able to report unavailable sandbox capabilities without
// loading the native runtime or the fence executor's Node-only dependencies.
vi.mock('@anthropic-ai/sandbox-runtime', () => {
  throw new Error('Code-execution diagnostics must not load sandbox-runtime.');
});
vi.mock('../fence/fence-executor', () => {
  throw new Error('Code-execution diagnostics must not load the fence executor.');
});

describe('runtime-free code-execution diagnostics', () => {
  it('exports readiness diagnostics without loading a sandbox backend', async () => {
    const { FenceReadinessError, isFenceReadinessError } = await import('../code-execution');
    const error = new FenceReadinessError(
      'sandbox_unsupported_runtime',
      'This host cannot provide the configured sandbox.'
    );

    expect(error).toMatchObject({
      code: 'fence_readiness_unavailable',
      reason: 'sandbox_unsupported_runtime',
    });
    expect(isFenceReadinessError(error)).toBe(true);
    // The host and tool may bundle this runtime-free diagnostic separately.
    expect(
      isFenceReadinessError(
        Object.assign(new Error('Missing packaged helper'), {
          code: 'fence_readiness_unavailable',
          reason: 'sandbox_dependencies_missing',
        })
      )
    ).toBe(true);
    expect(isFenceReadinessError(new Error('Unrelated failure'))).toBe(false);
  });
});
