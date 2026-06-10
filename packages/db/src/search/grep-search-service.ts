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
}

export interface GrepMatch {
  after: string[];
  before: string[];
  line: number;
  lineText: string;
  path: string;
}

export interface GrepSearchResult {
  /** Phase-1 candidate pool hit its limit — more files may contain matches. */
  candidatesTruncated: boolean;
  matches: GrepMatch[];
  /** Phase 1 ran without a trigram prefilter (regex had no extractable literal). */
  scanLimited: boolean;
  /** Chunks that matched but lack startLine metadata (cannot report path:line). */
  skippedMissingLineMetadata: number;
  /** Matches found across scanned candidates before the maxResults cap. */
  totalMatches: number;
  truncated: boolean;
}

export const GREP_DEFAULT_MAX_RESULTS = 50;
export const GREP_DEFAULT_CONTEXT_LINES = 1;
export const GREP_DEFAULT_CANDIDATE_LIMIT = 500;
const MIN_PATTERN_LENGTH = 2;

interface LineMatcher {
  matches(line: string): boolean;
}

function buildLiteralMatcher(pattern: string, caseSensitive: boolean): LineMatcher {
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return {
    matches: (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle),
  };
}

function buildRegexMatcher(pattern: string, caseSensitive: boolean): LineMatcher {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression pattern: ${message}`);
  }
  return { matches: (line) => regex.test(line) };
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
    const key = `${candidate.filePath}:${absoluteLine}`;
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
    const matcher = isRegex
      ? buildRegexMatcher(pattern, caseSensitive)
      : buildLiteralMatcher(pattern, caseSensitive);
    const likePattern = resolveLikePattern(pattern, isRegex);

    const candidateOptions: GrepCandidateOptions = {
      likePattern,
      caseSensitive,
      limit: candidateLimit,
      ...(options.embeddingSetId === undefined ? {} : { embeddingSetId: options.embeddingSetId }),
      ...(options.filePaths === undefined ? {} : { filePaths: options.filePaths }),
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

    accumulator.matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
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
