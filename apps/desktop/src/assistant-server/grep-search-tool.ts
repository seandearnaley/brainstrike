import type { GrepSearchInput, RuntimeData } from '@brainstrike/agent';
import {
  fitItemsToCharBudget,
  normalizeOptionalText,
  resolveWorkspaceIndexEmbeddingSetId,
} from '@brainstrike/agent';
import type { GrepMatch, GrepSearchResult } from '@brainstrike/db';
import { FileChunkRepository, GrepSearchService } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import type { PGlite } from '@electric-sql/pglite';
import { getDatabase } from '../db-main';

const logger = createLogger('AssistantGrepSearchTool');

export const GREP_SEARCH_TOOL_ID = 'brainstrike.grepSearch' as const;

const DEFAULT_CONTENT_MATCHES = 50;
/**
 * Internal match cap for 'files' mode aggregation. The service caps the
 * candidate pool at 500 files regardless, so this only bounds per-file match
 * counting, not the file scan itself.
 */
const FILES_MODE_INTERNAL_MATCH_CAP = 2000;

export interface GrepFileSummary {
  /** Line number of the first match in this file. */
  firstLine: number;
  /** Matches counted in this file (within the internal counting cap). */
  matchCount: number;
  path: string;
}

interface GrepToolResultBase {
  /** Phase-1 candidate pool hit its limit — more files may contain matches. */
  candidatesTruncated: boolean;
  /** Actionable next step when the result was truncated. */
  hint?: string;
  offset: number;
  /** Phase 1 ran without a trigram prefilter (regex had no extractable literal). */
  scanLimited: boolean;
  /** Unique (path, line) matches found (post-deduplication, pre-cap). */
  totalMatches: number;
  truncated: boolean;
}

export interface GrepFilesToolResult extends GrepToolResultBase {
  files: GrepFileSummary[];
  outputMode: 'files';
  totalFiles: number;
}

export interface GrepContentToolResult extends GrepToolResultBase {
  matches: GrepMatch[];
  outputMode: 'content';
  /** Chunks that matched but lack startLine metadata (cannot report path:line). */
  skippedMissingLineMetadata: number;
}

export type GrepToolResult = GrepFilesToolResult | GrepContentToolResult;

function aggregateFileSummaries(matches: readonly GrepMatch[]): GrepFileSummary[] {
  const byPath = new Map<string, GrepFileSummary>();
  for (const match of matches) {
    const existing = byPath.get(match.path);
    if (existing) {
      existing.matchCount += 1;
      existing.firstLine = Math.min(existing.firstLine, match.line);
    } else {
      byPath.set(match.path, { path: match.path, matchCount: 1, firstLine: match.line });
    }
  }
  return Array.from(byPath.values()).sort(
    (a, b) => b.matchCount - a.matchCount || a.path.localeCompare(b.path)
  );
}

function buildFilesResult(serviceResult: GrepSearchResult, offset: number): GrepFilesToolResult {
  const allFiles = aggregateFileSummaries(serviceResult.matches);
  const pagedFiles = allFiles.slice(offset);

  // The hint is part of the fitted candidate so it can never push the final
  // result back over the budget.
  const { result } = fitItemsToCharBudget(pagedFiles, (files): GrepFilesToolResult => {
    // Truncated when files were dropped (by paging or budget fitting) or the
    // service hit its internal match cap (per-file counts may be incomplete).
    const truncated = files.length + offset < allFiles.length || serviceResult.truncated;
    // A continuation hint must always ADVANCE: if even one summary cannot fit
    // the budget, skip past it rather than re-suggesting the same offset.
    const nextOffset =
      files.length === 0 && pagedFiles.length > 0 ? offset + 1 : offset + files.length;
    const hint =
      truncated || serviceResult.candidatesTruncated
        ? `Showing ${files.length} of ${allFiles.length} matching files. ` +
          `Continue with offset: ${nextOffset}, or call again with outputMode: 'content' and ` +
          'filePaths set to the most relevant paths to see the matching lines.'
        : undefined;
    return {
      outputMode: 'files',
      files,
      totalFiles: allFiles.length,
      totalMatches: serviceResult.totalMatches,
      offset,
      truncated,
      candidatesTruncated: serviceResult.candidatesTruncated,
      scanLimited: serviceResult.scanLimited,
      ...(hint ? { hint } : {}),
    };
  });
  return result;
}

