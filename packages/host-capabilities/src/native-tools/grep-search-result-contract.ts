import { ToolProjectionInputRejectedError } from '@brainstrike/agent';
import type { GrepMatch } from '@brainstrike/assistant-contract';

export type GrepMatchSource = 'index' | 'live' | 'both';

export type LabeledGrepMatch = GrepMatch & { source: GrepMatchSource };

export type ModelFacingGrepMatch = Omit<
  LabeledGrepMatch,
  'chunkId' | 'chunkStartLine' | 'chunkEndLine'
>;

export interface GrepFileSummary {
  firstLine: number;
  matchCount: number;
  path: string;
  rootId?: string | null;
  rootName?: string | null;
  source: GrepMatchSource;
}

interface GrepToolResultBase {
  /**
   * Lowercased display names shared by MORE THAN ONE open root, present only
   * when non-empty. Ambiguity is a property of the FULL open-root inventory —
   * a page can contain one root of a twin pair, and `resolveWorkspaceRoot`
   * would still reject the shared name — so the producer computes this and
   * the projection falls back to root ids for these names (PR #2313 review).
   */
  ambiguousRootNames?: string[];
  candidatesTruncated: boolean;
  hint?: string;
  liveEngine: 'ripgrep' | 'js-walk' | 'js-files' | 'skipped';
  liveNote?: string;
  /**
   * BST-1188: set only by the repeated-identical-call loop guard on the 3rd
   * consecutive identical grepSearch call in a thread. Rendered as its OWN
   * `warning:` line — unlike `hint`, which the projection skips whenever the
   * page was already trimmed by the output-char budget, so a guard warning
   * folded into `hint` would silently vanish exactly on the large/expensive
   * repeats it exists to stop (PR #2323 review). Never producer-set outside
   * `tool-call-loop-guards.ts`.
   */
  loopGuardWarning?: string;
  offset: number;
  /**
   * Count of OPEN workspace roots, present only when more than one folder is
   * open. The projection prefixes each file header with its root name only in
   * that case (BST-1185) — the projector cannot know the open-root topology
   * from the matches alone (a page may happen to hit a single root even when
   * several are open, and the model still needs the root selector then).
   */
  openRoots?: number;
  /**
   * BST-1194: set only for a genuine zero-match result when a bounded steering
   * probe (case, literal-vs-regex, or excluded path) finds missed matches. The
   * model projection renders it as an additional `note:` line.
   */
  probeNote?: string;
  scanLimited: boolean;
  totalMatches: number;
  truncated: boolean;
}

export interface GrepFilesToolResult extends GrepToolResultBase {
  files: GrepFileSummary[];
  outputMode: 'files';
  totalFiles: number;
}

export interface GrepContentToolResult extends GrepToolResultBase {
  matches: ModelFacingGrepMatch[];
  outputMode: 'content';
  skippedMissingLineMetadata: number;
}

export type GrepToolResult = GrepFilesToolResult | GrepContentToolResult;

/**
 * Replay-detection prefix for stored grep model projections. Deliberately the
 * COMMON prefix of both header generations: the legacy verbose header
 * (`grep content | page=…`, pre-BST-1185) and the compact header
 * (`grep content 1-2/61`) both start with `grep <mode> `, so stored
 * projections from old threads keep replaying byte-for-byte after the format
 * change instead of being rejected as malformed raw output.
 */
