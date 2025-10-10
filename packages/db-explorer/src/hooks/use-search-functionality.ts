import type {
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  FileChunk,
  FileChunkRepository,
  FileRecord,
  FileRecordRepository,
} from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import type { useToast } from '@brainstrike/ui';
import { useCallback, useRef, useState } from 'react';
import type { ChunkSearchResult, SearchFunctionality } from '../types';
import { getActiveEmbeddingSetId } from '../vector-preferences';

export function useSearchFunctionality(
  embeddingService: SimpleEmbeddingService | null,
  chunkRepository: FileChunkRepository | ElectronFileChunkRepository | null,
  repository: FileRecordRepository | ElectronFileRecordRepository | null,
  selectedModel: string,
  toast: ReturnType<typeof useToast>['toast']
): SearchFunctionality {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChunkSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchThreshold, setSearchThreshold] = useState(getDefaultSearchThreshold());
  const [hasSearched, setHasSearched] = useState(false);
  const db = usePGliteDatabase();

  // Maintain an internal service for queries when none is provided (decouples from import toggle)
  const serviceRef = useRef<SimpleEmbeddingService | null>(embeddingService);

  async function ensureServiceReady(modelKey: string): Promise<SimpleEmbeddingService> {
    let svc = serviceRef.current;
    if (!svc) {
      svc = new SimpleEmbeddingService();
      serviceRef.current = svc;
    }
    const status = svc.getStatus();
    const currentKey =
      typeof svc.getCurrentModelKey === 'function' ? svc.getCurrentModelKey() : null;
    // Initialize when not ready, or reinitialize when using a different model
    if (status !== 'ready') {
      await svc.initializeWithModel(modelKey);
      return svc;
    }
    if (currentKey && currentKey !== modelKey) {
      await svc.dispose();
      await svc.initializeWithModel(modelKey);
    }
    return svc;
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

  async function getEffectiveModelKey(): Promise<string> {
    const activeSetId = getActiveEmbeddingSetId();
    let modelKey = selectedModel;
    if (db && activeSetId) {
      try {
        const res = await db.query<{ modelKey: string }>(
          'SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1 LIMIT 1',
          [activeSetId]
        );
        if (res.rows[0]?.modelKey) modelKey = res.rows[0].modelKey;
      } catch {
        // keep selectedModel on lookup failure
      }
    }
    return modelKey;
  }

  async function performRepositorySearch(
    embedding: number[]
  ): Promise<Array<{ chunk: FileChunk; similarity: number }>> {
    if (!chunkRepository) return [];
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
    if (!searchQuery.trim() || !chunkRepository) {
      return;
    }
    setSearching(true);
    setHasSearched(true);
    try {
      // Prefer active embedding set's model when available to avoid dimension mismatch
      const modelKey = await getEffectiveModelKey();
      const svc = await ensureServiceReady(modelKey);
      const queryEmbedding = await svc.generateQueryEmbedding(searchQuery);
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
  }, [searchQuery, chunkRepository, selectedModel, db, searchThreshold, enrichChunkResults]);

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
  if (!doc) return 0;
  const docTokens = tokenize(doc);
  if (docTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of queryTokens) if (docTokens.has(t)) overlap++;
  // Jaccard-like score
  return overlap / (queryTokens.size + docTokens.size - overlap);
}

function isLikelyCodeQuery(text: string): boolean {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (/\b(import|export|class|function|const|let|var|interface|type|enum)\b/.test(t)) return true;
  if (/[{}();.=<>[\]]/.test(t)) return true;
  if (/\w+\s*\(.*\)/.test(t)) return true; // looks like a call or signature
  return false;
}

function getDefaultSearchThreshold(): number {
  // Allow configuration via env (Vite and Node); clamp to [0,1]
  let raw: unknown;
  try {
    // Vite-style
    // biome-ignore lint/suspicious/noExplicitAny: env access differs across runtimes
    const viteEnv = (import.meta as any)?.env?.VITE_SEARCH_DEFAULT_THRESHOLD;
    if (viteEnv !== undefined) raw = viteEnv;
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
  if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
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
    // biome-ignore lint/suspicious/noExplicitAny: env access differs across runtimes
    const env = (import.meta as any)?.env || (typeof process !== 'undefined' ? process.env : {});
    const num = (v: unknown) => {
      const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    vector = num(env?.VITE_RERANK_VECTOR ?? env?.RERANK_VECTOR) ?? vector;
    fileBoost = num(env?.VITE_RERANK_FILE_BOOST ?? env?.RERANK_FILE_BOOST) ?? fileBoost;
    lexical = num(env?.VITE_RERANK_LEXICAL ?? env?.RERANK_LEXICAL) ?? lexical;
    adjacency = num(env?.VITE_RERANK_ADJACENCY ?? env?.RERANK_ADJACENCY) ?? adjacency;
  } catch {}
  return { vector, fileBoost, lexical, adjacency };
}
