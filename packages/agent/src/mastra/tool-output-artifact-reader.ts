import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import {
  ArtifactCursorSchema,
  ArtifactPageSizeSchema,
  ArtifactSearchPatternSchema,
  type ReadToolOutputArtifactCursorInput,
  ReadToolOutputArtifactCursorInputSchema,
  requireSearchPatternForFlags,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import {
  decodeToolOutputArtifactContent,
  decodeToolOutputArtifactCursor,
  encodeToolOutputArtifactContent,
  encodeToolOutputArtifactCursor,
  isToolOutputArtifactCursor,
  isToolOutputArtifactPage,
  isToolOutputArtifactReference,
  TOOL_OUTPUT_ARTIFACT_DEFAULT_PAGE_BYTES,
  TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
  type ToolOutputArtifactPage,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import { assertSafeRegexSource } from '@brainstrike/utils';
import { z } from 'zod';
import {
  decodedTextModelOutputChars,
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
} from '../stream/tool-output-limits';
import {
  clipGrepProjectionLine,
  formatGrepContentHeader,
  formatGrepContentRow,
  GREP_MATCH_LINE_MAX_CHARS,
} from './grep-model-format';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const TEXT_ENCODER = new TextEncoder();

const ToolOutputArtifactReferenceSchema = z
  .object({
    byteLength: z.number().int().nonnegative(),
    expiresAt: z.string().min(1).max(64),
    format: z.enum(['json', 'text']),
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();

export { type ReadToolOutputArtifactCursorInput, ReadToolOutputArtifactCursorInputSchema };

export const ReadToolOutputArtifactInputSchema = z
  .object({
    artifactRef: ToolOutputArtifactReferenceSchema.optional(),
    caseSensitive: z.boolean().optional(),
    cursor: ArtifactCursorSchema.optional(),
    isRegex: z.boolean().optional(),
    maxBytes: ArtifactPageSizeSchema,
    mode: z.enum(['artifact', 'cursor']),
    pattern: ArtifactSearchPatternSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.mode === 'artifact') {
      if (!input.artifactRef) {
        context.addIssue({
          code: 'custom',
          message: 'artifactRef is required in artifact mode.',
          path: ['artifactRef'],
        });
      }
      if (input.cursor !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'cursor must be omitted in artifact mode.',
          path: ['cursor'],
        });
      }
      for (const field of ['caseSensitive', 'isRegex', 'pattern'] as const) {
        if (input[field] !== undefined) {
          context.addIssue({
            code: 'custom',
            message: `${field} must be omitted in artifact mode.`,
            path: [field],
          });
        }
      }
      return;
    }
    if (!input.cursor) {
      context.addIssue({
        code: 'custom',
        message: 'cursor is required in cursor mode.',
        path: ['cursor'],
      });
    }
    if (input.artifactRef !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'artifactRef must be omitted in cursor mode.',
        path: ['artifactRef'],
      });
    }
    requireSearchPatternForFlags(input, context);
  });

export type ReadToolOutputArtifactInput = z.infer<typeof ReadToolOutputArtifactInputSchema>;

export type ScopedToolOutputArtifactRangeResult =
  | {
      readonly bytes: Uint8Array;
      readonly endByte: number;
      readonly offsetByte: number;
      readonly reference: ToolOutputArtifactReference;
      readonly status: 'found';
    }
  | {
      readonly reference: ToolOutputArtifactReference;
      readonly status: 'expired';
    }
  | { readonly status: 'not_found' };

/**
 * Server-created read capability whose implementation closes over the current
 * resource and thread. Model input never contains those ownership ids.
 */
export interface ScopedToolOutputArtifactReader {
  readRange(input: {
    readonly artifactId: string;
    readonly limitBytes: number;
    readonly offsetByte: number;
  }): Promise<ScopedToolOutputArtifactRangeResult>;
}

export type ToolOutputArtifactReadFailureReason =
  | 'artifact_expired'
  | 'artifact_incoherent'
  | 'artifact_not_found'
  | 'invalid_input'
  | 'invalid_search_pattern'
  | 'malformed_cursor'
  | 'non_progress'
  | 'storage_failed';

