import type {
  FileChunk,
  FileChunkRepository,
  FileRecord,
  FileRecordRepository,
} from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db';
import type { EmbeddingProviderConfig } from '@brainstrike/embeddings';
import {
  EmbeddingProviderFactory,
  isHostedProvider,
  parseProviderModelKey,
  SimpleEmbeddingService,
} from '@brainstrike/embeddings';
import type { useToast } from '@brainstrike/ui';
import { useCallback, useRef, useState } from 'react';
import type { ChunkSearchResult, SearchFunctionality } from '../types';
import { getActiveEmbeddingSetId } from '../vector-preferences';

type SearchEmbedder = {
  embedQuery: (text: string) => Promise<{ embedding: number[] }>;
  dispose?: () => Promise<void> | void;
};

export function useSearchFunctionality(
  chunkRepository: FileChunkRepository | null,
  repository: FileRecordRepository | null,
  toast: ReturnType<typeof useToast>['toast']
): SearchFunctionality {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChunkSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchThreshold, setSearchThreshold] = useState(getDefaultSearchThreshold());
  const [hasSearched, setHasSearched] = useState(false);
  const db = usePGliteDatabase();

  // Maintain an internal service wrapper
  const embedderRef = useRef<SearchEmbedder | null>(null);
  const currentModelKeyRef = useRef<string | null>(null);

  async function ensureEmbedderReady(
    modelKey: string,
    dimensions: number
  ): Promise<SearchEmbedder> {
    // If we already have an embedder for this model, return it
    if (embedderRef.current && currentModelKeyRef.current === modelKey) {
      return embedderRef.current;
    }

    // Dispose previous if exists
    if (embedderRef.current?.dispose) {
      await embedderRef.current.dispose();
    }

    const parsed = parseProviderModelKey(modelKey);
    const isHosted = parsed && isHostedProvider(parsed.provider);

    if (isHosted) {
      // Hosted provider path
      const providerConfig = createHostedConfig(parsed.provider, parsed.modelId, dimensions);
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

      const provider = providerResult.value;
      const embedder: SearchEmbedder = {
        embedQuery: async (text: string) => {
          const result = await provider.embed({ text, modelId: parsed.modelId });
          if (!result.ok) {
            // Extract error message safely
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
        // Providers don't necessarily need explicit disposal, but good practice if added later
      };

      embedderRef.current = embedder;
      currentModelKeyRef.current = modelKey;
      return embedder;
    }

    // Local provider path (legacy SimpleEmbeddingService)
    // We rely on SimpleEmbeddingService because it handles retrieval prompts for models like BGE-M3
    const svc = new SimpleEmbeddingService();
    await svc.initializeWithModel(modelKey);

    const embedder: SearchEmbedder = {
      embedQuery: async (text: string) => {
        const result = await svc.generateQueryEmbedding(text);
        return { embedding: Array.from(result.embedding) };
      },
      dispose: () => svc.dispose(),
    };

    embedderRef.current = embedder;
    currentModelKeyRef.current = modelKey;
    return embedder;
  }

  // Helper to build config for factory
  function createHostedConfig(
    provider: string,
    modelId: string,
    dimensions: number
  ): EmbeddingProviderConfig {
    // Type assertion or manual construction because TypeScript might not infer the discriminated union perfectly here
    if (provider === 'openai') {
      return { runtime: 'hosted', provider: 'openai', modelId, dimensions };
    }
    if (provider === 'google') {
      return { runtime: 'hosted', provider: 'google', modelId, outputDimensionality: dimensions };
    }
    if (provider === 'cohere') {
      return { runtime: 'hosted', provider: 'cohere', modelId, inputType: 'search_query' };
    }
    if (provider === 'voyage') {
      return { runtime: 'hosted', provider: 'voyage', modelId, inputType: 'query' };
    }
    throw new Error(`Unsupported hosted provider: ${provider}`);
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

  async function getEffectiveModelInfo(): Promise<{ modelKey: string; dimensions: number }> {
    const activeSetId = getActiveEmbeddingSetId();
    const defaultKey = SimpleEmbeddingService.getDefaultModelKey();
    // Default dimension for fallback (local BGE-M3)
    const defaultDim = 1024;

    if (db && activeSetId) {
      try {
        const res = await db.query<{ modelKey: string; dimensions: number }>(
          'SELECT model_key AS "modelKey", dimensions FROM embedding_sets WHERE id = $1 LIMIT 1',
          [activeSetId]
        );
        const row = res.rows[0];
        if (row?.modelKey) {
          return {
            modelKey: row.modelKey,
            // Use row dimensions if available, otherwise fallback
            dimensions: Number(row.dimensions) || defaultDim,
          };
        }
      } catch {
        // keep fallback
      }
    }
    return { modelKey: defaultKey, dimensions: defaultDim };
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
    const needsSet = /requires embeddingSetId/i.test(message);
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
      const results: ChunkSearchResult[] = [];
      for (const chunkResult of chunkResults) {
        let fileRecord: FileRecord | null = (await repository?.findById(
          chunkResult.chunk.fileRecordId
        )) as FileRecord | null;
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
        results.push({
          chunk: chunkResult.chunk,
          similarity: chunkResult.similarity,
          fileRecord,
        });
      }
      return results;
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
      const { modelKey, dimensions } = await getEffectiveModelInfo();
      const embedder = await ensureEmbedderReady(modelKey, dimensions);
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
  return overlap / (queryTokens.size + docTokens.size - overlap);
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
  let raw: unknown;
  try {
    // Vite-style
    const meta = import.meta as unknown as { env?: Record<string, string> };
    const viteEnv = meta?.env?.['VITE_SEARCH_DEFAULT_THRESHOLD'];
    if (viteEnv !== undefined) {
      raw = viteEnv;
    }
  } catch {}
  if (raw === undefined) {
    try {
      // Node-style
      raw = (
        process?.env
          ? process.env['SEARCH_DEFAULT_THRESHOLD'] ||
            process.env['BRAINSTRIKE_SEARCH_DEFAULT_THRESHOLD']
          : undefined
      ) as unknown;
    } catch {}
  }
  const n = typeof raw === 'string' ? Number.parseFloat(raw) : Number(raw);
  if (Number.isFinite(n)) {
    return Math.min(1, Math.max(0, n));
  }
  // Fallback: conservative default; store persistence may override on mount
  return 0.5;
}

function getReRankWeights(): {
  vector: number;
  fileBoost: number;
  lexical: number;
  adjacency: number;
} {
  // Defaults chosen empirically; allow overrides via env for experimentation
  let vector = 0.75;
  let fileBoost = 0.15;
  let lexical = 0.1;
  let adjacency = 0.05;
  try {
    const meta = import.meta as unknown as { env?: Record<string, string> };
    const env = meta?.env || (typeof process !== 'undefined' ? process.env : {});
    const num = (v: unknown) => {
      const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    vector = num(env?.['VITE_RERANK_VECTOR'] ?? env?.['RERANK_VECTOR']) ?? vector;
    fileBoost = num(env?.['VITE_RERANK_FILE_BOOST'] ?? env?.['RERANK_FILE_BOOST']) ?? fileBoost;
    lexical = num(env?.['VITE_RERANK_LEXICAL'] ?? env?.['RERANK_LEXICAL']) ?? lexical;
    adjacency = num(env?.['VITE_RERANK_ADJACENCY'] ?? env?.['RERANK_ADJACENCY']) ?? adjacency;
  } catch {}
  return { vector, fileBoost, lexical, adjacency };
}
