import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  formatGrepContentHeader,
  formatGrepContentRow,
  formatGrepProjectionPageRange,
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import type { GlobWorkspaceMatch, GlobWorkspaceToolResult } from './glob-workspace-tool.js';
import {
  type GrepFileSummary,
  type GrepMatchSource,
  type GrepToolResult,
  grepProjectionHeaderPrefix,
  type ModelFacingGrepMatch,
  parseGrepToolResult,
} from './grep-search-result-contract.js';
import {
  clipProjectionEnd as clipEnd,
  decodedWorkspaceTextModelOutputChars as decodedChars,
  escapeProjectionPathLineBreaks,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  makeWorkspaceTextModelOutput as makeTextModelOutput,
  projectionSingleLine as singleLine,
  type WorkspaceTextModelOutput,
} from './workspace-model-projection-helpers.js';

export type WorkspaceSearchTextModelOutput = WorkspaceTextModelOutput;

const MAX_LINE_TEXT_CHARS = 600;

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
      isOptionalString(output['loopGuardWarning']) &&
      Array.isArray(output['matches']) &&
      output['matches'].every(isGlobMatch) &&
      output['count'] === output['matches'].length &&
      isNonNegativeInteger(output['offset']) &&
      (output['openRoots'] === undefined || isPositiveInteger(output['openRoots'])) &&
      (output['ambiguousRootNames'] === undefined ||
        (Array.isArray(output['ambiguousRootNames']) &&
          output['ambiguousRootNames'].every((name) => typeof name === 'string'))) &&
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
 *
 * A LEADING whitespace character is escaped so a hostile filename cannot
 * mimic an indented `  N: text` match row; combined with line-break escaping
 * a path can never create a new projection line. A path that merely LOOKS
 * like a header or continuation still renders inline on its own single line —
 * an accepted residual documented in assistant-providers.md.
 */
function projectionPath(value: string): string {
  const escaped = escapeProjectionPathLineBreaks(value);
  if (escaped.startsWith(' ')) {
    return `\\x20${escaped.slice(1)}`;
  }
  if (escaped.startsWith('\t')) {
    return `\\t${escaped.slice(1)}`;
  }
  return escaped;
}

/** The minimal per-item root fields the label resolver reads. */
interface RootLabelledItem {
  rootId?: string | null;
  rootName?: string | null;
}

/** The result-envelope topology fields the label resolver reads. */
interface RootTopologyEnvelope {
  ambiguousRootNames?: string[];
  openRoots?: number;
}

/**
 * Per-result root-label policy (BST-1185): file headers carry a root prefix
 * ONLY when more than one folder is open — the producer says so via
 * `openRoots` (with a defensive fallback to "this page spans several roots").
 * The label is the root display name, which `resolveWorkspaceRoot` accepts as
 * a `root` selector. Ambiguity is decided against the FULL open-root
 * inventory via the producer's `ambiguousRootNames` (a page may contain one
 * root of a twin pair), with page-local twin detection kept as defence in
 * depth; ambiguous names fall back to the durable root id. Labels are
 * SELECTORS and are therefore emitted verbatim (line breaks escaped, never
 * clipped, whitespace preserved) — an oversized label overflows the budget
 * and its item is omitted, exactly like an oversized path. Single-root and
 * unrooted results get bare paths.
 */
