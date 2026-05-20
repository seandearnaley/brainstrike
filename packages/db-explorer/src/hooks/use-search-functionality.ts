import type {
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  FileChunk,
  FileChunkRepository,
  FileRecord,
  FileRecordRepository,
} from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db';
import type { EmbeddingProviderConfig } from '@brainstrike/embeddings';
import {
  isHostedProvider,
  type EmbeddingModelConfig as ModelConfig,
  parseEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import type { useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChunkSearchResult, SearchFunctionality } from '../types';
import {
  buildLocalEmbeddingModelConfigMap,
  type EffectiveModelInfo,
  resolveEmbeddingSetModelInfo,
} from '../utils/embedding-models';
import { getActiveEmbeddingSetId } from '../vector-preferences';

interface SearchEmbedder {
  dispose?: () => Promise<void> | void;
  embedQuery: (text: string) => Promise<{ embedding: number[] }>;
}

export function useSearchFunctionality(
  chunkRepository: FileChunkRepository | ElectronFileChunkRepository | null,
  repository: FileRecordRepository | ElectronFileRecordRepository | null,
  toast: ReturnType<typeof useToast>['toast']
): SearchFunctionality {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChunkSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchThreshold, setSearchThreshold] = useState(getDefaultSearchThreshold());
  const [hasSearched, setHasSearched] = useState(false);
  const db = usePGliteDatabase();
  const { models } = useModelRegistryStore();
  const devicePref = useVectorPreferencesStore((state) => state.devicePref);

  // Maintain an internal service wrapper
  const embedderRef = useRef<SearchEmbedder | null>(null);
  const currentModelKeyRef = useRef<string | null>(null);
  const embedderInitPromiseRef = useRef<Promise<SearchEmbedder> | null>(null);
  const embedderInitTokenRef = useRef(0);
  const embedderDisposePromiseRef = useRef<Promise<void> | null>(null);
  const isDisposingRef = useRef(false);

  useEnsureModelRegistry({ db });

  const modelConfigMap = useMemo(() => buildLocalEmbeddingModelConfigMap(models), [models]);
  const getActiveEmbeddingSetOrThrow = useCallback((): string => {
    const activeSetId = getActiveEmbeddingSetId();
    if (!activeSetId) {
      throw new Error('Select an active embedding set to perform semantic search.');
    }
    return activeSetId;
  }, []);

  useEffect(() => {
    const cleanup = () => {
      const embedder = embedderRef.current;
      embedderRef.current = null;
      currentModelKeyRef.current = null;
      embedderInitPromiseRef.current = null;
      embedderInitTokenRef.current += 1;
      if (embedder?.dispose) {
        isDisposingRef.current = true;
        const disposePromise = Promise.resolve(embedder.dispose());
        embedderDisposePromiseRef.current = disposePromise;
        void disposePromise.finally(() => {
          if (embedderDisposePromiseRef.current === disposePromise) {
            embedderDisposePromiseRef.current = null;
          }
          isDisposingRef.current = false;
        });
      }
    };

    return cleanup;
  }, []);

  async function createHostedEmbedder(
    provider: string,
    modelId: string,
    dimensions: number
  ): Promise<SearchEmbedder> {
    const providerConfig = createHostedConfig(provider, modelId, dimensions);
    const { EmbeddingProviderFactory } = await import('@brainstrike/embeddings/factory');
    const providerResult = await EmbeddingProviderFactory.createProvider(providerConfig);

    if (!providerResult.ok) {
      throw new Error(
        `Failed to initialize hosted provider: ${
          'message' in providerResult.error
            ? providerResult.error.message
            : providerResult.error.type
        }`
      );
    }

    const providerInstance = providerResult.value;
    return {
      embedQuery: async (text: string) => {
        const result = await providerInstance.embed({ text, modelId });
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

  async function createLocalEmbedder(modelConfig: ModelConfig): Promise<SearchEmbedder> {
    // We rely on SimpleEmbeddingService because it handles retrieval prompts for models like BGE-M3
    const { SimpleEmbeddingService } = await import('@brainstrike/embeddings/service');
    const svc = new SimpleEmbeddingService();
    await svc.initializeWithModel(modelConfig, undefined, devicePref);

    return {
      embedQuery: async (text: string) => {
        const result = await svc.generateQueryEmbedding(text);
        return { embedding: Array.from(result.embedding) };
      },
      dispose: () => svc.dispose(),
    };
  }

  async function createEmbedder(modelInfo: EffectiveModelInfo): Promise<SearchEmbedder> {
    const parsed = parseEmbeddingProviderModelKey(modelInfo.modelKey);
    if (parsed && isHostedProvider(parsed.provider)) {
      return createHostedEmbedder(parsed.provider, parsed.modelId, modelInfo.dimensions);
    }

    if (!modelInfo.modelConfig) {
      throw new Error('No local embedding model configured. Enable one in Settings > Models.');
    }

    return createLocalEmbedder(modelInfo.modelConfig);
  }

  const disposeEmbedderWithTracking = async (embedder: SearchEmbedder): Promise<void> => {
    isDisposingRef.current = true;
    const disposePromise = Promise.resolve(embedder.dispose?.());
    embedderDisposePromiseRef.current = disposePromise;
    try {
      await disposePromise;
    } finally {
      if (embedderDisposePromiseRef.current === disposePromise) {
        embedderDisposePromiseRef.current = null;
      }
      isDisposingRef.current = false;
    }
  };

  const disposeStaleEmbedder = async (embedder: SearchEmbedder): Promise<void> => {
    if (embedder.dispose) {
      await Promise.resolve(embedder.dispose());
    }
  };

  const finalizeEmbedderInit = async (
    embedder: SearchEmbedder,
    modelKey: string,
    initToken: number
  ): Promise<SearchEmbedder> => {
    if (embedderInitTokenRef.current !== initToken) {
      await disposeStaleEmbedder(embedder);
      const activeEmbedder = embedderRef.current;
      if (activeEmbedder && currentModelKeyRef.current === modelKey) {
        return activeEmbedder;
      }
      throw new Error('Embedding model initialization superseded by a newer request.');
    }
    embedderRef.current = embedder;
    currentModelKeyRef.current = modelKey;
    return embedder;
  };

  async function ensureEmbedderReady(modelInfo: EffectiveModelInfo): Promise<SearchEmbedder> {
    const { modelKey } = modelInfo;
    const pendingDispose = embedderDisposePromiseRef.current;
    if (pendingDispose) {
      await pendingDispose;
    }
    if (isDisposingRef.current) {
      throw new Error('Embedding model is still disposing. Please retry in a moment.');
    }
    if (embedderInitPromiseRef.current) {
      await embedderInitPromiseRef.current;
    }
    // If we already have an embedder for this model, return it
    if (embedderRef.current && currentModelKeyRef.current === modelKey) {
      return embedderRef.current;
    }

    const initToken = embedderInitTokenRef.current + 1;
    embedderInitTokenRef.current = initToken;
    const initPromise = (async () => {
      if (embedderRef.current?.dispose) {
        await disposeEmbedderWithTracking(embedderRef.current);
      }
      const embedder = await createEmbedder(modelInfo);
      return finalizeEmbedderInit(embedder, modelKey, initToken);
    })();
    embedderInitPromiseRef.current = initPromise;

    try {
      return await initPromise;
    } finally {
      if (embedderInitPromiseRef.current === initPromise) {
        embedderInitPromiseRef.current = null;
      }
    }
  }

  // Helper to build config for factory
  function createHostedConfig(
    provider: string,
    modelId: string,
    dimensions: number
  ): EmbeddingProviderConfig {
    const supportedProviders = ['openai', 'google', 'cohere', 'voyage'] as const;
    if (!supportedProviders.includes(provider as (typeof supportedProviders)[number])) {
      throw new Error(
        `Unsupported hosted provider: ${provider}. Must be one of: ${supportedProviders.join(', ')}`
      );
    }
    switch (provider) {
      case 'openai':
        return { runtime: 'hosted', provider: 'openai', modelId, dimensions };
      case 'google':
        return { runtime: 'hosted', provider: 'google', modelId, outputDimensionality: dimensions };
      case 'cohere':
        return { runtime: 'hosted', provider: 'cohere', modelId, inputType: 'search_query' };
      case 'voyage':
        return { runtime: 'hosted', provider: 'voyage', modelId, inputType: 'query' };
      default:
        throw new Error(`Unhandled hosted provider: ${provider}`);
    }
  }

  function buildSearchOptions(threshold: number) {
    const activeSetId = getActiveEmbeddingSetId();
    const codeLike = isLikelyCodeQuery(searchQuery);
    return {
      limit: 20,
      threshold,
      ...(codeLike ? { chunkType: 'recursive' as const } : {}),
      ...(activeSetId ? { embeddingSetId: activeSetId } : {}),
    };
  }

  async function getEffectiveModelInfo(): Promise<EffectiveModelInfo> {
    const activeSetId = getActiveEmbeddingSetOrThrow();

    if (!db) {
      throw new Error('Database is not available to resolve the active embedding set.');
    }

    const res = await db.query<{ modelKey: string; dimensions: number }>(
      'SELECT model_key AS "modelKey", dimensions FROM embedding_sets WHERE id = $1 LIMIT 1',
      [activeSetId]
    );
    const row = res.rows[0];
    if (!row?.modelKey) {
      throw new Error('Active embedding set is missing a model.');
    }
    return resolveEmbeddingSetModelInfo(
      { modelKey: row.modelKey, dimensions: Number(row.dimensions) },
      modelConfigMap
    );
  }

  async function performRepositorySearch(
    embedding: number[]
  ): Promise<Array<{ chunk: FileChunk; similarity: number }>> {
    if (!chunkRepository) {
      return [];
    }
    const options = buildSearchOptions(searchThreshold);
    const repoResults = await chunkRepository.searchSimilar(embedding, options);
    return Array.isArray(repoResults) ? repoResults : [];
  }

  function handleSearchError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const needsSet = /requires embeddingSetId|active embedding set/i.test(message);
    toast({
      title: 'Search Failed',
      description: needsSet
        ? 'Select an active embedding set in Vector Status, then retry.'
        : message || 'Unknown error',
      variant: 'destructive',
    });
  }

  const enrichChunkResults = useCallback(
    async (chunkResults: Array<{ chunk: FileChunk; similarity: number }>) => {
      if (!repository) {
        return chunkResults.map((chunkResult) => ({
          chunk: chunkResult.chunk,
          similarity: chunkResult.similarity,
          fileRecord: {
            id: chunkResult.chunk.fileRecordId,
            name: 'Unknown file',
            path: '(unavailable)',
            size: 0,
            createdAt: chunkResult.chunk.createdAt,
            updatedAt: chunkResult.chunk.updatedAt,
          } as FileRecord,
        }));
      }

      const fileIds = Array.from(
        new Set(chunkResults.map((chunkResult) => chunkResult.chunk.fileRecordId))
      );
      const fileEntries = await Promise.all(
        fileIds.map(async (fileId) => {
          const record = (await repository.findById(fileId)) as FileRecord | null;
          return [fileId, record] as const;
        })
      );
      const fileRecordMap = new Map(fileEntries);

      return chunkResults.map((chunkResult) => {
        let fileRecord = fileRecordMap.get(chunkResult.chunk.fileRecordId) ?? null;
        if (!fileRecord) {
          // Fallback: synthesize minimal record to avoid hiding valid matches
          fileRecord = {
            id: chunkResult.chunk.fileRecordId,
            name: 'Unknown file',
            path: '(unavailable)',
            size: 0,
            createdAt: chunkResult.chunk.createdAt,
            updatedAt: chunkResult.chunk.updatedAt,
          } as FileRecord;
        }
        return {
          chunk: chunkResult.chunk,
          similarity: chunkResult.similarity,
          fileRecord,
        };
      });
    },
    [repository]
  );

  const handleSearch = useCallback(async () => {
    if (!(searchQuery.trim() && chunkRepository)) {
      return;
    }
    setSearching(true);
    setHasSearched(true);
    try {
      // Prefer active embedding set's model when available to avoid dimension mismatch
      const modelInfo = await getEffectiveModelInfo();
      const embedder = await ensureEmbedderReady(modelInfo);
      const queryEmbedding = await embedder.embedQuery(searchQuery);
      const chunkResults = await performRepositorySearch(queryEmbedding.embedding);

      // Lightweight re-ranker for ordering only (preserve displayed similarity)
      // Rationale:
      // - 75% vector similarity: primary signal
      // - + file-level boost (max file similarity * w_file) rewards coherence across chunks
      // - + 10% lexical overlap: cheap textual relevance guard
      // - + small adjacency bonus when neighboring chunks appear
      // Weights can be adjusted via env when needed.
      const reranked = (() => {
        const qTokens = tokenize(searchQuery);
        const fileMax = new Map<string, number>();
        for (const r of chunkResults) {
          const k = r.chunk.fileRecordId;
          fileMax.set(k, Math.max(fileMax.get(k) ?? 0, r.similarity));
        }
        const seen = new Set<string>(
          chunkResults.map((r) => `${r.chunk.fileRecordId}:${r.chunk.chunkIndex}`)
        );

        const scored = chunkResults.map((r) => {
          const lex = lexicalOverlapScore(qTokens, r.chunk.content);
          const weights = getReRankWeights();
          const fileBoost = (fileMax.get(r.chunk.fileRecordId) ?? 0) * weights.fileBoost;
          const leftKey = `${r.chunk.fileRecordId}:${r.chunk.chunkIndex - 1}`;
          const rightKey = `${r.chunk.fileRecordId}:${r.chunk.chunkIndex + 1}`;
          const adjacencyBoost = seen.has(leftKey) || seen.has(rightKey) ? weights.adjacency : 0;
          const blended =
            weights.vector * r.similarity + fileBoost + weights.lexical * lex + adjacencyBoost;
          return { value: r, score: blended };
        });
        return scored.sort((a, b) => b.score - a.score).map((s) => s.value);
      })();

      const results = await enrichChunkResults(reranked);
      setSearchResults(results);
    } catch (error) {
      // Ensure deterministic empty state on failures
      setSearchResults([]);
      handleSearchError(error);
    } finally {
      setSearching(false);
      // already set to true at start; keep for symmetry
      setHasSearched(true);
    }
  }, [searchQuery, chunkRepository, db, searchThreshold, enrichChunkResults]);

  return {
    searchQuery,
    setSearchQuery,
    searchResults,
    searching,
    searchThreshold,
    setSearchThreshold,
    handleSearch,
    hasSearched,
  };
}

/**
 * Tokenizes text into a set of lowercase alphanumeric tokens.
 * Filters out single-character tokens to reduce noise.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t && t.length > 1)
  );
}

function lexicalOverlapScore(queryTokens: Set<string>, doc: string): number {
  if (!doc) {
    return 0;
  }
  const docTokens = tokenize(doc);
  if (docTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const t of queryTokens) {
    if (docTokens.has(t)) {
      overlap++;
    }
  }
  // Jaccard-like score
  const denominator = queryTokens.size + docTokens.size - overlap;
  if (denominator <= 0) {
    return 0;
  }
  return overlap / denominator;
}

function isLikelyCodeQuery(text: string): boolean {
  const t = String(text || '').toLowerCase();
  if (!t) {
    return false;
  }
  if (/\b(import|export|class|function|const|let|var|interface|type|enum)\b/.test(t)) {
    return true;
  }
  if (/[{}();.=<>[\]]/.test(t)) {
    return true;
  }
  if (/\w+\s*\(.*\)/.test(t)) {
    return true; // looks like a call or signature
  }
  return false;
}

function getDefaultSearchThreshold(): number {
  // Allow configuration via env (Vite and Node); clamp to [0,1]
  const raw =
    readEnvValue('VITE_SEARCH_DEFAULT_THRESHOLD') ??
    readEnvValue('SEARCH_DEFAULT_THRESHOLD') ??
    readEnvValue('BRAINSTRIKE_SEARCH_DEFAULT_THRESHOLD');
  const n = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  if (Number.isFinite(n)) {
    return Math.min(1, Math.max(0, n));
  }
  // Fallback: conservative default; store persistence may override on mount
  return 0.5;
}

const DEFAULT_RERANK_WEIGHTS = {
  vector: 0.75,
  fileBoost: 0.15,
  lexical: 0.1,
  adjacency: 0.05,
};

/**
 * Retrieves re-ranking weights for semantic search result ordering.
 *
 * Defaults tuned empirically:
 * - vector: primary signal from embedding similarity
 * - fileBoost: coherence reward for multiple matching chunks in a file
 * - lexical: textual overlap guard
 * - adjacency: bonus for neighboring chunks
 *
 * Override via:
 * - VITE_RERANK_VECTOR / RERANK_VECTOR
 * - VITE_RERANK_FILE_BOOST / RERANK_FILE_BOOST
 * - VITE_RERANK_LEXICAL / RERANK_LEXICAL
 * - VITE_RERANK_ADJACENCY / RERANK_ADJACENCY
 */
function getReRankWeights(): {
  vector: number;
  fileBoost: number;
  lexical: number;
  adjacency: number;
} {
  // Defaults chosen empirically; allow overrides via env for experimentation
  let vector = DEFAULT_RERANK_WEIGHTS.vector;
  let fileBoost = DEFAULT_RERANK_WEIGHTS.fileBoost;
  let lexical = DEFAULT_RERANK_WEIGHTS.lexical;
  let adjacency = DEFAULT_RERANK_WEIGHTS.adjacency;

  vector = readNumberEnv(['VITE_RERANK_VECTOR', 'RERANK_VECTOR']) ?? DEFAULT_RERANK_WEIGHTS.vector;
  fileBoost =
    readNumberEnv(['VITE_RERANK_FILE_BOOST', 'RERANK_FILE_BOOST']) ??
    DEFAULT_RERANK_WEIGHTS.fileBoost;
  lexical =
    readNumberEnv(['VITE_RERANK_LEXICAL', 'RERANK_LEXICAL']) ?? DEFAULT_RERANK_WEIGHTS.lexical;
  adjacency =
    readNumberEnv(['VITE_RERANK_ADJACENCY', 'RERANK_ADJACENCY']) ??
    DEFAULT_RERANK_WEIGHTS.adjacency;
  return { vector, fileBoost, lexical, adjacency };
}

type EnvMap = Record<string, string | undefined>;

function readEnvValue(key: string): string | undefined {
  const metaEnv = (import.meta as ImportMeta & { env?: EnvMap }).env;
  const viteValue = metaEnv?.[key];
  if (viteValue !== undefined) {
    return viteValue;
  }
  if (typeof process !== 'undefined') {
    return process.env?.[key];
  }
  return;
}

function readNumberEnv(keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readEnvValue(key);
    if (value === undefined) {
      continue;
    }
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return;
}
