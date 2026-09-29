import { describe, expect, it } from 'vitest';
import { createToolHistoryFilter } from '../mastra/runtime-assembly/tool-pipeline';
import { listProviders } from '../providers/types';

type HistoryFilterProvider = Parameters<typeof createToolHistoryFilter>[0];

/**
 * Pins isHostedProviderRuntime's registry derivation (PR #2513 review,
 * finding 4) through its exported seam: hosted/gateway providers get the
 * projection-safe history filter, local/browser runtimes do not, and an
 * out-of-registry id FAILS OPEN to the hosted default without throwing.
 */
describe('createToolHistoryFilter provider-runtime gate', () => {
  it('matches the registry runtime for every static provider', () => {
    for (const provider of listProviders()) {
      const filter = createToolHistoryFilter(provider.id, new Map());
      const hosted = provider.runtime === 'hosted' || provider.runtime === 'gateway';
      expect(filter !== undefined, `${provider.id} (${provider.runtime})`).toBe(hosted);
    }
  });

  it('fails open to the hosted path for an out-of-registry provider id', () => {
    const filter = createToolHistoryFilter(
      'not-a-registered-provider' as HistoryFilterProvider,
      new Map()
    );
    expect(filter).toBeDefined();
  });
});
