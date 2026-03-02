import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: loggerErrorMock,
  }),
}));

describe('resolveChunkingWorkerUrl', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@brainstrike/chunking-worker');
    loggerErrorMock.mockReset();
  });

  it('returns the URL resolved by @brainstrike/chunking-worker', async () => {
    const expectedUrl = new URL('file:///tmp/chunking.worker.js');

    vi.doMock('@brainstrike/chunking-worker', () => ({
      resolveChunkingWorkerUrl: () => expectedUrl,
    }));

    const { resolveChunkingWorkerUrl } = await import('../resolve-chunking-worker-url');
    await expect(resolveChunkingWorkerUrl()).resolves.toBe(expectedUrl);
  });

  it('fails fast with a descriptive error when worker package import fails', async () => {
    vi.doMock('@brainstrike/chunking-worker', () => {
      throw new Error('module load failed');
    });

    const { resolveChunkingWorkerUrl } = await import('../resolve-chunking-worker-url');

    await expect(resolveChunkingWorkerUrl()).rejects.toThrow(
      'Failed to resolve chunking worker URL'
    );
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith('Failed to import @brainstrike/chunking-worker', {
      error: expect.any(String),
    });
  });
});
