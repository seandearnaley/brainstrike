import type {
  GrepMatch,
  GrepSearchResult,
  GrepSearchService,
  HybridSearchResult,
  HybridSearchService,
} from '@brainstrike/db';
import { normalizeRRFScores } from '@brainstrike/db';
import type {
  WorkspaceSearchChunkHit,
  WorkspaceSearchFileResult,
  WorkspaceSearchResults,
  WorkspaceSearchTextMatch,
} from './search-result-model';

/** fileRecordId → resolved workspace-root/path info for semantic-mode grouping. */
export interface ResolvedFileInfo {
  dbRootId: string | null;
  path: string;
  rootDisplayName: string | null;
}

export interface WorkspaceSearchExecutorDeps {
  embedQuery: (embeddingSetId: string, text: string) => Promise<number[]>;
  grepService: Pick<GrepSearchService, 'search'>;
  hybridService: Pick<HybridSearchService, 'search'>;
  /** fileRecordId → { path, rootId, rootName } resolution for semantic grouping. */
  resolveFiles: (
    fileRecordIds: readonly string[]
  ) => Promise<ReadonlyMap<string, ResolvedFileInfo>>;
}

export interface TextSearchRequest {
  caseSensitive: boolean;
  embeddingSetId: string;
  isRegex: boolean;
  maxResults?: number;
  query: string;
  rootIds: readonly string[];
  wholeWord: boolean;
}

export interface SemanticSearchRequest {
  embeddingSetId: string;
  limit?: number;
  query: string;
  rootIds: readonly string[];
}

const DEFAULT_TEXT_MAX_RESULTS = 200;
const TEXT_CONTEXT_LINES = 1;
const DEFAULT_SEMANTIC_LIMIT = 50;
const MIN_HYBRID_SOURCE_LIMIT = 50;

/** Escape JS regex metacharacters so a literal string can be embedded in a pattern. */
export function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derive the grep pattern + isRegex flag from a text-search request.
 * - literal + wholeWord: escape the literal, then wrap in `\b…\b` (now a regex).
 * - regex + wholeWord: wrap the regex source in `\b(?:…)\b` (no escaping).
 * - otherwise: pass the query/isRegex through unchanged.
 */
export function buildGrepPattern(req: Pick<TextSearchRequest, 'query' | 'isRegex' | 'wholeWord'>): {
  pattern: string;
  isRegex: boolean;
} {
  if (req.wholeWord) {
    const source = req.isRegex ? req.query : escapeRegExpLiteral(req.query);
    const wrapped = req.isRegex ? `\\b(?:${source})\\b` : `\\b${source}\\b`;
    return { isRegex: true, pattern: wrapped };
  }
  return { isRegex: req.isRegex, pattern: req.query };
}

interface MutableFileGroup {
  children: WorkspaceSearchTextMatch[];
  dbRootId: string;
  path: string;
  rootDisplayName: string | null;
}

/**
 * Group grep matches into per-(rootId, path) file results, dropping any match
 * that cannot be attributed to a workspace root or lacks chunk metadata (both
 * fold into `notices.skippedMissingLineMetadata` — an index row unusable for
 * the UI either way, never a silent drop).
 */
