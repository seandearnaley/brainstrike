/**
 * Grep Search Service
 *
 * Two-phase grep over indexed file chunks:
 *   Phase 1 (SQL): trigram-accelerated ILIKE/LIKE candidate selection via
 *     GrepSearchRepository (idx_file_chunks_content_trgm). Regex patterns are
 *     prefiltered on their longest guaranteed literal (extractTrigramLiteral);
 *     patterns with no such literal fall back to a bounded unfiltered scan,
 *     surfaced via scanLimited when (and only when) that scan hit its
 *     candidate cap — under the cap the scan was exhaustive (never silent).
 *   Phase 2 (JS): authoritative per-line matching with real JS RegExp
 *     semantics, absolute line numbers from chunk startLine, context lines,
 *     (path, line) dedupe across overlapping chunks, and bounded output.
 */

import { createGrepLineMatcher, type LineMatcher } from '@brainstrike/utils/grep-line-matcher';

export { createGrepLineMatcher, type LineMatcher } from '@brainstrike/utils/grep-line-matcher';

import type { GrepCandidate, GrepCandidateOptions } from '../models/grep.js';
import { escapeLikeLiteral, extractTrigramLiteral } from './grep-pattern.js';

export interface GrepSearchRepository {
  findGrepCandidates: (options: GrepCandidateOptions) => Promise<GrepCandidate[]>;
}

export interface GrepSearchOptions {
  /** Bounded candidate-pool size for phase 1 (default 500). */
  candidateLimit?: number;
  /** Case-sensitive matching (default false). */
  caseSensitive?: boolean;
  /** Lines of context before/after each match, from within the chunk (0–5, default 1). */
  contextLines?: number;
  /** Optional embedding-set filter; dedupe also guards against cross-set duplicates. */
  embeddingSetId?: string;
  /** Optional exact-path allowlist. */
  filePaths?: readonly string[];
  /** Treat pattern as a JavaScript regular expression (default false: literal). */
  isRegex?: boolean;
  /** Maximum matches returned (default 50). */
  maxResults?: number;
  /** Literal text or JS regex source. Minimum 2 characters. */
  pattern: string;
  /** Optional workspace-root filter (file_records.root_id). */
  rootId?: string;
  /** Optional multi-root workspace filter (file_records.root_id ∈ rootIds). */
  rootIds?: readonly string[];
}

export interface GrepMatch {
  after: string[];
  before: string[];
  /** 1-based last line of the containing chunk within its file. */
  chunkEndLine?: number;
  /** Owning chunk id (file_chunks.id). */
  chunkId?: string;
  /** 1-based first line of the containing chunk within its file. */
  chunkStartLine?: number;
  line: number;
  lineText: string;
  path: string;
  /** Owning workspace root id; null for legacy/unrooted files. */
  rootId?: string | null;
  /** Owning workspace root display name; null when unrooted. */
  rootName?: string | null;
}

export interface GrepSearchResult {
  /** Phase-1 candidate pool hit its limit — more files may contain matches. */
  candidatesTruncated: boolean;
  matches: GrepMatch[];
  /**
   * Phase 1 ran without a trigram prefilter (regex had no extractable literal)
   * AND its bounded scan hit the candidate cap, so matches may have been
   * missed. False when the unfiltered scan stayed under the cap: it covered
   * every chunk in scope and the results are exhaustive.
   */
  scanLimited: boolean;
  /** Chunks that matched but lack startLine metadata (cannot report path:line). */
  skippedMissingLineMetadata: number;
  /** Unique (path, line) matches found before the maxResults cap (post-deduplication). */
  totalMatches: number;
  /** true when unique matches exceeded maxResults and some were discarded. */
  truncated: boolean;
}

export const GREP_DEFAULT_MAX_RESULTS = 50;
export const GREP_DEFAULT_CONTEXT_LINES = 1;
export const GREP_DEFAULT_CANDIDATE_LIMIT = 500;
const MIN_PATTERN_LENGTH = 2;

/**
 * Run `matcher` over the lines of one file's content and return the matching
 * lines as `GrepMatch`es with absolute line numbers and ±`contextLines` of
 * surrounding text. Pure (no DB) and shared with the live pass so live and
 * indexed matches are shaped identically (and thus mergeable / dedupable).
 *
 * `startLine` is the 1-based line number of the file's first line (always 1 for
 * a whole on-disk file; chunk-relative for the indexed path).
 */
export function collectGrepMatchesInContent(args: {
  content: string;
  matcher: LineMatcher;
  contextLines: number;
  path: string;
  startLine: number;
  rootId?: string | null;
  rootName?: string | null;
}): GrepMatch[] {
  const lines = args.content.split('\n');
  const matches: GrepMatch[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index] ?? '';
    if (!args.matcher.matches(lineText)) {
      continue;
    }
    matches.push({
      after: lines.slice(index + 1, index + 1 + args.contextLines),
      before: lines.slice(Math.max(0, index - args.contextLines), index),
      line: args.startLine + index,
      lineText,
      path: args.path,
      ...(args.rootId === undefined ? {} : { rootId: args.rootId }),
      ...(args.rootName === undefined ? {} : { rootName: args.rootName }),
    });
  }
  return matches;
}

