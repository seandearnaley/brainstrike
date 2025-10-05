import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseEmbeddingServiceOptions {
  enableEmbedding: boolean;
  model: string | null;
}

export interface UseEmbeddingServiceResult {
  service: SimpleEmbeddingService | null;
  dispose: () => Promise<void>;
}

export function useEmbeddingService({
  enableEmbedding,
  model,
}: UseEmbeddingServiceOptions): UseEmbeddingServiceResult {
  const [service, setService] = useState<SimpleEmbeddingService | null>(null);
  const serviceRef = useRef<SimpleEmbeddingService | null>(null);

  const dispose = useCallback(async () => {
    if (!serviceRef.current) return;
    try {
      await serviceRef.current.dispose();
    } catch (_error) {
      // ignore disposal errors for best-effort cleanup
    } finally {
      serviceRef.current = null;
      setService(null);
    }
  }, []);

  useEffect(() => {
    if (!enableEmbedding || !model) {
      void dispose();
      return undefined;
    }

    const embeddingService = new SimpleEmbeddingService();
    serviceRef.current = embeddingService;
    setService(embeddingService);
    return () => {
      void embeddingService.dispose?.();
      if (serviceRef.current === embeddingService) {
        serviceRef.current = null;
        setService(null);
      }
    };
  }, [enableEmbedding, model, dispose]);

  return { service, dispose };
}
