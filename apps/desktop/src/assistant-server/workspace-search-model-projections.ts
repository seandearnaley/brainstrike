import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import type { GlobWorkspaceMatch, GlobWorkspaceToolResult } from './glob-workspace-tool';
import {
  type GrepFileSummary,
  type GrepMatchSource,
  type GrepToolResult,
  grepProjectionHeaderPrefix,
  type ModelFacingGrepMatch,
  parseGrepToolResult,
} from './grep-search-result-contract';
import {
  clipProjectionEnd as clipEnd,
  escapeProjectionPathLineBreaks,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  makeWorkspaceTextModelOutput as makeTextModelOutput,
  serializedWorkspaceTextModelOutputChars as serializedChars,
  projectionSingleLine as singleLine,
  type WorkspaceTextModelOutput,
} from './workspace-model-projection-helpers';

export type WorkspaceSearchTextModelOutput = WorkspaceTextModelOutput;

const MAX_LINE_TEXT_CHARS = 600;
const MAX_ROOT_LABEL_CHARS = 160;

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
      (output['openRoots'] === undefined || isPositiveInteger(output['openRoots'])) &&
      typeof output['scanLimited'] === 'boolean' &&
      isNonNegativeInteger(output['totalMatches']) &&
      typeof output['truncated'] === 'boolean'
    )
  ) {
    throw new ToolProjectionInputRejectedError(
      'globWorkspace model projection received a malformed result'
    );
  }
  return output as unknown as GlobWorkspaceToolResult;
}

/**
 * Paths are emitted VERBATIM (line breaks escaped) and never clipped: the path
 * is the model's read/scope selector, and a clipped path is unusable. A
 * pathological oversized path therefore overflows the char budget naturally
 * and the fitting loop OMITS that item with an advancing offset — the same
 * omit-don't-mangle ruling the legacy `read_args` rows enforced.
 */
function projectionPath(value: string): string {
  return escapeProjectionPathLineBreaks(value);
}

/** The minimal per-item root fields the label resolver reads. */
interface RootLabelledItem {
  rootId?: string | null;
  rootName?: string | null;
}

/**
 * Per-result root-label policy (BST-1185): file headers carry a root prefix
 * ONLY when more than one folder is open — the producer says so via
 * `openRoots` (with a defensive fallback to "this page spans several roots").
 * The label is the root display name, which `resolveWorkspaceRoot` accepts as
 * a `root` selector; when two distinct roots on the page share a display name
 * (name resolution would throw as ambiguous), the durable root id is used for
 * those items instead. Single-root and unrooted results get bare paths.
 */
function buildRootLabelResolver(
  openRoots: number | undefined,
  items: readonly RootLabelledItem[]
): (item: RootLabelledItem) => string | null {
  const distinctRootIds = new Set<string>();
  const rootIdsByName = new Map<string, Set<string>>();
  for (const item of items) {
    const rootId = item.rootId ?? undefined;
    if (rootId) {
      distinctRootIds.add(rootId);
    }
    const name = item.rootName?.trim();
    if (name) {
      const key = name.toLowerCase();
      const ids = rootIdsByName.get(key) ?? new Set<string>();
      ids.add(rootId ?? '');
      rootIdsByName.set(key, ids);
    }
  }
  const multiRoot = (openRoots ?? 0) > 1 || distinctRootIds.size > 1;
  if (!multiRoot) {
    return () => null;
  }
  return (item) => {
    const name = item.rootName?.trim();
    if (name && (rootIdsByName.get(name.toLowerCase())?.size ?? 0) <= 1) {
      return clipEnd(name, MAX_ROOT_LABEL_CHARS, 'root-name');
    }
    if (item.rootId) {
      return clipEnd(item.rootId, MAX_ROOT_LABEL_CHARS, 'root-id');
    }
    return null;
  };
}

