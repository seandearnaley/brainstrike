import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerInfoMock, registryStoreState } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  registryStoreState: {
    setDownloadProgress: vi.fn(),
    setDownloading: vi.fn(),
  },
}));

vi.mock('@brainstrike/preferences/stores/model-registry-store', () => ({
  useModelRegistryStore: {
    getState: () => registryStoreState,
  },
}));

vi.mock('@brainstrike/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logger')>(
    '@brainstrike/utils/logger'
  );
  return {
    ...actual,
    createLogger: () => ({
      info: loggerInfoMock,
    }),
  };
});

import { createEmbeddingWorkerConfig } from '../../../renderer/components/embedding-worker-config';

describe('createEmbeddingWorkerConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    import.meta.env['VITE_EMBED_CLAIM_BATCH_SIZE'] = '';
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '';
    import.meta.env['VITE_EMBED_INTER_BATCH_DELAY_MS'] = '';
    import.meta.env['VITE_EMBED_LEASE_MS'] = '';
    import.meta.env['VITE_EMBED_MODEL_KEY'] = '';
  });

  it('uses strict defaults when optional env vars are not configured', () => {
    const db = { query: vi.fn() };

    const config = createEmbeddingWorkerConfig(db as never);

    expect(config).toEqual({
      db,
      claimBatchSize: 1,
      concurrency: 1,
      interBatchDelayMs: 150,
      leaseMs: 60_000,
      log: expect.any(Function),
      onDownloadProgress: expect.any(Function),
    });
  });

  it('uses configured env vars and forwards logs and download progress updates', () => {
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '3';
    import.meta.env['VITE_EMBED_CLAIM_BATCH_SIZE'] = '4';
    import.meta.env['VITE_EMBED_INTER_BATCH_DELAY_MS'] = '75';
    import.meta.env['VITE_EMBED_LEASE_MS'] = '45000';
    import.meta.env['VITE_EMBED_MODEL_KEY'] = 'local:test-model';
    const db = { query: vi.fn() };

    const config = createEmbeddingWorkerConfig(db as never);

    expect(config).toMatchObject({
      db,
      claimBatchSize: 4,
      concurrency: 3,
      interBatchDelayMs: 75,
      leaseMs: 45_000,
      modelKey: 'local:test-model',
    });

    config.log?.('Worker started');
    config.log?.('Worker progress', { batch: 1 });
    config.onDownloadProgress?.('model-a', 40);
    config.onDownloadProgress?.('model-a', 100);

    expect(loggerInfoMock).toHaveBeenNthCalledWith(1, 'Worker started');
    expect(loggerInfoMock).toHaveBeenNthCalledWith(2, 'Worker progress', { batch: 1 });
    expect(registryStoreState.setDownloadProgress).toHaveBeenNthCalledWith(1, 'model-a', 40);
    expect(registryStoreState.setDownloading).toHaveBeenNthCalledWith(1, 'model-a', true);
    expect(registryStoreState.setDownloadProgress).toHaveBeenNthCalledWith(2, 'model-a', 100);
    expect(registryStoreState.setDownloading).toHaveBeenNthCalledWith(2, 'model-a', false);
  });

  it('fails fast when embed concurrency is not a positive integer', () => {
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '0';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_CONCURRENCY must be a positive integer when configured.'
    );
  });

  it('fails fast when embed claim batch size is not a positive integer', () => {
    import.meta.env['VITE_EMBED_CLAIM_BATCH_SIZE'] = '0';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_CLAIM_BATCH_SIZE must be a positive integer when configured.'
    );
  });

  it('fails fast when embed inter-batch delay is not a positive integer', () => {
    import.meta.env['VITE_EMBED_INTER_BATCH_DELAY_MS'] = 'abc';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_INTER_BATCH_DELAY_MS must be a positive integer when configured.'
    );
  });

  it('fails fast when embed lease duration is not a positive integer', () => {
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '';
    import.meta.env['VITE_EMBED_LEASE_MS'] = 'abc';

    expect(() => createEmbeddingWorkerConfig({} as never)).toThrow(
      'VITE_EMBED_LEASE_MS must be a positive integer when configured.'
    );
  });
});
