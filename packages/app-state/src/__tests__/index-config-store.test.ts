import { BoundaryFailureError, fault } from '@brainstrike/assistant-contract/boundary-failure';
import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import { beforeEach, describe, expect, it } from 'vitest';
import { followIndexConfig, useIndexConfigStore } from '../stores/index-config-store';

function capability() {
  let listener: ((config: IndexConfig) => void) | undefined;
  let resolveRead: (config: IndexConfig) => void = () => {};
  let rejectRead: (error: Error) => void = () => {};
  return {
    capability: {
      onConfigChanged: (next: (config: IndexConfig) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      readConfig: () =>
        new Promise<IndexConfig>((resolve, reject) => {
          resolveRead = resolve;
          rejectRead = reject;
        }),
      updateConfig: async () => DEFAULT_INDEX_CONFIG,
    },
    publish: (config: IndexConfig) => listener?.(config),
    readFails: (error: Error) => rejectRead(error),
    readReturns: (config: IndexConfig) => resolveRead(config),
  };
}

describe('index config store', () => {
  beforeEach(() => useIndexConfigStore.setState({ state: { kind: 'loading' }, update: null }));

  it('shows Main’s config once read, then every change Main publishes', async () => {
    const main = capability();
    followIndexConfig(main.capability);
    expect(useIndexConfigStore.getState().state).toEqual({ kind: 'loading' });
    main.readReturns(DEFAULT_INDEX_CONFIG);
    await Promise.resolve();
    expect(useIndexConfigStore.getState().state).toEqual({
      config: DEFAULT_INDEX_CONFIG,
      kind: 'ready',
    });
    main.publish({ ...DEFAULT_INDEX_CONFIG, paused: true });
    expect(useIndexConfigStore.getState().state).toMatchObject({ config: { paused: true } });
  });

  it('never lets a late read replace a newer published change', async () => {
    const main = capability();
    followIndexConfig(main.capability);
    main.publish({ ...DEFAULT_INDEX_CONFIG, paused: true });
    main.readReturns(DEFAULT_INDEX_CONFIG);
    await Promise.resolve();
    expect(useIndexConfigStore.getState().state).toMatchObject({ config: { paused: true } });
  });

  it('shows the config Main returns to a later follow, never one an ended follow read', async () => {
    const first = capability();
    const stop = followIndexConfig(first.capability);
    first.readReturns(DEFAULT_INDEX_CONFIG);
    await Promise.resolve();
    stop();
    const second = capability();
    followIndexConfig(second.capability);
    second.readReturns({ ...DEFAULT_INDEX_CONFIG, mode: 'off' });
    await Promise.resolve();
    expect(useIndexConfigStore.getState().state).toMatchObject({ config: { mode: 'off' } });

    const ended = capability();
    followIndexConfig(ended.capability)();
    ended.readReturns({ ...DEFAULT_INDEX_CONFIG, policy: 'full-root' });
    await Promise.resolve();
    expect(useIndexConfigStore.getState().state).toMatchObject({
      config: { mode: 'off', policy: 'balanced' },
    });
  });

  it('shows why the config could not be read', async () => {
    const main = capability();
    followIndexConfig(main.capability);
    const failure = fault({
      category: 'internal',
      code: 'index-config.store-failed',
      correlationId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
      message: 'The search index settings could not be read.',
    });
    main.readFails(new BoundaryFailureError(failure));
    await Promise.resolve();
    await Promise.resolve();
    expect(useIndexConfigStore.getState().state).toEqual({
      failure,
      kind: 'failed',
      message:
        'The search index settings could not be read. Reference: 6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    });
  });
});
