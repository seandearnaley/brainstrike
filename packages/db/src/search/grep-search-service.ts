/**
 * Grep Search Service
 *
 * Two-phase grep over indexed file chunks:
 *   Phase 1 (SQL): trigram-accelerated ILIKE/LIKE candidate selection via
 *     GrepSearchRepository (idx_file_chunks_content_trgm). Regex patterns are
 *     prefiltered on their longest guaranteed literal (extractTrigramLiteral);
 *     patterns with no such literal fall back to a bounded scan, surfaced via
 *     scanLimited (never silent).
 *   Phase 2 (JS): authoritative per-line matching with real JS RegExp
 *     semantics, absolute line numbers from chunk startLine, context lines,
 *     (path, line) dedupe across overlapping chunks, and bounded output.
 */

import { assertSafeRegexSource } from '@brainstrike/utils';
import type { GrepCandidate, GrepCandidateOptions } from '../models/grep.js';
import { escapeLikeLiteral, extractTrigramLiteral } from './grep-pattern.js';

export interface GrepSearchRepository {
  findGrepCandidates(options: GrepCandidateOptions): Promise<GrepCandidate[]>;
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
}

export interface GrepMatch {
  after: string[];
  before: string[];
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
  /** Phase 1 ran without a trigram prefilter (regex had no extractable literal). */
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
 * Per-line match predicate. Shared between the indexed grep path (this service)
 * and the desktop live (ripgrep/JS-walk) pass so both produce IDENTICAL matches
 * for the same pattern — there is exactly one definition of "does this line
 * match", never a forked weaker copy.
 */
export interface LineMatcher {
  matches(line: string): boolean;
}

function buildLiteralMatcher(pattern: string, caseSensitive: boolean): LineMatcher {
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return {
    matches: (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle),
  };
}

function buildRegexMatcher(pattern: string, caseSensitive: boolean): LineMatcher {
  // ReDoS guard BEFORE compiling: this matcher runs the caller/model-supplied
  // regex per-line across up to maxLiveCandidateFiles whole files, so a
  // catastrophic-backtracking pattern would freeze the host. Reuse the shared
  // length + dangerous-shape guard (throws with a clear message; no silent
  // fallback). Covers both the indexed path and the desktop live-grep pass,
  // which share this matcher.
  assertSafeRegexSource(pattern);
  let regex: RegExp;
  try {
    // Never include 'g': the same regex instance is called per-line, and
    // the 'g' flag makes test() stateful (lastIndex), breaking per-line matching.
    regex = new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression pattern: ${message}`);
  }
  return { matches: (line) => regex.test(line) };
}

/**
 * Build the authoritative per-line matcher for a grep pattern. Literal patterns
 * use a (case-folded) substring test; regex patterns compile to a real JS
 * `RegExp` (an invalid pattern throws `Invalid regular expression pattern: …`).
 *
 * Exported so non-DB callers (the desktop live grep pass) match lines with the
 * exact same semantics as the indexed path.
 */
export function createGrepLineMatcher(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean
): LineMatcher {
  return isRegex
    ? buildRegexMatcher(pattern, caseSensitive)
    : buildLiteralMatcher(pattern, caseSensitive);
}

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
      path: args.path,
      line: args.startLine + index,
      lineText,
      before: lines.slice(Math.max(0, index - args.contextLines), index),
      after: lines.slice(index + 1, index + 1 + args.contextLines),
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
      path: candidate.filePath,
      line: absoluteLine,
      lineText,
      before: lines.slice(Math.max(0, index - contextLines), index),
      after: lines.slice(index + 1, index + 1 + contextLines),
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
      likePattern,
      caseSensitive,
      limit: candidateLimit,
      ...(options.embeddingSetId === undefined ? {} : { embeddingSetId: options.embeddingSetId }),
      ...(options.filePaths === undefined ? {} : { filePaths: options.filePaths }),
      ...(options.rootId === undefined ? {} : { rootId: options.rootId }),
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
      matches: capped,
      totalMatches: accumulator.totalMatches,
      truncated: accumulator.totalMatches > capped.length,
      scanLimited: likePattern === null,
      candidatesTruncated: candidates.length >= candidateLimit,
      skippedMissingLineMetadata: accumulator.skippedMissingLineMetadata,
    };
  }
}

export function createGrepSearchService(repository: GrepSearchRepository): GrepSearchService {
  return new GrepSearchService(repository);
}
