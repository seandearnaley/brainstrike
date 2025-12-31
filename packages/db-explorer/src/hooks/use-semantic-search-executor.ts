/**
 * useSemanticSearchExecutor Hook
 *
 * Creates a search executor function for the SemanticSearchProvider
 * that performs vector similarity search using the chunk repository.
 */

import type { DrizzleFileChunkRepository, DrizzleFileRecordRepository } from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db';
import {
  type EmbeddingProviderConfig,
  EmbeddingProviderFactory,
  isHostedProvider,
  parseProviderModelKey,
  SimpleEmbeddingService,
} from '@brainstrike/embeddings';
import type { SearchConfig, SemanticSearchResult } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useRef } from 'react';
import type { SearchExecutor } from '../contexts/semantic-search-context';

const logger = createLogger('SemanticSearchExecutor');

type SearchEmbedder = {
  embedQuery: (text: string) => Promise<{ embedding: number[] }>;
  dispose?: () => Promise<void> | void;
};

type UseSemanticSearchExecutorOptions = {
  chunkRepository: DrizzleFileChunkRepository | null;
  fileRepository: DrizzleFileRecordRepository | null;
};

/**
 * Create a hosted provider embedder
 */
async function createHostedEmbedder(
  providerConfig: EmbeddingProviderConfig,
  modelId: string
): Promise<SearchEmbedder> {
  const providerResult = await EmbeddingProviderFactory.createProvider(providerConfig);
  logger.info('Hosted provider creation result', { ok: providerResult.ok });

  if (!providerResult.ok) {
    throw new Error(
      `Failed to initialize hosted provider: ${
        'message' in providerResult.error ? providerResult.error.message : providerResult.error.type
      }`
    );
  }

  const provider = providerResult.value;
  return {
    embedQuery: async (text: string) => {
      const result = await provider.embed({ text, modelId });
      if (!result.ok) {
        const error = result.error;
        const msg =
          'message' in error
            ? error.message
            : 'originalError' in error
              ? error.originalError.message
              : error.type;
        throw new Error(`Embedding failed: ${msg}`);
      }
      return { embedding: result.value.embedding };
    },
  };
}

/**
 * Create a local provider embedder
 */
async function createLocalEmbedder(modelKey: string): Promise<SearchEmbedder> {
  logger.info('Creating local embedder (SimpleEmbeddingService)', { modelKey });
  const svc = new SimpleEmbeddingService();
  logger.info('Initializing local model...');
  await svc.initializeWithModel(modelKey);
  logger.info('Local model initialized');

  return {
    embedQuery: async (text: string) => {
      logger.info('Generating query embedding with local model...');
      const result = await svc.generateQueryEmbedding(text);
      logger.info('Query embedding generated', { length: result.embedding.length });
      return { embedding: Array.from(result.embedding) };
    },
    dispose: () => svc.dispose(),
  };
}

/**
 * Creates a search executor for semantic search in the collection browser
 */