function messageForReadFailure(reason: ToolOutputArtifactReadFailureReason): string {
  switch (reason) {
    case 'artifact_expired':
      return 'The tool output artifact has expired.';
    case 'artifact_incoherent':
      return 'The tool output artifact no longer matches its reference.';
    case 'artifact_not_found':
      return 'The tool output artifact is unavailable in this thread.';
    case 'invalid_input':
      return 'The tool output artifact read input is invalid.';
    case 'invalid_search_pattern':
      return 'The tool output artifact search pattern is invalid.';
    case 'malformed_cursor':
      return 'The tool output artifact continuation cursor is malformed.';
    case 'non_progress':
      return 'The tool output artifact reader could not advance.';
    case 'storage_failed':
      return 'The tool output artifact storage read failed.';
  }
}

export class ToolOutputArtifactReadError extends Error {
  constructor(
    readonly reason: ToolOutputArtifactReadFailureReason,
    cause?: unknown,
    /**
     * Overrides the reason's generic message with a dynamic, specific one
     * (e.g. echoing which field/pattern was the problem) so this failure is
     * never indistinguishable from an unrelated `invalid_input`/`malformed_cursor`
     * case sharing the same reason code.
     */
    message?: string
  ) {
    super(message ?? messageForReadFailure(reason), {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = 'ToolOutputArtifactReadError';
  }
}

export interface ReadToolOutputArtifactPageOptions {
  readonly now?: () => Date;
  readonly reader: ScopedToolOutputArtifactReader;
}

const TOOL_OUTPUT_ARTIFACT_READER_TOOL_ID = NATIVE_TOOL_ID.readToolOutputArtifact;

/**
 * Search's SCAN window, decoupled from the page/projection byte budget
 * (`maxBytes`, capped at TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES = 8000). A
 * search call that only scanned one page-sized slice per call would need the
 * same number of round-trips as plain paging to find a deep match, defeating
 * the whole motivation for search over paging. 16x the max page bytes
 * (128,000 bytes / ~125KB) meaningfully reduces round-trips for a
 * multi-hundred-KB artifact while staying a bounded, predictable per-call
 * read cost — far short of reading an entire (up to 16MB,
 * TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES) artifact in one call. The
 * window is assembled from consecutive repository reads of at most
 * TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES each (the repository rejects larger
 * ranges); see readArtifactBytes. The
 * RENDERED matches stay bounded by the unchanged domain projection budget
 * (MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) via the standard
 * fit-with-continuation loop in projectToolOutputArtifactSearchResult: a
 * caller may still request a smaller scan explicitly via `maxBytes` (bounded
 * as before), but omitting it now defaults to this larger scan rather than
 * the small page default.
 */
const TOOL_OUTPUT_ARTIFACT_SEARCH_SCAN_BYTES = TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES * 16;

interface ToolOutputArtifactModelPage {
  readonly complete?: true;
  readonly content: string;
  readonly contentEncoding?: ToolOutputArtifactPage['contentEncoding'];
  readonly endByte: number;
  readonly format: ToolOutputArtifactReference['format'];
  readonly next?: {
    readonly input: {
      readonly cursor: string;
    };
    readonly tool: string;
  };
  readonly offsetByte: number;
}

export interface ToolOutputArtifactModelProjection {
  readonly type: 'json';
  readonly value: ToolOutputArtifactModelPage;
}

interface ToolOutputArtifactSearchMatch {
  readonly line: number;
  readonly lineText: string;
  readonly offsetByte: number;
}

export interface ToolOutputArtifactSearchResult {
  readonly artifactRef: ToolOutputArtifactReference;
  readonly endByte: number;
  readonly matches: readonly ToolOutputArtifactSearchMatch[];
  readonly nextCursor?: string;
  readonly offsetByte: number;
  readonly searchLimited: boolean;
  readonly type: 'artifact_search';
}

export interface ToolOutputArtifactSearchProjection {
  readonly type: 'text';
  readonly value: string;
}

export type ToolOutputArtifactModelOutput =
  | ToolOutputArtifactModelProjection
  | ToolOutputArtifactSearchProjection;

function referencesMatch(
  left: ToolOutputArtifactReference,
  right: ToolOutputArtifactReference
): boolean {
  return (
    left.id === right.id &&
    left.format === right.format &&
    left.byteLength === right.byteLength &&
    left.expiresAt === right.expiresAt
  );
}

function requireNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date && Number.isFinite(value.getTime()))) {
    throw new ToolOutputArtifactReadError(
      'storage_failed',
      new TypeError('Invalid artifact clock.')
    );
  }
  return new Date(value.getTime());
}

