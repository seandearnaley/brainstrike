import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmbeddingService } from '../use-embedding-service';

const disposeMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@brainstrike/embeddings', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/embeddings')>('@brainstrike/embeddings');
  return {
    ...actual,
    SimpleEmbeddingService: vi.fn().mockImplementation(() => ({ dispose: disposeMock })),
  };
});

describe('useEmbeddingService', () => {
  beforeEach(() => {
    disposeMock.mockClear();
  });
  it('creates and disposes the embedding service when enabled', async () => {
    const { result, rerender } = renderHook(
      ({ enable }: { enable: boolean }) =>
        useEmbeddingService({ enableEmbedding: enable, model: 'model' }),
      {
        initialProps: { enable: true },
      }
    );

    expect(result.current.service).not.toBeNull();

    await act(async () => {
      await result.current.dispose();
    });

    expect(disposeMock).toHaveBeenCalled();
    expect(result.current.service).toBeNull();

    rerender({ enable: false });
    expect(result.current.service).toBeNull();
  });

  it('does not instantiate the service without a model', () => {
    const { result } = renderHook(() =>
      useEmbeddingService({ enableEmbedding: true, model: null })
    );

    expect(result.current.service).toBeNull();
  });
});