export function grepProjectionHeaderPrefix(outputMode: GrepToolResult['outputMode']): string {
  return `grep ${outputMode} `;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function valueKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

// The marker matters: the runtime dispatcher fails soft ONLY on
// `ToolProjectionInputRejectedError` (shape rejection — the value is not a
// grep result at all), while deliberate invariant throws in the projector
// (e.g. a truncated result without continuation guidance) stay plain and
// keep failing the run. `runGrepSearch`'s own output validation also lands
// here; inside `execute` the guard converts any throw, so marking is inert.
function rejectField(path: string, expected: string, value: unknown): never {
  throw new ToolProjectionInputRejectedError(
    `grepSearch model projection rejected ${path}: expected ${expected}, received ${valueKind(value)}`
  );
}

function requireOptionalString(
  record: Record<string, unknown>,
  field: 'hint' | 'liveNote' | 'loopGuardWarning' | 'probeNote'
): void {
  const value = record[field];
  if (value !== undefined && typeof value !== 'string') {
    rejectField(field, 'string or absent', value);
  }
}

function requireOptionalRootLabel(
  record: Record<string, unknown>,
  path: string,
  field: 'rootId' | 'rootName'
): void {
  const value = record[field];
  if (value !== undefined && value !== null && typeof value !== 'string') {
    rejectField(`${path}.${field}`, 'string, null, or absent', value);
  }
}

function requireMatchSource(record: Record<string, unknown>, path: string): void {
  const source = record['source'];
  if (!(source === 'index' || source === 'live' || source === 'both')) {
    rejectField(`${path}.source`, '"index", "live", or "both"', source);
  }
}

function requireGrepBase(record: Record<string, unknown>): void {
  if (typeof record['candidatesTruncated'] !== 'boolean') {
    rejectField('candidatesTruncated', 'boolean', record['candidatesTruncated']);
  }
  if (
    !(
      record['liveEngine'] === 'ripgrep' ||
      record['liveEngine'] === 'js-walk' ||
      record['liveEngine'] === 'js-files' ||
      record['liveEngine'] === 'skipped'
    )
  ) {
    rejectField(
      'liveEngine',
      '"ripgrep", "js-walk", "js-files", or "skipped"',
      record['liveEngine']
    );
  }
  requireOptionalString(record, 'hint');
  requireOptionalString(record, 'liveNote');
  requireOptionalString(record, 'probeNote');
  requireOptionalString(record, 'loopGuardWarning');
  if (!isNonNegativeInteger(record['offset'])) {
    rejectField('offset', 'non-negative integer', record['offset']);
  }
  const openRoots = record['openRoots'];
  if (openRoots !== undefined && !isPositiveInteger(openRoots)) {
    rejectField('openRoots', 'positive integer or absent', openRoots);
  }
  const ambiguousRootNames = record['ambiguousRootNames'];
  if (
    ambiguousRootNames !== undefined &&
    !(
      Array.isArray(ambiguousRootNames) &&
      ambiguousRootNames.every((name) => typeof name === 'string')
    )
  ) {
    rejectField('ambiguousRootNames', 'string array or absent', ambiguousRootNames);
  }
  if (typeof record['scanLimited'] !== 'boolean') {
    rejectField('scanLimited', 'boolean', record['scanLimited']);
  }
  if (!isNonNegativeInteger(record['totalMatches'])) {
    rejectField('totalMatches', 'non-negative integer', record['totalMatches']);
  }
  if (typeof record['truncated'] !== 'boolean') {
    rejectField('truncated', 'boolean', record['truncated']);
  }
}

function requireGrepFileSummary(value: unknown, index: number): void {
  const path = `files[${index}]`;
  if (!isRecord(value)) {
    rejectField(path, 'object', value);
  }
  if (!isPositiveInteger(value['firstLine'])) {
    rejectField(`${path}.firstLine`, 'positive integer', value['firstLine']);
  }
  if (!isNonNegativeInteger(value['matchCount'])) {
    rejectField(`${path}.matchCount`, 'non-negative integer', value['matchCount']);
  }
  if (typeof value['path'] !== 'string') {
    rejectField(`${path}.path`, 'string', value['path']);
  }
  requireOptionalRootLabel(value, path, 'rootId');
  requireOptionalRootLabel(value, path, 'rootName');
  requireMatchSource(value, path);
}

function requireStringArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    rejectField(path, 'string array', value);
  }
  const invalidIndex = value.findIndex((item) => typeof item !== 'string');
  if (invalidIndex >= 0) {
    rejectField(`${path}[${invalidIndex}]`, 'string', value[invalidIndex]);
  }
}

function requireGrepMatch(value: unknown, index: number): void {
  const path = `matches[${index}]`;
  if (!isRecord(value)) {
    rejectField(path, 'object', value);
  }
  requireStringArray(value['after'], `${path}.after`);
  requireStringArray(value['before'], `${path}.before`);
  if (!isPositiveInteger(value['line'])) {
    rejectField(`${path}.line`, 'positive integer', value['line']);
  }
  if (typeof value['lineText'] !== 'string') {
    rejectField(`${path}.lineText`, 'string', value['lineText']);
  }
  if (typeof value['path'] !== 'string') {
    rejectField(`${path}.path`, 'string', value['path']);
  }
  requireOptionalRootLabel(value, path, 'rootId');
  requireOptionalRootLabel(value, path, 'rootName');
  requireMatchSource(value, path);
}

export function parseGrepToolResult(output: unknown): GrepToolResult {
  if (!isRecord(output)) {
    rejectField('result', 'object', output);
  }
  requireGrepBase(output);

  if (output['outputMode'] === 'files') {
    if (!Array.isArray(output['files'])) {
      rejectField('files', 'array', output['files']);
    }
    output['files'].forEach(requireGrepFileSummary);
    if (!isNonNegativeInteger(output['totalFiles'])) {
      rejectField('totalFiles', 'non-negative integer', output['totalFiles']);
    }
    return output as unknown as GrepFilesToolResult;
  }

  if (output['outputMode'] === 'content') {
    if (!Array.isArray(output['matches'])) {
      rejectField('matches', 'array', output['matches']);
    }
    output['matches'].forEach(requireGrepMatch);
    if (!isNonNegativeInteger(output['skippedMissingLineMetadata'])) {
      rejectField(
        'skippedMissingLineMetadata',
        'non-negative integer',
        output['skippedMissingLineMetadata']
      );
    }
    return output as unknown as GrepContentToolResult;
  }

  rejectField('outputMode', '"files" or "content"', output['outputMode']);
}
