import type { FileChunk } from '@brainstrike/db';
import { CHUNKING_CONFIG } from '@brainstrike/db';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';

export async function initializeEmbeddingService(
  embeddingService: SimpleEmbeddingService | null,
  model: string | undefined
): Promise<boolean> {
  if (!embeddingService || !model) return false;
  const status = embeddingService.getStatus();
  if (status === 'ready') return true;
  try {
    await embeddingService.initializeWithModel(model);
    await new Promise((resolve) =>
      setTimeout(resolve, CHUNKING_CONFIG.embeddingInitializationDelay)
    );
    return true;
  } catch {
    return false;
  }
}

export async function processChunkEmbedding(
  chunk: FileChunk,
  chunkRepository: ReturnType<typeof import('@brainstrike/db').useFileChunkRepository> | null,
  embeddingService: SimpleEmbeddingService | null
): Promise<boolean> {
  if (!embeddingService || !chunkRepository) return false;
  try {
    if (embeddingService.getStatus() !== 'ready') return false;
    const embeddingResult = await embeddingService.generateEmbedding(chunk.content);
    await chunkRepository.update({
      id: chunk.id,
      embedding: embeddingResult.embedding,
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('invalid data location') ||
        error.message.includes('webgpu') ||
        error.message.includes('tensor'))
    ) {
      return false;
    }
    throw error;
  }
}

export async function processEmbeddings(
  chunks: FileChunk[],
  result: EnhancedImportResult,
  chunkRepository: ReturnType<typeof import('@brainstrike/db').useFileChunkRepository> | null,
  embeddingService: SimpleEmbeddingService | null,
  embeddingModel: string | undefined,
  updateProgress: (
    updater: (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null
  ) => void
): Promise<void> {
  if (!embeddingService || !chunkRepository || !embeddingModel) return;
  try {
    const initialized = await initializeEmbeddingService(embeddingService, embeddingModel);
    if (!initialized) {
      result.error = 'Embedding initialization failed';
      return;
    }

    let chunksWithEmbeddings = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      updateProgress((prev) =>
        prev
          ? {
              ...prev,
              phase: 'embedding',
              embeddingProgress: {
                chunksProcessed: i,
                totalChunks: chunks.length,
                currentChunk: `${chunk.content.substring(0, CHUNKING_CONFIG.chunkPreviewLength)}...`,
                modelName: embeddingModel || 'default',
              },
            }
          : null
      );
      const success = await processChunkEmbedding(chunk, chunkRepository, embeddingService);
      if (success) chunksWithEmbeddings++;
      if (i < chunks.length - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, CHUNKING_CONFIG.embeddingProcessingDelay)
        );
      }
    }
    result.chunksWithEmbeddings = chunksWithEmbeddings;
  } catch (error) {
    result.error = `Embedding failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}