function fileHeaderLine(
  item: RootLabelledItem & { path: string },
  rootLabel: (item: RootLabelledItem) => string | null
): string {
  const label = rootLabel(item);
  const path = projectionPath(item.path);
  return label ? `${label}:${path}` : path;
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

/**
 * Compact header (BST-1185/BST-1191): mode + page range, plus files-mode
 * total-match count. Status flags appear ONLY when they fire — a healthy
 * ripgrep-backed result reads `grep content 1-50/61` and nothing else; the
 * legacy always-on `candidates_truncated=false | scan_limited=false | …`
 * flags were pure noise on every call.
 */
function buildGrepHeader(result: GrepToolResult, kept: number): string {
  const total = result.outputMode === 'files' ? result.totalFiles : result.totalMatches;
  let header = `${grepProjectionHeaderPrefix(result.outputMode)}${pageRange(
    result.offset,
    kept,
    total,
    result.scanLimited
  )}`;
  if (result.outputMode === 'files') {
    header += ` matches=${result.totalMatches}`;
  }
  const flags: string[] = [];
  if (result.liveEngine !== 'ripgrep') {
    flags.push(`live=${result.liveEngine}`);
  }
  if (result.candidatesTruncated) {
    flags.push('candidates_truncated');
  }
  if (result.scanLimited) {
    flags.push('scan_limited');
  }
  if (result.outputMode === 'content' && result.skippedMissingLineMetadata > 0) {
    flags.push(`skipped_lines=${result.skippedMissingLineMetadata}`);
  }
  return flags.length > 0 ? `${header} | ${flags.join(' | ')}` : header;
}

/** Group key: two roots may share a relative path, so the root participates. */
function fileGroupKey(item: RootLabelledItem & { path: string }): string {
  return `${item.rootId ?? ''} ${item.path}`;
}

/**
 * Path-grouped content rendering (BST-1185): one file-header line per file,
 * then `  <line>: <text>` rows — ripgrep's own convention, with `-` marking
 * context rows. Context line numbers are derived from the match line (the
 * producer supplies the immediately adjacent lines). The per-row
 * `read_args=` JSON envelope, repeated root name, and `source=` label are
 * gone; the read recipe lives in the tool descriptions once.
 */
function renderContentItems(
  matches: readonly ModelFacingGrepMatch[],
  rootLabel: (item: RootLabelledItem) => string | null
): string[] {
  const lines: string[] = [];
  let previousGroup: string | null = null;
  for (const match of matches) {
    const group = fileGroupKey(match);
    if (group !== previousGroup) {
      lines.push(fileHeaderLine(match, rootLabel));
      previousGroup = group;
    }
    match.before.forEach((text, index) => {
      lines.push(
        `  ${match.line - match.before.length + index}- ${clipEnd(text, MAX_LINE_TEXT_CHARS, 'context')}`
      );
    });
    lines.push(`  ${match.line}: ${clipEnd(match.lineText, MAX_LINE_TEXT_CHARS, 'line')}`);
    match.after.forEach((text, index) => {
      lines.push(`  ${match.line + 1 + index}- ${clipEnd(text, MAX_LINE_TEXT_CHARS, 'context')}`);
    });
  }
  return lines;
}

/** Files-mode survey rows: `root:path:firstLine (N matches)`. */
function renderFileItems(
  files: readonly GrepFileSummary[],
  rootLabel: (item: RootLabelledItem) => string | null
): string[] {
  return files.map(
    (file) =>
      `${fileHeaderLine(file, rootLabel)}:${file.firstLine} (${file.matchCount} ${
        file.matchCount === 1 ? 'match' : 'matches'
      })`
  );
}

function renderGrepItems(
  result: GrepToolResult,
  items: readonly (GrepFileSummary | ModelFacingGrepMatch)[],
  rootLabel: (item: RootLabelledItem) => string | null
): string[] {
  if (result.outputMode === 'files') {
    if (!items.every(isGrepFileSummary)) {
      throw new ToolProjectionInputRejectedError(
        'grepSearch model projection received a malformed result'
      );
    }
    return renderFileItems(items, rootLabel);
  }
  if (!items.every(isGrepMatch)) {
    throw new ToolProjectionInputRejectedError(
      'grepSearch model projection received a malformed result'
    );
  }
  return renderContentItems(items, rootLabel);
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
  if (
    isRecord(output) &&
    Object.keys(output).length === 2 &&
    output['type'] === 'text' &&
    typeof output['value'] === 'string' &&
    (output['value'].startsWith(grepProjectionHeaderPrefix('files')) ||
      output['value'].startsWith(grepProjectionHeaderPrefix('content')))
  ) {
    const replayed = { type: 'text' as const, value: output['value'] };
    if (serializedChars([replayed.value]) > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
      throw new RangeError(
        `grepSearch stored model projection exceeds the ${MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET}-character domain budget`
      );
    }
    return replayed;
  }
  const result = parseGrepToolResult(output);
  const items = result.outputMode === 'files' ? result.files : result.matches;
  const rootLabel = buildRootLabelResolver(result.openRoots, items);
  const note = result.liveNote
    ? `note: ${clipEnd(result.liveNote, MAX_LINE_TEXT_CHARS, 'note')}`
    : null;
  let keptLines: string[] = [];
  let kept = 0;

  // Grouped rendering means an item can add one line (row in the current
  // file) or two (new file header + row), so each candidate prefix is
  // re-rendered from scratch rather than appended incrementally.
  for (let candidateKept = 1; candidateKept <= items.length; candidateKept += 1) {
    const candidateLines = renderGrepItems(result, items.slice(0, candidateKept), rootLabel);
    const continuation = grepContinuation(result, candidateKept, items.length, true);
    const candidate = [
      buildGrepHeader(result, candidateKept),
      ...candidateLines,
      ...(note ? [note] : []),
      ...(continuation ? [continuation] : []),
    ];
    if (serializedChars(candidate) > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
      break;
    }
    keptLines = candidateLines;
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

function buildGlobHeader(result: GlobWorkspaceToolResult, kept: number): string {
  const header = `glob ${pageRange(result.offset, kept, result.totalMatches, result.scanLimited)}`;
  return result.scanLimited ? `${header} | scan_limited` : header;
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
  const rootLabel = buildRootLabelResolver(result.openRoots, result.matches);
  const keptLines: string[] = [];
  let kept = 0;

  for (const item of result.matches) {
    const itemLine = fileHeaderLine(item, rootLabel);
    const candidateKept = kept + 1;
    const continuation = globContinuation(result, candidateKept, true);
    const candidate = [
      buildGlobHeader(result, candidateKept),
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
    buildGlobHeader(result, kept),
    ...keptLines,
    ...(continuation ? [continuation] : []),
  ];
  assertProjectionFits('globWorkspace', lines);
  return makeTextModelOutput(lines);
}
