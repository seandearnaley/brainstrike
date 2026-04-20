import type { FileChunk } from '@brainstrike/db';
import { CHUNKING_CONFIG } from '@brainstrike/db';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import { createLogger } from '@brainstrike/utils/logger';
import { buildEmbeddingText, type ChunkContext } from './embedding-context';
import type { FileImportChunkRepository } from './repository-ports';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';

const logger = createLogger('FileImport:Embedding');

export async function initializeEmbeddingService(
  embeddingService: SimpleEmbeddingService | null,
  model: string | undefined
): Promise<boolean> {
  if (!(embeddingService && model)) {
    logger.warn('Cannot initialize embedding service: service or model not provided', {
      hasService: !!embeddingService,
      model,
    });
    return false;
  }
  const status = embeddingService.getStatus();
  if (status === 'ready') {
    logger.info('Embedding service already ready', { model });
    return true;
  }
  try {
    logger.info('Initializing embedding service', { model });
    await embeddingService.initializeWithModel(model);
    await new Promise((resolve) =>
      setTimeout(resolve, CHUNKING_CONFIG.embeddingInitializationDelay)
    );
    logger.info('Embedding service initialized successfully', { model });
    return true;
  } catch (error) {
    logger.error('Failed to initialize embedding service:', {
      model,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return false;
  }
}

export async function processChunkEmbedding(
  chunk: FileChunk,
  chunkRepository: FileImportChunkRepository | null,
  embeddingService: SimpleEmbeddingService | null,
  context?: ChunkContext
): Promise<boolean> {
  if (!(embeddingService && chunkRepository)) {
    logger.warn('Cannot process chunk embedding: service or repository not available', {
      hasService: !!embeddingService,
      hasRepository: !!chunkRepository,
      chunkId: chunk.id,
    });
    return false;
  }
  try {
    if (embeddingService.getStatus() !== 'ready') {
      logger.warn('Embedding service not ready for chunk', {
        chunkId: chunk.id,
        status: embeddingService.getStatus(),
      });
      return false;
    }
    const svcAny = embeddingService as unknown as {
      generateDocEmbedding?: (t: string) => Promise<{ embedding: number[] }>;
      generateEmbedding: (t: string) => Promise<{ embedding: number[] }>;
    };

    // Build embedding text with contextual metadata when available
    const textToEmbed = context ? buildEmbeddingText(chunk.content, context) : chunk.content;

    const embeddingResult = svcAny.generateDocEmbedding
      ? await svcAny.generateDocEmbedding(textToEmbed)
      : await embeddingService.generateEmbedding(textToEmbed);
    await chunkRepository.update({
      id: chunk.id,
      embedding: embeddingResult.embedding,
      updatedAt: new Date().toISOString(),
    });
    logger.debug('Successfully embedded chunk', { chunkId: chunk.id, hasContext: !!context });
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('invalid data location') ||
        error.message.includes('webgpu') ||
        error.message.includes('tensor'))
    ) {
      logger.warn(
        'Embedding failed with known WebGPU/tensor error (expected in some environments)',
        {
          chunkId: chunk.id,
          error: error.message,
        }
      );
      return false;
    }
    logger.error('Unexpected error during chunk embedding:', {
      chunkId: chunk.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

async function processChunkWithSetId(
  chunk: FileChunk,
  chunkRepository: NonNullable<FileImportChunkRepository>,
  embeddingService: SimpleEmbeddingService,
  targetEmbeddingSetId?: string
): Promise<boolean> {
  const ok = await processChunkEmbedding(chunk, chunkRepository, embeddingService);
  if (ok && targetEmbeddingSetId) {
    // Update set id metadata if provided so UI badges and coverage reflect inline embeddings
    await chunkRepository.update({
      id: chunk.id,
      embeddingSetId: targetEmbeddingSetId,
      updatedAt: new Date().toISOString(),
    });
  }
  return ok;
}

async function processChunksLoop(
  chunks: FileChunk[],
  chunkRepository: NonNullable<FileImportChunkRepository>,
  embeddingService: SimpleEmbeddingService,
  embeddingModel: string,
  updateProgress: (
    updater: (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null
  ) => void,
  targetEmbeddingSetId?: string
): Promise<number> {
  let chunksWithEmbeddings = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) {
      continue;
    }

    updateProgress((prev) =>
      prev
        ? {
            ...prev,
            phase: 'embedding',
            embeddingProgress: {
              chunksProcessed: i + 1, // Report 1-indexed count (chunk being processed)
              totalChunks: chunks.length,
              currentChunk: `${chunk.content.slice(0, CHUNKING_CONFIG.chunkPreviewLength)}...`,
              modelName: embeddingModel,
            },
          }
        : null
    );

    const success = await processChunkWithSetId(
      chunk,
      chunkRepository,
      embeddingService,
      targetEmbeddingSetId
    );

    if (success) {
      chunksWithEmbeddings++;
    }

    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, CHUNKING_CONFIG.embeddingProcessingDelay));
    }
  }

  return chunksWithEmbeddings;
}

export async function processEmbeddings(
  chunks: FileChunk[],
  result: EnhancedImportResult,
  chunkRepository: FileImportChunkRepository | null,
  embeddingService: SimpleEmbeddingService | null,
  embeddingModel: string | undefined,
  updateProgress: (
    updater: (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null
  ) => void,
  // Optional: tag embeddings to a specific set id when writing inline (web fallback)
  targetEmbeddingSetId?: string
): Promise<void> {
  if (!(embeddingService && chunkRepository && embeddingModel)) {
    logger.warn('Skipping embeddings: missing required dependencies', {
      hasService: !!embeddingService,
      hasRepository: !!chunkRepository,
      model: embeddingModel,
      chunksCount: chunks.length,
      fileId: result.id,
    });
    return;
  }

  logger.info('Starting embedding processing', {
    chunksCount: chunks.length,
    model: embeddingModel,
    fileId: result.id,
    targetEmbeddingSetId,
  });

  try {
    const initialized = await initializeEmbeddingService(embeddingService, embeddingModel);
    if (!initialized) {
      const errorMsg = 'Embedding initialization failed';
      logger.error(errorMsg, { model: embeddingModel, fileId: result.id });
      result.error = errorMsg;
      return;
    }

    const chunksWithEmbeddings = await processChunksLoop(
      chunks,
      chunkRepository,
      embeddingService,
      embeddingModel,
      updateProgress,
      targetEmbeddingSetId
    );

    result.chunksWithEmbeddings = chunksWithEmbeddings;
    logger.info('Embedding processing complete', {
      fileId: result.id,
      totalChunks: chunks.length,
      successfulEmbeddings: chunksWithEmbeddings,
      failedEmbeddings: chunks.length - chunksWithEmbeddings,
    });
  } catch (error) {
    const errorMsg = `Embedding failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.error('Embedding processing failed:', {
      fileId: result.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      chunksCount: chunks.length,
      model: embeddingModel,
    });
    result.error = errorMsg;
  }
}
