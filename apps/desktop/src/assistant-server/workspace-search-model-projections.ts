import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import type { GlobWorkspaceMatch, GlobWorkspaceToolResult } from './glob-workspace-tool';
import type {
  GrepContentToolResult,
  GrepFileSummary,
  GrepFilesToolResult,
  GrepMatchSource,
  GrepToolResult,
  ModelFacingGrepMatch,
} from './grep-search-tool';

export interface WorkspaceSearchTextModelOutput {
  type: 'text';
  value: string;
}

const MAX_CONTEXT_CHARS = 600;
const MAX_LINE_TEXT_CHARS = 600;
const MAX_PATH_CHARS = 800;
const MAX_ROOT_LABEL_CHARS = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isGrepMatchSource(value: unknown): value is GrepMatchSource {
  return value === 'index' || value === 'live' || value === 'both';
}

function isGrepFileSummary(value: unknown): value is GrepFileSummary {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isPositiveInteger(value['firstLine']) &&
    isNonNegativeInteger(value['matchCount']) &&
    typeof value['path'] === 'string' &&
    isOptionalString(value['rootId']) &&
    isOptionalString(value['rootName']) &&
    isGrepMatchSource(value['source'])
  );
}

function isGrepMatch(value: unknown): value is ModelFacingGrepMatch {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isStringArray(value['after']) &&
    isStringArray(value['before']) &&
    isPositiveInteger(value['line']) &&
    typeof value['lineText'] === 'string' &&
    typeof value['path'] === 'string' &&
    isOptionalString(value['rootId']) &&
    isOptionalString(value['rootName']) &&
    isGrepMatchSource(value['source'])
  );
}

function hasValidGrepBase(value: Record<string, unknown>): boolean {
  return (
    typeof value['candidatesTruncated'] === 'boolean' &&
    (value['liveEngine'] === 'ripgrep' ||
      value['liveEngine'] === 'js-walk' ||
      value['liveEngine'] === 'skipped') &&
    isOptionalString(value['hint']) &&
    isOptionalString(value['liveNote']) &&
    isNonNegativeInteger(value['offset']) &&
    typeof value['scanLimited'] === 'boolean' &&
    isNonNegativeInteger(value['totalMatches']) &&
    typeof value['truncated'] === 'boolean'
  );
}

function parseGrepToolResult(output: unknown): GrepToolResult {
  if (!(isRecord(output) && hasValidGrepBase(output))) {
    throw new TypeError('grepSearch model projection received a malformed result');
  }
  if (
    output['outputMode'] === 'files' &&
    Array.isArray(output['files']) &&
    output['files'].every(isGrepFileSummary) &&
    isNonNegativeInteger(output['totalFiles'])
  ) {
    return output as unknown as GrepFilesToolResult;
  }
  if (
    output['outputMode'] === 'content' &&
    Array.isArray(output['matches']) &&
    output['matches'].every(isGrepMatch) &&
    isNonNegativeInteger(output['skippedMissingLineMetadata'])
  ) {
    return output as unknown as GrepContentToolResult;
  }
  throw new TypeError('grepSearch model projection received a malformed result');
}

function isGlobMatch(value: unknown): value is GlobWorkspaceMatch {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['path'] === 'string' &&
    typeof value['rootId'] === 'string' &&
    typeof value['rootName'] === 'string'
  );
}