function buildRootLabelResolver(
  envelope: RootTopologyEnvelope,
  items: readonly RootLabelledItem[]
): (item: RootLabelledItem) => string | null {
  const globallyAmbiguous = new Set(
    (envelope.ambiguousRootNames ?? []).map((name) => name.toLowerCase())
  );
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
  const multiRoot = (envelope.openRoots ?? 0) > 1 || distinctRootIds.size > 1;
  if (!multiRoot) {
    return () => null;
  }
  return (item) => {
    const name = item.rootName?.trim();
    if (
      name &&
      !globallyAmbiguous.has(name.toLowerCase()) &&
      (rootIdsByName.get(name.toLowerCase())?.size ?? 0) <= 1
    ) {
      return escapeProjectionPathLineBreaks(name);
    }
    if (item.rootId) {
      return escapeProjectionPathLineBreaks(item.rootId);
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
  lines: readonly string[],
  domainModelResultCharBudget: number
): void {
  if (decodedChars(lines) <= domainModelResultCharBudget) {
    return;
  }
  throw new RangeError(
    `${toolName} model projection exceeds the ${domainModelResultCharBudget}-character domain budget`
  );
}

function pageRange(offset: number, kept: number, total: number, lowerBound: boolean): string {
  return formatGrepProjectionPageRange({ kept, lowerBound, offset, total });
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
  let header =
    result.outputMode === 'content'
      ? formatGrepContentHeader({
          kept,
          lowerBound: result.scanLimited,
          offset: result.offset,
          total,
        })
      : `${grepProjectionHeaderPrefix(result.outputMode)}${pageRange(
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
  return `${item.rootId ?? ''}\0${item.path}`;
}

/**
 * Path-grouped content rendering (BST-1185): one file-header line per file,
 * then `  <line>: <text>` rows — ripgrep's own convention, with `-` marking
 * context rows. Context line numbers are derived from the match line (the
 * producer supplies the immediately adjacent lines). Rows within a file are
 * MERGED: overlapping context from adjacent matches emits each physical line
 * exactly once, match rows win over context rows, and line numbers stay
 * monotonic (PR #2313 review — the naive per-match emission duplicated
 * adjacent lines and ran the number column backwards). The per-row
 * `read_args=` JSON envelope, repeated root name, and `source=` label are
 * gone; the read recipe lives in the tool descriptions once.
 */
function renderContentItems(
  matches: readonly ModelFacingGrepMatch[],
  rootLabel: (item: RootLabelledItem) => string | null
): string[] {
  const lines: string[] = [];
  let groupRows = new Map<number, { isMatch: boolean; text: string }>();
  let previousGroup: string | null = null;

  const flushGroup = (): void => {
    const ordered = Array.from(groupRows.entries()).sort(([a], [b]) => a - b);
    for (const [line, row] of ordered) {
      lines.push(
        formatGrepContentRow(
          line,
          clipEnd(row.text, MAX_LINE_TEXT_CHARS, row.isMatch ? 'line' : 'context'),
          row.isMatch
        )
      );
    }
    groupRows = new Map();
  };

  for (const match of matches) {
    const group = fileGroupKey(match);
    if (group !== previousGroup) {
      flushGroup();
      lines.push(fileHeaderLine(match, rootLabel));
      previousGroup = group;
    }
    match.before.forEach((text, index) => {
      const line = match.line - match.before.length + index;
      if (!groupRows.get(line)?.isMatch) {
        groupRows.set(line, { isMatch: false, text });
      }
    });
    groupRows.set(match.line, { isMatch: true, text: match.lineText });
    match.after.forEach((text, index) => {
      const line = match.line + 1 + index;
      if (!groupRows.get(line)?.isMatch) {
        groupRows.set(line, { isMatch: false, text });
      }
    });
  }
  flushGroup();
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

export function projectGrepSearchModelOutput(
  output: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): WorkspaceSearchTextModelOutput {
  if (
    isRecord(output) &&
    Object.keys(output).length === 2 &&
    output['type'] === 'text' &&
    typeof output['value'] === 'string' &&
    (output['value'].startsWith(grepProjectionHeaderPrefix('files')) ||
      output['value'].startsWith(grepProjectionHeaderPrefix('content')))
  ) {
    const replayed = { type: 'text' as const, value: output['value'] };
    if (
      decodedChars([replayed.value]) > CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget
    ) {
      throw new RangeError(
        `grepSearch stored model projection exceeds the ${CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget}-character domain budget`
      );
    }
    return replayed;
  }
  const result = parseGrepToolResult(output);
  const items = result.outputMode === 'files' ? result.files : result.matches;
  const rootLabel = buildRootLabelResolver(result, items);
  const noteLines = [result.liveNote, result.probeNote]
    .filter((note): note is string => note !== undefined)
    .map((note) => `note: ${clipEnd(note, MAX_LINE_TEXT_CHARS, 'note')}`);
  // BST-1188: the loop guard's own line, rendered UNCONDITIONALLY like
  // noteLines above — never folded into `hint`, which the continuation logic
  // below skips whenever `omittedByProjection` already trimmed the page (see
  // `grepContinuation`), silently dropping a `hint`-borne warning on exactly
  // the large/expensive repeats the guard exists to stop.
  const warningLines = result.loopGuardWarning
    ? [`warning: ${clipEnd(result.loopGuardWarning, MAX_LINE_TEXT_CHARS, 'warning')}`]
    : [];
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
      ...noteLines,
      ...warningLines,
      ...(continuation ? [continuation] : []),
    ];
    if (decodedChars(candidate) > domainModelResultCharBudget) {
      break;
    }
    keptLines = candidateLines;
    kept = candidateKept;
  }

  const continuation = grepContinuation(result, kept, items.length);
  const lines = [
    buildGrepHeader(result, kept),
    ...keptLines,
    ...noteLines,
    ...warningLines,
    ...(continuation ? [continuation] : []),
  ];
  assertProjectionFits('grepSearch', lines, domainModelResultCharBudget);
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

export function projectGlobWorkspaceModelOutput(
  output: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): WorkspaceSearchTextModelOutput {
  const result = parseGlobWorkspaceToolResult(output);
  const rootLabel = buildRootLabelResolver(result, result.matches);
  // BST-1188: same unconditional own-line treatment as grepSearch's
  // `warningLines` above — never folded into `hint`.
  const warningLines = result.loopGuardWarning
    ? [`warning: ${clipEnd(result.loopGuardWarning, MAX_LINE_TEXT_CHARS, 'warning')}`]
    : [];
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
      ...warningLines,
      ...(continuation ? [continuation] : []),
    ];
    if (decodedChars(candidate) > domainModelResultCharBudget) {
      break;
    }
    keptLines.push(itemLine);
    kept = candidateKept;
  }

  const continuation = globContinuation(result, kept);
  const lines = [
    buildGlobHeader(result, kept),
    ...keptLines,
    ...warningLines,
    ...(continuation ? [continuation] : []),
  ];
  assertProjectionFits('globWorkspace', lines, domainModelResultCharBudget);
  return makeTextModelOutput(lines);
}