export function useSemanticSearchExecutor({
  chunkRepository,
  fileRepository,
}: UseSemanticSearchExecutorOptions): SearchExecutor | undefined {
  const db = usePGliteDatabase();
  const embedderRef = useRef<SearchEmbedder | null>(null);
  const currentModelKeyRef = useRef<string | null>(null);

  /**
   * Get the model info for the active embedding set
   */
  const getModelInfo = useCallback(
    async (embeddingSetId: string | null): Promise<{ modelKey: string; dimensions: number }> => {
      const defaultKey = SimpleEmbeddingService.getDefaultModelKey();
      const defaultDim = 1024;

      if (db && embeddingSetId) {
        try {
          const res = await db.query<{ modelKey: string; dimensions: number }>(
            'SELECT model_key AS "modelKey", dimensions FROM embedding_sets WHERE id = $1 LIMIT 1',
            [embeddingSetId]
          );
          const row = res.rows[0];
          if (row?.modelKey) {
            return {
              modelKey: row.modelKey,
              dimensions: Number(row.dimensions) || defaultDim,
            };
          }
        } catch {
          // keep fallback
        }
      }
      return { modelKey: defaultKey, dimensions: defaultDim };
    },
    [db]
  );

  /**
   * Create hosted provider config
   */
  const createHostedConfig = useCallback(
    (provider: string, modelId: string, dimensions: number): EmbeddingProviderConfig => {
      if (provider === 'openai') {
        return { runtime: 'hosted', provider: 'openai', modelId, dimensions };
      }
      if (provider === 'google') {
        return {
          runtime: 'hosted',
          provider: 'google',
          modelId,
          outputDimensionality: dimensions,
        };
      }
      if (provider === 'cohere') {
        return {
          runtime: 'hosted',
          provider: 'cohere',
          modelId,
          inputType: 'search_query',
        };
      }
      if (provider === 'voyage') {
        return { runtime: 'hosted', provider: 'voyage', modelId, inputType: 'query' };
      }
      throw new Error(`Unsupported hosted provider: ${provider}`);
    },
    []
  );

  /**
   * Ensure embedder is ready for the given model
   */
  const ensureEmbedderReady = useCallback(
    async (modelKey: string, dimensions: number): Promise<SearchEmbedder> => {
      logger.info('ensureEmbedderReady called', { modelKey, dimensions });

      // Reuse cached embedder if same model
      if (embedderRef.current && currentModelKeyRef.current === modelKey) {
        logger.info('Reusing cached embedder');
        return embedderRef.current;
      }

      // Dispose previous embedder if exists
      if (embedderRef.current?.dispose) {
        logger.info('Disposing previous embedder');
        await embedderRef.current.dispose();
      }

      // Detect provider type
      const parsed = parseProviderModelKey(modelKey);
      const isHosted = parsed && isHostedProvider(parsed.provider);
      logger.info('Provider detection', { isHosted });

      // Create appropriate embedder
      let embedder: SearchEmbedder;
      if (isHosted) {
        logger.info('Creating hosted provider', { provider: parsed.provider });
        const providerConfig = createHostedConfig(parsed.provider, parsed.modelId, dimensions);
        embedder = await createHostedEmbedder(providerConfig, parsed.modelId);
      } else {
        embedder = await createLocalEmbedder(modelKey);
      }

      // Cache and return
      embedderRef.current = embedder;
      currentModelKeyRef.current = modelKey;
      return embedder;
    },
    [createHostedConfig]
  );

  /**
   * The search executor function
   */
  const searchExecutor: SearchExecutor = useCallback(
    async (
      query: string,
      config: SearchConfig,
      embeddingSetId: string | null
    ): Promise<SemanticSearchResult[]> => {
      logger.info('searchExecutor called', {
        query: query.substring(0, 50),
        embeddingSetId,
        config,
        hasChunkRepo: !!chunkRepository,
        hasFileRepo: !!fileRepository,
      });

      if (!(chunkRepository && fileRepository)) {
        throw new Error('Repositories not available');
      }

      if (!embeddingSetId) {
        throw new Error('Select an active embedding set to perform semantic search');
      }

      // Get model info for the embedding set
      logger.info('Getting model info for embedding set...');
      const { modelKey, dimensions } = await getModelInfo(embeddingSetId);
      logger.info('Model info retrieved', { modelKey, dimensions });

      // Ensure embedder is ready
      logger.info('Initializing embedder...');
      const embedder = await ensureEmbedderReady(modelKey, dimensions);
      logger.info('Embedder ready');

      // Generate query embedding
      logger.info('Generating query embedding...');
      const { embedding } = await embedder.embedQuery(query);
      logger.info('Query embedding generated', { embeddingLength: embedding.length });

      // Search for similar chunks
      logger.info('Searching for similar chunks...');
      const searchResults = await chunkRepository.searchSimilar(embedding, {
        limit: config.resultLimit,
        threshold: config.threshold,
        embeddingSetId,
      });
      logger.info('Search completed', { resultCount: searchResults.length });

      // Build a map of file records for enrichment
      const fileIds = new Set(searchResults.map((r) => r.chunk.fileRecordId));
      const fileRecordsMap = new Map<string, { name: string; path: string }>();

      for (const fileId of fileIds) {
        const record = await fileRepository.findById(fileId);
        if (record) {
          fileRecordsMap.set(fileId, { name: record.name, path: record.path });
        } else {
          fileRecordsMap.set(fileId, { name: 'Unknown file', path: '(unavailable)' });
        }
      }

      // Transform to SemanticSearchResult format
      const results: SemanticSearchResult[] = searchResults.map((result) => {
        const fileInfo = fileRecordsMap.get(result.chunk.fileRecordId) ?? {
          name: 'Unknown',
          path: '',
        };

        const searchResult: SemanticSearchResult = {
          nodeId: `chunk-${result.chunk.id}`,
          chunkId: result.chunk.id,
          fileRecordId: result.chunk.fileRecordId,
          similarity: result.similarity,
          content: result.chunk.content,
          fileName: fileInfo.name,
          filePath: fileInfo.path,
        };
        if (result.chunk.embeddingSetId) {
          searchResult.embeddingSetId = result.chunk.embeddingSetId;
        }
        return searchResult;
      });

      return results;
    },
    [chunkRepository, fileRepository, getModelInfo, ensureEmbedderReady]
  );

  // Only return executor if repositories are available
  if (!(chunkRepository && fileRepository)) {
    logger.debug('Semantic search executor not available', {
      hasChunkRepo: !!chunkRepository,
      hasFileRepo: !!fileRepository,
    });
    return;
  }

  // Removed noisy debug log (was: logger.debug('Semantic search executor ready'));
  return searchExecutor;
}
