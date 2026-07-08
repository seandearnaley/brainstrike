import type {
  GrepMatch,
  GrepSearchResult,
  GrepSearchService,
  HybridSearchService,
} from '@brainstrike/db';
import type {
  WorkspaceSearchFileResult,
  WorkspaceSearchResults,
  WorkspaceSearchTextMatch,
} from './search-result-model';

/** fileRecordId → resolved workspace-root/path info (Task 7's semantic grouping). */
export interface ResolvedFileInfo {
  dbRootId: string | null;
  path: string;
  rootDisplayName: string | null;
}

export interface WorkspaceSearchExecutorDeps {
  embedQuery: (embeddingSetId: string, text: string) => Promise<number[]>; // Task 7
  grepService: Pick<GrepSearchService, 'search'>;
  hybridService: Pick<HybridSearchService, 'search'>; // used in Task 7
  /** fileRecordId → { path, rootId, rootName } resolution for semantic grouping (Task 7). */
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

const DEFAULT_TEXT_MAX_RESULTS = 200;
const TEXT_CONTEXT_LINES = 1;

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

export class WorkspaceSearchExecutor {
  /** Shared with the future `searchSemantic` (Task 7) so either mode supersedes the other. */
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
}
