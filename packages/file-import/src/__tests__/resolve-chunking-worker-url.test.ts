import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerErrorMock = vi.hoisted(() => vi.fn());
const loggerDebugMock = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: () => ({
    debug: loggerDebugMock,
    error: loggerErrorMock,
  }),
}));

describe('resolveChunkingWorkerUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    loggerErrorMock.mockReset();
    loggerDebugMock.mockReset();
  });

  it('returns the workspace source worker URL', async () => {
    const { resolveChunkingWorkerUrl } = await import('../resolve-chunking-worker-url');
    const resolvedUrl = await resolveChunkingWorkerUrl();

    expect(resolvedUrl.href).toContain('chunking.worker.ts?worker_file&type=module');
    expect(loggerDebugMock).toHaveBeenCalledWith(
      'Resolved chunking worker URL from workspace source',
      {
        url: resolvedUrl.href,
      }
    );
  }, 15_000);

  it('fails fast with a descriptive error when worker URL resolution fails', async () => {
    const { resolveChunkingWorkerUrl } = await import('../resolve-chunking-worker-url');

    await expect(
      resolveChunkingWorkerUrl(() => {
        throw new Error('worker asset missing');
      })
    ).rejects.toThrow('Failed to resolve chunking worker URL');
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Failed to resolve chunking worker URL from workspace source',
      {
        error: expect.any(String),
      }
    );
  });
});