function parseGlobWorkspaceToolResult(output: unknown): GlobWorkspaceToolResult {
  if (
    !(
      isRecord(output) &&
      isNonNegativeInteger(output['count']) &&
      isOptionalString(output['hint']) &&
      Array.isArray(output['matches']) &&
      output['matches'].every(isGlobMatch) &&
      output['count'] === output['matches'].length &&
      isNonNegativeInteger(output['offset']) &&
      typeof output['scanLimited'] === 'boolean' &&
      isNonNegativeInteger(output['totalMatches']) &&
      typeof output['truncated'] === 'boolean'
    )
  ) {
    throw new TypeError('globWorkspace model projection received a malformed result');
  }
  return output as unknown as GlobWorkspaceToolResult;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function clipEnd(value: string, maxChars: number, label: string): string {
  const normalized = singleLine(value);
  const codePoints = Array.from(normalized);
  if (codePoints.length <= maxChars) {
    return normalized;
  }
  const suffix = `…[${codePoints.length - maxChars} ${label} chars omitted]`;
  return `${codePoints.slice(0, maxChars).join('')}${suffix}`;
}

function clipPath(value: string): string {
  const normalized = singleLine(value);
  const codePoints = Array.from(normalized);
  if (codePoints.length <= MAX_PATH_CHARS) {
    return normalized;
  }
  const keptAtEachEnd = Math.floor(MAX_PATH_CHARS / 2);
  const omitted = codePoints.length - keptAtEachEnd * 2;
  return `${codePoints.slice(0, keptAtEachEnd).join('')}…[${omitted} path clipped]…${codePoints
    .slice(-keptAtEachEnd)
    .join('')}`;
}

function rootQualifier(
  rootName: string | null | undefined,
  rootId: string | null | undefined
): string {
  const name = clipEnd(rootName ?? 'unrooted', MAX_ROOT_LABEL_CHARS, 'root-name');
  const id = clipEnd(rootId ?? 'unknown', MAX_ROOT_LABEL_CHARS, 'root-id');
  return `[${name}|${id}]`;
}

function formatContext(label: 'after' | 'before', lines: readonly string[]): string | null {
  if (lines.length === 0) {
    return null;
  }
  return `${label}: ${clipEnd(lines.join(' ⏎ '), MAX_CONTEXT_CHARS, 'context')}`;
}

function makeTextModelOutput(lines: readonly string[]): WorkspaceSearchTextModelOutput {
  return { type: 'text', value: lines.join('\n') };
}

function serializedChars(lines: readonly string[]): number {
  return JSON.stringify(makeTextModelOutput(lines)).length;
}

function assertProjectionFits(
  toolName: 'globWorkspace' | 'grepSearch',
  lines: readonly string[]
): void {
  if (serializedChars(lines) <= MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
    return;
  }
  throw new RangeError(
    `${toolName} model projection exceeds the ${MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET}-character domain budget`
  );
}

function pageRange(offset: number, kept: number, total: number, lowerBound: boolean): string {
  const totalLabel = `${total}${lowerBound ? '+' : ''}`;
  if (kept === 0) {
    return `empty@offset=${offset}/${totalLabel}`;
  }
  return `${offset + 1}-${offset + kept}/${totalLabel}`;
}

function nextOffset(offset: number, kept: number, total: number): number {
  if (kept > 0) {
    return offset + kept;
  }
  return Math.min(offset + 1, total);
}

function formatGrepFile(item: GrepFileSummary): string[] {
  return [
    `${rootQualifier(item.rootName, item.rootId)} ${clipPath(item.path)}:${item.firstLine} | matches=${item.matchCount} | source=${item.source}`,
  ];
}

function formatGrepMatch(item: ModelFacingGrepMatch): string[] {
  const before = formatContext('before', item.before);
  const after = formatContext('after', item.after);
  return [
    `${rootQualifier(item.rootName, item.rootId)} ${clipPath(item.path)}:${item.line} | source=${item.source}`,
    ...(before ? [before] : []),
    `match: ${clipEnd(item.lineText, MAX_LINE_TEXT_CHARS, 'line')}`,
    ...(after ? [after] : []),
  ];
}

function formatGrepItem(
  result: GrepToolResult,
  item: GrepFileSummary | ModelFacingGrepMatch
): string[] {
  if (result.outputMode === 'files') {
    if (!isGrepFileSummary(item)) {
      throw new TypeError('grepSearch model projection received a malformed result');
    }
    return formatGrepFile(item);
  }
  if (!isGrepMatch(item)) {
    throw new TypeError('grepSearch model projection received a malformed result');
  }
  return formatGrepMatch(item);
}

function buildGrepHeader(result: GrepToolResult, kept: number): string {
  const common =
    `grep ${result.outputMode} | page=${pageRange(
      result.offset,
      kept,
      result.outputMode === 'files' ? result.totalFiles : result.totalMatches,
      result.scanLimited
    )}` +
    `${result.outputMode === 'files' ? ` | matches=${result.totalMatches}` : ''}` +
    ` | live=${result.liveEngine}` +
    ` | candidates_truncated=${result.candidatesTruncated}` +
    ` | scan_limited=${result.scanLimited}`;
  if (result.outputMode === 'files') {
    return common;
  }
  return `${common} | skipped_missing_line_metadata=${result.skippedMissingLineMetadata}`;
}

function grepContinuation(
  result: GrepToolResult,
  kept: number,
  available: number,
  probeBoundaryOverflow = false
): string | null {
  const total = result.outputMode === 'files' ? result.totalFiles : result.totalMatches;
  const omittedByProjection = kept < available;
  if (omittedByProjection) {
    return `continue: reuse the prior brainstrike.grepSearch input with offset=${nextOffset(
      result.offset,
      kept,
      total
    )}`;
  }
  if (result.hint) {
    return `continue: reuse the prior brainstrike.grepSearch input; ${singleLine(result.hint)}`;
  }
  if (result.truncated || result.scanLimited || result.candidatesTruncated) {
    if (probeBoundaryOverflow) {
      return `continue: reuse the prior brainstrike.grepSearch input with offset=${nextOffset(
        result.offset,
        Math.max(kept - 1, 0),
        total
      )}`;
    }
    throw new TypeError(
      'grepSearch model projection received a truncated result without continuation guidance'
    );
  }
  return null;
}

export function projectGrepSearchModelOutput(output: unknown): WorkspaceSearchTextModelOutput {
  const result = parseGrepToolResult(output);
  const items = result.outputMode === 'files' ? result.files : result.matches;
  const note = result.liveNote
    ? `note: ${clipEnd(result.liveNote, MAX_LINE_TEXT_CHARS, 'note')}`
    : null;
  const keptLines: string[] = [];
  let kept = 0;

  for (const item of items) {
    const candidateItemLines = formatGrepItem(result, item);
    const candidateKept = kept + 1;
    const continuation = grepContinuation(result, candidateKept, items.length, true);
    const candidate = [
      buildGrepHeader(result, candidateKept),
      ...keptLines,
      ...candidateItemLines,
      ...(note ? [note] : []),
      ...(continuation ? [continuation] : []),
    ];
    if (serializedChars(candidate) > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
      break;
    }
    keptLines.push(...candidateItemLines);
    kept = candidateKept;
  }

  const continuation = grepContinuation(result, kept, items.length);
  const lines = [
    buildGrepHeader(result, kept),
    ...keptLines,
    ...(note ? [note] : []),
    ...(continuation ? [continuation] : []),
  ];
  assertProjectionFits('grepSearch', lines);
  return makeTextModelOutput(lines);
}

function globContinuation(
  result: GlobWorkspaceToolResult,
  kept: number,
  probeBoundaryOverflow = false
): string | null {
  const omittedByProjection = kept < result.matches.length;
  if (omittedByProjection) {
    return `continue: reuse the prior brainstrike.globWorkspace input with offset=${nextOffset(
      result.offset,
      kept,
      result.totalMatches
    )}`;
  }
  if (result.hint) {
    return `continue: reuse the prior brainstrike.globWorkspace input; ${singleLine(result.hint)}`;
  }
  if (result.truncated || result.scanLimited) {
    if (probeBoundaryOverflow) {
      return `continue: reuse the prior brainstrike.globWorkspace input with offset=${nextOffset(
        result.offset,
        Math.max(kept - 1, 0),
        result.totalMatches
      )}`;
    }
    throw new TypeError(
      'globWorkspace model projection received a truncated result without continuation guidance'
    );
  }
  return null;
}

export function projectGlobWorkspaceModelOutput(output: unknown): WorkspaceSearchTextModelOutput {
  const result = parseGlobWorkspaceToolResult(output);
  const keptLines: string[] = [];
  let kept = 0;

  for (const item of result.matches) {
    const itemLine = `${rootQualifier(item.rootName, item.rootId)} ${clipPath(item.path)}`;
    const candidateKept = kept + 1;
    const continuation = globContinuation(result, candidateKept, true);
    const candidate = [
      `glob | page=${pageRange(
        result.offset,
        candidateKept,
        result.totalMatches,
        result.scanLimited
      )} | scan_limited=${result.scanLimited}`,
      ...keptLines,
      itemLine,
      ...(continuation ? [continuation] : []),
    ];
    if (serializedChars(candidate) > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
      break;
    }
    keptLines.push(itemLine);
    kept = candidateKept;
  }

  const continuation = globContinuation(result, kept);
  const lines = [
    `glob | page=${pageRange(
      result.offset,
      kept,
      result.totalMatches,
      result.scanLimited
    )} | scan_limited=${result.scanLimited}`,
    ...keptLines,
    ...(continuation ? [continuation] : []),
  ];
  assertProjectionFits('globWorkspace', lines);
  return makeTextModelOutput(lines);
}