function buildContentHint(
  serviceResult: GrepSearchResult,
  offset: number,
  shownCount: number,
  hadPageItems: boolean,
  serviceCap: number
): string | undefined {
  const truncated = offset + shownCount < serviceResult.totalMatches;
  if (!truncated) {
    return;
  }
  // A single match (long line × contextLines) can exceed the whole budget; a
  // hint repeating the same offset would loop the model. Skip past it.
  if (shownCount === 0 && hadPageItems) {
    return (
      `The match at offset ${offset} is too large to display within the output budget ` +
      `(very long line). Continue with offset: ${offset + 1} and contextLines: 0, or scope with filePaths.`
    );
  }
  const nextOffset = offset + shownCount;
  // The service only materializes serviceCap matches, so offsets at/beyond the
  // cap can never return more data — make the cap terminal instead of
  // suggesting an offset that yields the same empty page.
  if (nextOffset >= serviceCap) {
    return (
      `Pagination cap reached (${serviceCap} of ${serviceResult.totalMatches} matches reachable by offset). ` +
      'Narrow with filePaths or a more specific pattern to see the remaining matches.'
    );
  }
  return (
    `Showing matches ${offset + 1}-${nextOffset} of ${serviceResult.totalMatches}. ` +
    `Continue with offset: ${nextOffset}, scope with filePaths, or set contextLines: 0 ` +
    'to fit more matches per call.'
  );
}

function buildContentResult(
  serviceResult: GrepSearchResult,
  offset: number,
  requestedMatches: number,
  serviceCap: number
): GrepContentToolResult {
  const pagedMatches = serviceResult.matches.slice(offset, offset + requestedMatches);

  const { result } = fitItemsToCharBudget(pagedMatches, (matches): GrepContentToolResult => {
    const truncated = offset + matches.length < serviceResult.totalMatches;
    const hint = buildContentHint(
      serviceResult,
      offset,
      matches.length,
      pagedMatches.length > 0,
      serviceCap
    );
    return {
      outputMode: 'content',
      matches,
      totalMatches: serviceResult.totalMatches,
      offset,
      truncated,
      candidatesTruncated: serviceResult.candidatesTruncated,
      scanLimited: serviceResult.scanLimited,
      skippedMissingLineMetadata: serviceResult.skippedMissingLineMetadata,
      ...(hint ? { hint } : {}),
    };
  });
  return result;
}

export async function runGrepSearch(
  input: GrepSearchInput,
  runtimeData: RuntimeData | undefined
): Promise<GrepToolResult> {
  const db = (await getDatabase()) as unknown as PGlite;
  const repository = new FileChunkRepository(db);
  const service = new GrepSearchService(repository);

  const embeddingSetId =
    normalizeOptionalText(runtimeData?.embeddingSetId) ??
    resolveWorkspaceIndexEmbeddingSetId(runtimeData) ??
    undefined;

  const outputMode = input.outputMode ?? 'files';
  const offset = input.offset ?? 0;
  const requestedMatches = input.maxResults ?? DEFAULT_CONTENT_MATCHES;
  // The service slices its accumulated matches to maxResults, so pagination
  // must request offset + page size; files mode counts matches per file and
  // needs the larger internal cap to keep counts meaningful.
  const serviceMaxResults =
    outputMode === 'files'
      ? FILES_MODE_INTERNAL_MATCH_CAP
      : Math.min(offset + requestedMatches, FILES_MODE_INTERNAL_MATCH_CAP);

  try {
    const serviceResult = await service.search({
      pattern: input.pattern,
      ...(input.isRegex === undefined ? {} : { isRegex: input.isRegex }),
      ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }),
      ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
      contextLines: outputMode === 'files' ? 0 : (input.contextLines ?? 1),
      maxResults: serviceMaxResults,
      ...(embeddingSetId === undefined ? {} : { embeddingSetId }),
    });

    return outputMode === 'files'
      ? buildFilesResult(serviceResult, offset)
      : buildContentResult(serviceResult, offset, requestedMatches, FILES_MODE_INTERNAL_MATCH_CAP);
  } catch (error) {
    logger.error('grepSearch failed', { error, pattern: input.pattern.slice(0, 100) });
    const message = error instanceof Error ? error.message : String(error);
    // Rethrow only known-safe service validation messages; everything else
    // (raw PGlite/SQL errors) maps to a generic message so internal details
    // never reach the model (same convention as retrieval-tool.ts).
    const knownSafeMessages = [
      /^Invalid regular expression pattern:/,
      /^Grep pattern must be at least \d+ characters/,
      /^findGrepCandidates filePaths limit exceeded/,
    ];
    if (knownSafeMessages.some((re) => re.test(message))) {
      throw error;
    }
    throw new Error('Unable to perform grep search right now. Try again.');
  }
}