function resolveLikePattern(pattern: string, isRegex: boolean): string | null {
  if (!isRegex) {
    return escapeLikeLiteral(pattern);
  }
  const literal = extractTrigramLiteral(pattern);
  return literal === null ? null : escapeLikeLiteral(literal);
}

interface MatchAccumulator {
  matches: GrepMatch[];
  seen: Set<string>;
  skippedMissingLineMetadata: number;
  totalMatches: number;
}

function processCandidate(
  candidate: GrepCandidate,
  lines: string[],
  matcher: LineMatcher,
  contextLines: number,
  accumulator: MatchAccumulator
): void {
  let candidateHasUnlocatableMatch = false;
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index] ?? '';
    if (!matcher.matches(lineText)) {
      continue;
    }
    if (candidate.startLine === null) {
      candidateHasUnlocatableMatch = true;
      continue;
    }
    const absoluteLine = candidate.startLine + index;
    // Root-qualify the dedupe key: two roots can hold the same relative path,
    // and a (path, line) key alone would silently collapse their matches.
    const key = `${candidate.rootId ?? ''}\u0000${candidate.filePath}:${absoluteLine}`;
    if (accumulator.seen.has(key)) {
      continue;
    }
    accumulator.seen.add(key);
    accumulator.totalMatches += 1;
    accumulator.matches.push({
      after: lines.slice(index + 1, index + 1 + contextLines),
      before: lines.slice(Math.max(0, index - contextLines), index),
      chunkId: candidate.chunkId,
      chunkStartLine: candidate.startLine,
      line: absoluteLine,
      lineText,
      path: candidate.filePath,
      ...(candidate.endLine === null ? {} : { chunkEndLine: candidate.endLine }),
      ...(candidate.rootId === undefined ? {} : { rootId: candidate.rootId }),
      ...(candidate.rootName === undefined ? {} : { rootName: candidate.rootName }),
    });
  }
  if (candidateHasUnlocatableMatch) {
    accumulator.skippedMissingLineMetadata += 1;
  }
}

export class GrepSearchService {
  constructor(private readonly repository: GrepSearchRepository) {}

  async search(options: GrepSearchOptions): Promise<GrepSearchResult> {
    const pattern = options.pattern;
    if (pattern.length < MIN_PATTERN_LENGTH) {
      throw new Error(`Grep pattern must be at least ${MIN_PATTERN_LENGTH} characters.`);
    }
    const isRegex = options.isRegex ?? false;
    const caseSensitive = options.caseSensitive ?? false;
    const contextLines = options.contextLines ?? GREP_DEFAULT_CONTEXT_LINES;
    const maxResults = options.maxResults ?? GREP_DEFAULT_MAX_RESULTS;
    const candidateLimit = options.candidateLimit ?? GREP_DEFAULT_CANDIDATE_LIMIT;

    // Build the matcher FIRST so an invalid regex fails before any DB work.
    const matcher = createGrepLineMatcher(pattern, isRegex, caseSensitive);
    const likePattern = resolveLikePattern(pattern, isRegex);

    const candidateOptions: GrepCandidateOptions = {
      caseSensitive,
      likePattern,
      limit: candidateLimit,
      ...(options.embeddingSetId === undefined ? {} : { embeddingSetId: options.embeddingSetId }),
      ...(options.filePaths === undefined ? {} : { filePaths: options.filePaths }),
      ...(options.rootId === undefined ? {} : { rootId: options.rootId }),
      ...(options.rootIds === undefined ? {} : { rootIds: options.rootIds }),
    };
    const candidates = await this.repository.findGrepCandidates(candidateOptions);

    const accumulator: MatchAccumulator = {
      matches: [],
      seen: new Set<string>(),
      skippedMissingLineMetadata: 0,
      totalMatches: 0,
    };

    for (const candidate of candidates) {
      const lines = candidate.content.split('\n');
      processCandidate(candidate, lines, matcher, contextLines, accumulator);
    }

    // Group by root first so multi-root output is stable and readable; fall
    // back to path then line (single-root output is unchanged: rootName empty).
    accumulator.matches.sort(
      (a, b) =>
        (a.rootName ?? '').localeCompare(b.rootName ?? '') ||
        a.path.localeCompare(b.path) ||
        a.line - b.line
    );
    const capped = accumulator.matches.slice(0, maxResults);

    return {
      candidatesTruncated: candidates.length >= candidateLimit,
      matches: capped,
      // An unprefilterable pattern falls back to a bounded unfiltered scan,
      // but the scan is only LIMITED when it actually hit the candidate cap —
      // under the cap it covered every chunk in scope and results are
      // exhaustive, so reporting scanLimited would falsely demand refinement.
      scanLimited: likePattern === null && candidates.length >= candidateLimit,
      skippedMissingLineMetadata: accumulator.skippedMissingLineMetadata,
      totalMatches: accumulator.totalMatches,
      truncated: accumulator.totalMatches > capped.length,
    };
  }
}

export function createGrepSearchService(repository: GrepSearchRepository): GrepSearchService {
  return new GrepSearchService(repository);
}