function decodeUtf8Prefix(bytes: Uint8Array, maximumBytes: number): string {
  const candidateLength = Math.min(bytes.byteLength, maximumBytes);
  for (let trim = 0; trim <= Math.min(3, candidateLength); trim += 1) {
    const end = candidateLength - trim;
    if (end === 0) {
      break;
    }
    try {
      return TEXT_DECODER.decode(bytes.subarray(0, end));
    } catch {}
  }
  throw new ToolOutputArtifactReadError('artifact_incoherent');
}

function serializedFieldByteLength(value: string): number {
  return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function fitProviderContent(decoded: string): {
  readonly content: string;
  readonly contentEncoding?: ToolOutputArtifactPage['contentEncoding'];
  readonly sourceByteLength: number;
} {
  const codePoints = Array.from(decoded);
  let low = 1;
  let high = codePoints.length;
  let best:
    | {
        readonly content: string;
        readonly contentEncoding?: ToolOutputArtifactPage['contentEncoding'];
        readonly sourceByteLength: number;
      }
    | undefined;

  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const source = codePoints.slice(0, kept).join('');
    const encoded = encodeToolOutputArtifactContent(source);
    if (
      encoded.content.length + 2 <= TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES &&
      serializedFieldByteLength(encoded.content) <= TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES
    ) {
      best = {
        content: encoded.content,
        ...(encoded.contentEncoding ? { contentEncoding: encoded.contentEncoding } : {}),
        sourceByteLength: TEXT_ENCODER.encode(source).byteLength,
      };
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }

  if (!best) {
    throw new ToolOutputArtifactReadError('non_progress');
  }
  return best;
}

function buildModelPage(
  page: ToolOutputArtifactPage,
  source: string,
  readerToolName: string
): ToolOutputArtifactModelProjection {
  const sourceByteLength = TEXT_ENCODER.encode(source).byteLength;
  const endByte = page.offsetByte + sourceByteLength;
  const encoded = encodeToolOutputArtifactContent(source);
  const nextCursor =
    endByte < page.artifactRef.byteLength
      ? encodeToolOutputArtifactCursor(page.artifactRef, endByte)
      : undefined;
  return {
    type: 'json',
    value: {
      content: encoded.content,
      ...(encoded.contentEncoding ? { contentEncoding: encoded.contentEncoding } : {}),
      endByte,
      format: page.artifactRef.format,
      ...(nextCursor
        ? {
            next: {
              input: { cursor: nextCursor },
              tool: readerToolName,
            },
          }
        : { complete: true as const }),
      offsetByte: page.offsetByte,
    },
  };
}

/**
 * Purpose-built model projection for a raw artifact page.
 *
 * If JSON escaping plus continuation metadata would exceed the domain budget,
 * the model sees a shorter byte-exact prefix and a recomputed cursor. The raw
 * page remains unchanged for display and persistence.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolOutputArtifactSearchResult(value: unknown): value is ToolOutputArtifactSearchResult {
  if (!(isRecord(value) && value['type'] === 'artifact_search')) {
    return false;
  }
  const matches = value['matches'];
  return (
    isToolOutputArtifactReference(value['artifactRef']) &&
    Number.isSafeInteger(value['endByte']) &&
    (value['endByte'] as number) >= 0 &&
    Array.isArray(matches) &&
    matches.every(
      (match) =>
        isRecord(match) &&
        Number.isSafeInteger(match['line']) &&
        (match['line'] as number) > 0 &&
        typeof match['lineText'] === 'string' &&
        Number.isSafeInteger(match['offsetByte']) &&
        (match['offsetByte'] as number) >= 0
    ) &&
    (value['nextCursor'] === undefined || isToolOutputArtifactCursor(value['nextCursor'])) &&
    Number.isSafeInteger(value['offsetByte']) &&
    (value['offsetByte'] as number) >= 0 &&
    typeof value['searchLimited'] === 'boolean'
  );
}

function searchContinuation(
  result: ToolOutputArtifactSearchResult,
  kept: number,
  readerToolName: string
): string | null {
  let cursor: string | undefined;
  if (kept < result.matches.length) {
    const nextMatch = result.matches[kept];
    if (nextMatch && nextMatch.offsetByte > result.offsetByte) {
      cursor = encodeToolOutputArtifactCursor(result.artifactRef, nextMatch.offsetByte);
    }
  } else if (result.searchLimited) {
    cursor = result.nextCursor;
  }
  if (kept < result.matches.length || result.searchLimited) {
    if (!cursor) {
      throw new TypeError(
        'Tool output artifact search projection received a limited result without continuation guidance'
      );
    }
    return `continue: reuse the prior ${readerToolName} search input with cursor=${cursor}`;
  }
  return null;
}

function projectToolOutputArtifactSearchResult(
  result: ToolOutputArtifactSearchResult,
  domainModelResultCharBudget: number,
  readerToolName: string
): ToolOutputArtifactSearchProjection {
  const artifactLine = `artifact bytes ${result.offsetByte}-${result.endByte}`;
  const keptRows: string[] = [];
  let kept = 0;
  for (const match of result.matches) {
    const candidateKept = kept + 1;
    const row = formatGrepContentRow(
      match.line,
      clipGrepProjectionLine(match.lineText, GREP_MATCH_LINE_MAX_CHARS, 'line')
    );
    const continuation = searchContinuation(result, candidateKept, readerToolName);
    const candidateLines = [
      formatGrepContentHeader({
        kept: candidateKept,
        lowerBound: result.searchLimited,
        offset: 0,
        total: result.matches.length,
      }),
      artifactLine,
      ...keptRows,
      row,
      ...(continuation ? [continuation] : []),
    ];
    if (decodedTextModelOutputChars(candidateLines.join('\n')) > domainModelResultCharBudget) {
      break;
    }
    keptRows.push(row);
    kept = candidateKept;
  }
  const continuation = searchContinuation(result, kept, readerToolName);
  const lines = [
    formatGrepContentHeader({
      kept,
      lowerBound: result.searchLimited,
      offset: 0,
      total: result.matches.length,
    }),
    artifactLine,
    ...keptRows,
    ...(continuation ? [continuation] : []),
  ];
  if (decodedTextModelOutputChars(lines.join('\n')) > domainModelResultCharBudget) {
    throw new RangeError(
      `Tool output artifact search projection exceeds the ${domainModelResultCharBudget}-character domain budget`
    );
  }
  return { type: 'text', value: lines.join('\n') };
}

export function projectToolOutputArtifactPage(
  output: ToolOutputArtifactPage,
  domainModelResultCharBudget?: number,
  readerToolName?: string
): ToolOutputArtifactModelProjection;
export function projectToolOutputArtifactPage(
  output: ToolOutputArtifactSearchResult,
  domainModelResultCharBudget?: number,
  readerToolName?: string
): ToolOutputArtifactSearchProjection;
export function projectToolOutputArtifactPage(
  output: unknown,
  domainModelResultCharBudget?: number,
  readerToolName?: string
): ToolOutputArtifactModelOutput;
export function projectToolOutputArtifactPage(
  output: unknown,
  domainModelResultCharBudget: number = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  readerToolName: string = TOOL_OUTPUT_ARTIFACT_READER_TOOL_ID
): ToolOutputArtifactModelOutput {
  if (isToolOutputArtifactSearchResult(output)) {
    return projectToolOutputArtifactSearchResult(
      output,
      domainModelResultCharBudget,
      readerToolName
    );
  }
  if (!isToolOutputArtifactPage(output)) {
    throw new TypeError('Tool output artifact reader returned an invalid page.');
  }
  const decoded = decodeToolOutputArtifactContent(output.content, output.contentEncoding);
  if (decoded.length === 0) {
    return buildModelPage(output, decoded, readerToolName);
  }

  // Completion replaces the comparatively large continuation cursor with one
  // boolean, so the fit predicate is not monotonic at the final code point.
  // Prefer the complete page when it fits before binary-searching the strictly
  // cursor-bearing prefixes.
  const completePage = buildModelPage(output, decoded, readerToolName);
  if (JSON.stringify(completePage).length <= domainModelResultCharBudget) {
    return completePage;
  }

  const codePoints = Array.from(decoded);
  let low = 1;
  let high = codePoints.length - 1;
  let best: ToolOutputArtifactModelProjection | undefined;
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const candidate = buildModelPage(output, codePoints.slice(0, kept).join(''), readerToolName);
    if (JSON.stringify(candidate).length <= domainModelResultCharBudget) {
      best = candidate;
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }
  if (!best) {
    throw new RangeError('Tool output artifact model projection could not retain one code point.');
  }
  return best;
}

interface DecodedArtifactSlice {
  readonly artifactRef: ToolOutputArtifactReference;
  readonly decoded: string;
  readonly endByte: number;
  readonly offsetByte: number;
}

/**
 * Read `byteCount` bytes starting at `offsetByte` as consecutive repository
 * reads of at most TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES each (the repository
 * rejects a larger `limitBytes`; it is deliberately neither raised nor
 * clamped there). Every page is validated against the reference on its own,
 * then the pages are joined byte-exactly BEFORE any UTF-8 decoding or line
 * splitting, so a match or a multi-byte character straddling a page seam is
 * indistinguishable from one read of the whole range.
 *
 * At least one repository read is always issued, even for `byteCount === 0`
 * (an offset at the end of the artifact), so scope, expiry and reference
 * coherence are still checked on that path.
 */
async function readArtifactBytes(args: {
  readonly artifactRef: ToolOutputArtifactReference;
  readonly byteCount: number;
  readonly offsetByte: number;
  readonly options: ReadToolOutputArtifactPageOptions;
}): Promise<Uint8Array> {
  const { artifactRef, byteCount, offsetByte, options } = args;
  const now = options.now ?? (() => new Date());
  const bytes = new Uint8Array(byteCount);
  let filled = 0;
  do {
    const pageOffset = offsetByte + filled;
    const pageLimit = Math.max(
      1,
      Math.min(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES, byteCount - filled)
    );
    const result = requireAvailableRange(
      await readScopedRange(options.reader, {
        artifactId: artifactRef.id,
        limitBytes: pageLimit,
        offsetByte: pageOffset,
      }),
      artifactRef,
      now
    );
    validateFoundRange({
      expectedBytes: Math.min(pageLimit, artifactRef.byteLength - pageOffset),
      offsetByte: pageOffset,
      reference: artifactRef,
      result,
    });
    bytes.set(result.bytes, filled);
    filled += result.bytes.byteLength;
  } while (filled < byteCount);
  return bytes;
}

async function readDecodedArtifactSlice(
  input: ReadToolOutputArtifactInput,
  options: ReadToolOutputArtifactPageOptions,
  defaultMaxBytes: number = TOOL_OUTPUT_ARTIFACT_DEFAULT_PAGE_BYTES
): Promise<DecodedArtifactSlice> {
  const { artifactRef, offsetByte } = resolveReadPosition(input);
  // An explicit caller maxBytes (bounded by ArtifactPageSizeSchema, max
  // TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES) always wins; otherwise fall back to
  // the caller-supplied default, which differs by call site: plain paging
  // defaults to the small page/projection size, search defaults to the much
  // larger TOOL_OUTPUT_ARTIFACT_SEARCH_SCAN_BYTES (see readToolOutputArtifactSearch).
  const maxBytes = input.maxBytes ?? defaultMaxBytes;
  const remainingBytes = artifactRef.byteLength - offsetByte;
  const bytes = await readArtifactBytes({
    artifactRef,
    byteCount: Math.min(remainingBytes, maxBytes),
    offsetByte,
    options,
  });
  if (remainingBytes === 0) {
    return { artifactRef, decoded: '', endByte: offsetByte, offsetByte };
  }
  const decoded = decodeUtf8Prefix(bytes, maxBytes);
  const endByte = offsetByte + TEXT_ENCODER.encode(decoded).byteLength;
  if (endByte <= offsetByte) {
    throw new ToolOutputArtifactReadError('non_progress');
  }
  return { artifactRef, decoded, endByte, offsetByte };
}

function createSearchMatcher(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean
): (line: string) => boolean {
  if (isRegex) {
    // Model-supplied regex source is run per line across the scanned slice,
    // same shape of risk as the workspace grep matcher (grep-search-service.ts)
    // and the glob path filter. Reject over-long or catastrophic-backtracking
    // shapes BEFORE compiling; never silently fall back to literal matching.
    let regex: RegExp;
    try {
      assertSafeRegexSource(pattern);
      regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch (cause) {
      // Reason AND message are both pattern-specific here (never the generic
      // invalid_input text) so the model can tell its pattern was the
      // problem instead of retrying blindly against an unrelated field.
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new ToolOutputArtifactReadError(
        'invalid_search_pattern',
        cause,
        `The tool output artifact search pattern is invalid: ${detail}`
      );
    }
    return (line) => regex.test(line);
  }
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
}

function findSearchMatches(
  decoded: string,
  offsetByte: number,
  matchesLine: (line: string) => boolean
): ToolOutputArtifactSearchMatch[] {
  const matches: ToolOutputArtifactSearchMatch[] = [];
  const lineBreaks = /\r\n|\r|\n/gu;
  let line = 1;
  let lineStartCodeUnit = 0;
  let lineStartByte = offsetByte;
  for (let lineBreak = lineBreaks.exec(decoded); lineBreak; lineBreak = lineBreaks.exec(decoded)) {
    const lineText = decoded.slice(lineStartCodeUnit, lineBreak.index);
    if (matchesLine(lineText)) {
      matches.push({ line, lineText, offsetByte: lineStartByte });
    }
    const consumed = decoded.slice(lineStartCodeUnit, lineBreaks.lastIndex);
    lineStartByte += TEXT_ENCODER.encode(consumed).byteLength;
    lineStartCodeUnit = lineBreaks.lastIndex;
    line += 1;
  }
  // A slice ending exactly at a line break (or an empty slice) leaves no
  // trailing partial line: `decoded.slice(lineStartCodeUnit)` is '' with
  // nothing real behind it. Handing that '' to the matcher would emit a
  // phantom row for a line that does not exist whenever the pattern can
  // match an empty string (`^$`, `.*`, `\d*`). A GENUINE blank line in the
  // middle of the content is unaffected: it is matched inside the loop
  // above, against the real '' between two consecutive line breaks.
  const lineText = decoded.slice(lineStartCodeUnit);
  if (lineText.length > 0 && matchesLine(lineText)) {
    matches.push({ line, lineText, offsetByte: lineStartByte });
  }
  return matches;
}

/**
 * Index one past the last complete line-break sequence in `text`, or -1 if
 * none exists. A trailing bare `\r` at the very end of `text` is never
 * treated as the alignment boundary: its `\n` may have fallen just past the
 * byte window, and cutting there would split one CRLF line break across two
 * search calls (a narrow, benign edge case — worst case a single spurious
 * empty-line entry, never a missed match or a false anchor match, so it is
 * intentionally not chased further than this).
 */
function lastLineBreakEnd(text: string): number {
  const pattern = /\r\n|\r|\n/gu;
  let end = -1;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const isTrailingBareCarriageReturn = match[0] === '\r' && pattern.lastIndex === text.length;
    if (!isTrailingBareCarriageReturn) {
      end = pattern.lastIndex;
    }
  }
  return end;
}

/**
 * Trim a raw byte-bounded search slice back to its last complete line
 * boundary so every line handed to the matcher is real: never a fragment
 * artificially split by the maxBytes window. Without this, a literal
 * straddling a page boundary is never found (each half is tested as if it
 * were a whole line) and `^`/`$` anchors falsely match at the artificial
 * fragment edges instead of true line start/end.
 *
 * The trimmed tail is not lost: it is re-scanned whole, from its real start,
 * on the next call once the cursor resumes at the recomputed `endByte`.
 *
 * When the raw slice already reaches the true end of the artifact, the
 * trailing content — even without a line terminator — is a genuine final
 * line and is returned unmodified.
 *
 * When no line-break exists anywhere in the raw slice and more of the
 * artifact remains, one line spans at least the whole maxBytes window. That
 * line cannot be searched as a complete unit within this budget: rather than
 * silently scanning a partial fragment (reintroducing the same straddling
 * bug), this throws a visible, actionable error. The model can retry with a
 * larger maxBytes (up to TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES) or fall back to
 * cursor paging, which has no line-alignment requirement.
 */
function alignSearchSliceToLineBoundary(slice: DecodedArtifactSlice): {
  readonly decoded: string;
  readonly endByte: number;
} {
  const { artifactRef, decoded, endByte, offsetByte } = slice;
  if (endByte >= artifactRef.byteLength) {
    return { decoded, endByte };
  }
  const boundary = lastLineBreakEnd(decoded);
  if (boundary === -1) {
    throw new ToolOutputArtifactReadError(
      'invalid_input',
      new RangeError(
        `Tool output artifact search line exceeds the ${TEXT_ENCODER.encode(decoded).byteLength}-byte scan window starting at offset ${offsetByte}; increase maxBytes (max ${TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES}) or use cursor paging for this region.`
      )
    );
  }
  const truncated = decoded.slice(0, boundary);
  return { decoded: truncated, endByte: offsetByte + TEXT_ENCODER.encode(truncated).byteLength };
}

async function readToolOutputArtifactSearch(
  input: ReadToolOutputArtifactInput & { readonly pattern: string },
  options: ReadToolOutputArtifactPageOptions
): Promise<ToolOutputArtifactSearchResult> {
  const slice = await readDecodedArtifactSlice(
    input,
    options,
    TOOL_OUTPUT_ARTIFACT_SEARCH_SCAN_BYTES
  );
  const aligned = alignSearchSliceToLineBoundary(slice);
  const matches = findSearchMatches(
    aligned.decoded,
    slice.offsetByte,
    createSearchMatcher(input.pattern, input.isRegex ?? false, input.caseSensitive ?? false)
  );
  const searchLimited = aligned.endByte < slice.artifactRef.byteLength;
  return {
    artifactRef: slice.artifactRef,
    endByte: aligned.endByte,
    matches,
    ...(searchLimited
      ? { nextCursor: encodeToolOutputArtifactCursor(slice.artifactRef, aligned.endByte) }
      : {}),
    offsetByte: slice.offsetByte,
    searchLimited,
    type: 'artifact_search',
  };
}

export function readToolOutputArtifact(
  unsafeInput: ReadToolOutputArtifactInput & { readonly pattern: string },
  options: ReadToolOutputArtifactPageOptions
): Promise<ToolOutputArtifactSearchResult>;
export function readToolOutputArtifact(
  unsafeInput: unknown,
  options: ReadToolOutputArtifactPageOptions
): Promise<ToolOutputArtifactPage | ToolOutputArtifactSearchResult>;
export async function readToolOutputArtifact(
  unsafeInput: unknown,
  options: ReadToolOutputArtifactPageOptions
): Promise<ToolOutputArtifactPage | ToolOutputArtifactSearchResult> {
  const input = parseReadInput(unsafeInput);
  if (input.pattern !== undefined) {
    return readToolOutputArtifactSearch({ ...input, pattern: input.pattern }, options);
  }
  return readToolOutputArtifactPage(input, options);
}

function validateFoundRange(args: {
  readonly expectedBytes: number;
  readonly offsetByte: number;
  readonly reference: ToolOutputArtifactReference;
  readonly result: Extract<ScopedToolOutputArtifactRangeResult, { status: 'found' }>;
}): void {
  const { expectedBytes, offsetByte, reference, result } = args;
  if (!referencesMatch(reference, result.reference)) {
    throw new ToolOutputArtifactReadError('artifact_incoherent');
  }
  if (result.bytes.byteLength === 0 && offsetByte < reference.byteLength) {
    throw new ToolOutputArtifactReadError('non_progress');
  }
  if (
    result.offsetByte !== offsetByte ||
    result.bytes.byteLength !== expectedBytes ||
    result.endByte !== offsetByte + result.bytes.byteLength ||
    result.endByte > reference.byteLength
  ) {
    throw new ToolOutputArtifactReadError('artifact_incoherent');
  }
}

function parseReadInput(unsafeInput: unknown): ReadToolOutputArtifactInput {
  const parsed = ReadToolOutputArtifactInputSchema.safeParse(unsafeInput);
  if (parsed.success) {
    return parsed.data;
  }
  const cursorInput =
    unsafeInput && typeof unsafeInput === 'object'
      ? (unsafeInput as { cursor?: unknown; mode?: unknown })
      : undefined;
  if (cursorInput?.mode === 'cursor' && !isToolOutputArtifactCursor(cursorInput.cursor)) {
    throw new ToolOutputArtifactReadError('malformed_cursor', parsed.error);
  }
  // Fail-fast regex validity (requireSearchPatternForFlags) surfaces here as
  // a zod issue on the `pattern` path; name the pattern as the problem in
  // the thrown message too, not just the generic invalid-input text, so it
  // is never indistinguishable from a bad cursor/other field.
  const patternIssue = parsed.error.issues.find((issue) => issue.path[0] === 'pattern');
  if (patternIssue) {
    throw new ToolOutputArtifactReadError(
      'invalid_search_pattern',
      parsed.error,
      `The tool output artifact search pattern is invalid: ${patternIssue.message}`
    );
  }
  throw new ToolOutputArtifactReadError('invalid_input', parsed.error);
}

function resolveReadPosition(input: ReadToolOutputArtifactInput): {
  readonly artifactRef: ToolOutputArtifactReference;
  readonly offsetByte: number;
} {
  if (input.mode === 'artifact') {
    if (!(input.artifactRef && isToolOutputArtifactReference(input.artifactRef))) {
      throw new ToolOutputArtifactReadError('invalid_input');
    }
    return { artifactRef: input.artifactRef, offsetByte: 0 };
  }
  if (!input.cursor) {
    throw new ToolOutputArtifactReadError('malformed_cursor');
  }
  try {
    return decodeToolOutputArtifactCursor(input.cursor);
  } catch (cause) {
    throw new ToolOutputArtifactReadError('malformed_cursor', cause);
  }
}

async function readScopedRange(
  reader: ScopedToolOutputArtifactReader,
  input: {
    readonly artifactId: string;
    readonly limitBytes: number;
    readonly offsetByte: number;
  }
): Promise<ScopedToolOutputArtifactRangeResult> {
  try {
    return await reader.readRange(input);
  } catch (cause) {
    if (cause instanceof ToolOutputArtifactReadError) {
      throw cause;
    }
    throw new ToolOutputArtifactReadError('storage_failed', cause);
  }
}

function requireAvailableRange(
  result: ScopedToolOutputArtifactRangeResult,
  artifactRef: ToolOutputArtifactReference,
  now: () => Date
): Extract<ScopedToolOutputArtifactRangeResult, { status: 'found' }> {
  if (result.status === 'not_found') {
    throw new ToolOutputArtifactReadError('artifact_not_found');
  }
  if (
    !(
      isToolOutputArtifactReference(result.reference) &&
      referencesMatch(artifactRef, result.reference)
    )
  ) {
    throw new ToolOutputArtifactReadError('artifact_incoherent');
  }
  if (
    result.status === 'expired' ||
    requireNow(now).getTime() >= Date.parse(artifactRef.expiresAt)
  ) {
    throw new ToolOutputArtifactReadError('artifact_expired');
  }
  return result;
}

export async function readToolOutputArtifactPage(
  unsafeInput: unknown,
  options: ReadToolOutputArtifactPageOptions
): Promise<ToolOutputArtifactPage> {
  const input = parseReadInput(unsafeInput);
  if (input.pattern !== undefined) {
    throw new ToolOutputArtifactReadError('invalid_input');
  }
  const { artifactRef, decoded, offsetByte } = await readDecodedArtifactSlice(input, options);
  if (offsetByte === artifactRef.byteLength) {
    return {
      artifactRef,
      content: '',
      endByte: offsetByte,
      offsetByte,
    };
  }
  const fitted = fitProviderContent(decoded);
  const endByte = offsetByte + fitted.sourceByteLength;
  if (endByte <= offsetByte) {
    throw new ToolOutputArtifactReadError('non_progress');
  }
  const page: ToolOutputArtifactPage = {
    artifactRef,
    content: fitted.content,
    ...(fitted.contentEncoding ? { contentEncoding: fitted.contentEncoding } : {}),
    endByte,
    ...(endByte < artifactRef.byteLength
      ? { nextCursor: encodeToolOutputArtifactCursor(artifactRef, endByte) }
      : {}),
    offsetByte,
  };
  if (!isToolOutputArtifactPage(page)) {
    throw new ToolOutputArtifactReadError('artifact_incoherent');
  }
  return page;
}