function groupGrepMatches(grepResult: GrepSearchResult): WorkspaceSearchResults {
  const groups = new Map<string, MutableFileGroup>();
  let skippedMissingLineMetadata = grepResult.skippedMissingLineMetadata;

  for (const match of grepResult.matches) {
    const child = toTextMatch(match);
    if (match.rootId === null || match.rootId === undefined || child === null) {
      skippedMissingLineMetadata += 1;
      continue;
    }
    const key = `${match.rootId} ${match.path}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        children: [],
        dbRootId: match.rootId,
        path: match.path,
        rootDisplayName: match.rootName ?? null,
      };
      groups.set(key, group);
    }
    group.children.push(child);
  }

  const files: WorkspaceSearchFileResult[] = Array.from(groups.values()).map((group) => ({
    children: group.children,
    dbRootId: group.dbRootId,
    path: group.path,
    rootDisplayName: group.rootDisplayName,
  }));

  return {
    files,
    mode: 'text',
    notices: {
      candidatesTruncated: grepResult.candidatesTruncated,
      scanLimited: grepResult.scanLimited,
      skippedMissingLineMetadata,
      truncated: grepResult.truncated,
    },
    totalMatches: grepResult.totalMatches,
  };
}

/** Converts a GrepMatch to a text-match child, or null if chunk metadata is incomplete. */
function toTextMatch(match: GrepMatch): WorkspaceSearchTextMatch | null {
  if (
    match.chunkId === undefined ||
    match.chunkStartLine === undefined ||
    match.chunkEndLine === undefined
  ) {
    return null;
  }
  return {
    after: match.after,
    before: match.before,
    chunkEndLine: match.chunkEndLine,
    chunkId: match.chunkId,
    chunkStartLine: match.chunkStartLine,
    kind: 'match',
    line: match.line,
    lineText: match.lineText,
    provenance: 'index',
  };
}

/**
 * Normalize hybrid RRF scores to 0–1 (as `use-semantic-search-executor.ts`
 * does) and return an id→normalized-score map for re-attaching to results.
 */
function normalizeHybridScores(results: readonly HybridSearchResult[]): Map<string, number> {
  const normalized = normalizeRRFScores(
    results.map((r) => ({
      contributions: [],
      id: r.chunk.id,
      rrfScore: r.rrfScore,
      sourceCount: r.sourceCount,
    }))
  );
  return new Map(normalized.map((r) => [r.id, r.rrfScore]));
}

interface MutableSemanticFileGroup {
  bestScore: number;
  children: WorkspaceSearchChunkHit[];
  fileRecordId: string;
}

interface GroupedSemanticResults {
  groups: ReadonlyMap<string, MutableSemanticFileGroup>;
  skippedMissingLineMetadata: number;
}

/**
 * Group hybrid results by `chunk.fileRecordId`. A chunk missing `startLine`/
 * `endLine` is dropped and counted in `skippedMissingLineMetadata` (unusable
 * index row, mirrors the text-mode contract).
 */
function groupSemanticResults(
  results: readonly HybridSearchResult[],
  scoreById: ReadonlyMap<string, number>
): GroupedSemanticResults {
  const groups = new Map<string, MutableSemanticFileGroup>();
  let skippedMissingLineMetadata = 0;

  for (const result of results) {
    const { chunk } = result;
    if (chunk.startLine === undefined || chunk.endLine === undefined) {
      skippedMissingLineMetadata += 1;
      continue;
    }
    const score = scoreById.get(chunk.id) ?? result.rrfScore;
    const child: WorkspaceSearchChunkHit = {
      chunkId: chunk.id,
      content: chunk.content,
      endLine: chunk.endLine,
      headline: result.headline ?? null,
      kind: 'chunk',
      provenance: 'index',
      score,
      startLine: chunk.startLine,
      tokenCount: chunk.tokenCount,
    };

    let group = groups.get(chunk.fileRecordId);
    if (!group) {
      group = { bestScore: score, children: [], fileRecordId: chunk.fileRecordId };
      groups.set(chunk.fileRecordId, group);
    }
    group.children.push(child);
    if (score > group.bestScore) {
      group.bestScore = score;
    }
  }

  return { groups, skippedMissingLineMetadata };
}

/**
 * Resolve each grouped file, dropping any group whose file cannot be
 * attributed to a workspace root (no resolved entry, or a legacy NULL root —
 * a scoping exclusion, not unusable-index noise, so it is never counted).
 * Files are ordered by best (max) score desc, children within a file by
 * score desc.
 */
async function buildSemanticResults(
  grouped: GroupedSemanticResults,
  resolveFiles: WorkspaceSearchExecutorDeps['resolveFiles']
): Promise<WorkspaceSearchResults> {
  const resolved = await resolveFiles(Array.from(grouped.groups.keys()));

  const scoredFiles: { bestScore: number; file: WorkspaceSearchFileResult }[] = [];
  let totalMatches = 0;

  for (const group of grouped.groups.values()) {
    const info = resolved.get(group.fileRecordId);
    if (!info || info.dbRootId === null) {
      continue;
    }
    const children = [...group.children].sort((a, b) => b.score - a.score);
    totalMatches += children.length;
    scoredFiles.push({
      bestScore: group.bestScore,
      file: {
        children,
        dbRootId: info.dbRootId,
        fileRecordId: group.fileRecordId,
        path: info.path,
        rootDisplayName: info.rootDisplayName,
      },
    });
  }

  scoredFiles.sort((a, b) => b.bestScore - a.bestScore);

  return {
    files: scoredFiles.map((s) => s.file),
    mode: 'semantic',
    notices: {
      candidatesTruncated: false,
      scanLimited: false,
      skippedMissingLineMetadata: grouped.skippedMissingLineMetadata,
      // NO semantic paging (Task P2): `truncated` is hardcoded false — the
      // hybrid search always requests exactly `limit` results (no larger
      // candidate pool to page into), so there is nothing honest to page
      // through. If semantic gains its own limit/paging model later, this is
      // the seam to wire it; until then the UI's "Show more" affordance stays
      // text-mode only (see SearchResultsTree).
      truncated: false,
    },
    totalMatches,
  };
}

export class WorkspaceSearchExecutor {
  /** Shared by `searchText` and `searchSemantic` so either mode supersedes the other. */
  private requestSeq = 0;

  constructor(private readonly deps: WorkspaceSearchExecutorDeps) {}

  /** Rejects with the underlying error; resolves null if superseded by a newer request. */
  async searchText(req: TextSearchRequest): Promise<WorkspaceSearchResults | null> {
    this.requestSeq += 1;
    const seq = this.requestSeq;
    const { pattern, isRegex } = buildGrepPattern(req);

    const grepResult = await this.deps.grepService.search({
      caseSensitive: req.caseSensitive,
      contextLines: TEXT_CONTEXT_LINES,
      embeddingSetId: req.embeddingSetId,
      isRegex,
      maxResults: req.maxResults ?? DEFAULT_TEXT_MAX_RESULTS,
      pattern,
      rootIds: req.rootIds,
    });

    if (seq !== this.requestSeq) {
      return null;
    }
    return groupGrepMatches(grepResult);
  }

  /**
   * Rejects with the underlying error (including `embedQuery` rejections,
   * propagated untouched); resolves null if superseded by a newer request —
   * `searchText` and `searchSemantic` share `requestSeq`, so either mode
   * supersedes the other.
   */
  async searchSemantic(req: SemanticSearchRequest): Promise<WorkspaceSearchResults | null> {
    this.requestSeq += 1;
    const seq = this.requestSeq;

    const embedding = await this.deps.embedQuery(req.embeddingSetId, req.query);
    if (seq !== this.requestSeq) {
      return null;
    }

    const limit = req.limit ?? DEFAULT_SEMANTIC_LIMIT;
    const hybridResponse = await this.deps.hybridService.search(req.query, embedding, {
      embeddingSetId: req.embeddingSetId,
      ftsLimit: Math.max(MIN_HYBRID_SOURCE_LIMIT, limit),
      includeHeadline: true,
      limit,
      rootIds: req.rootIds,
      vectorLimit: Math.max(MIN_HYBRID_SOURCE_LIMIT, limit),
    });
    if (seq !== this.requestSeq) {
      return null;
    }

    const scoreById = normalizeHybridScores(hybridResponse.results);
    const grouped = groupSemanticResults(hybridResponse.results, scoreById);

    const built = await buildSemanticResults(grouped, this.deps.resolveFiles);
    if (seq !== this.requestSeq) {
      return null;
    }
    return built;
  }
}
