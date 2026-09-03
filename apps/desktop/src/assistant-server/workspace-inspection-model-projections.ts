import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import type {
  EditDiagnostic,
  InspectLocation,
  LspInspectionResult,
  LspQueryFailure,
  LspUnavailableReason,
} from './lsp-diagnostics';
import {
  clipProjectionEnd as clipEnd,
  clipProjectionMiddle,
  decodedWorkspaceTextModelOutputChars as decodedChars,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  makeWorkspaceTextModelOutput as makeTextModelOutput,
  projectionSingleLine as singleLine,
  type WorkspaceTextModelOutput,
} from './workspace-model-projection-helpers';

export type WorkspaceInspectionTextModelOutput = WorkspaceTextModelOutput;

interface SymbolMatchResult {
  declarationLine: number;
  endLine: number;
  name: string;
  preview: string;
  startLine: number;
}

interface FindWorkspaceSymbolResult {
  matches: SymbolMatchResult[];
  path: string;
  rootName: string;
  totalMatches: number;
  truncated: boolean;
}

interface LspInspectResult extends LspInspectionResult {
  path: string;
  rootName: string;
}

type LspCollectionKind = 'definitions' | 'diagnostics' | 'implementations';

interface LspProjectionLine {
  kind: LspCollectionKind;
  value: string;
}

const MAX_DECLARATION_CHARS = 500;
const MAX_DIAGNOSTIC_CHARS = 500;
const MAX_DIAGNOSTIC_SOURCE_CHARS = 100;
const MAX_HOVER_CHARS = 1400;
const MAX_PATH_CHARS = 800;
const MAX_PREVIEW_CHARS = 800;
const MAX_ROOT_LABEL_CHARS = 160;

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isUnavailableReason(value: unknown): value is LspUnavailableReason {
  return value === 'unsupported-language' || value === 'server-unavailable' || value === 'timeout';
}

function isSymbolMatch(value: unknown): value is SymbolMatchResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isPositiveInteger(value['declarationLine']) &&
    isPositiveInteger(value['endLine']) &&
    typeof value['name'] === 'string' &&
    typeof value['preview'] === 'string' &&
    isPositiveInteger(value['startLine']) &&
    value['startLine'] <= value['declarationLine'] &&
    value['declarationLine'] <= value['endLine']
  );
}

function parseFindWorkspaceSymbolResult(output: unknown): FindWorkspaceSymbolResult {
  if (
    !(
      isRecord(output) &&
      Array.isArray(output['matches']) &&
      output['matches'].every(isSymbolMatch) &&
      typeof output['path'] === 'string' &&
      typeof output['rootName'] === 'string' &&
      isNonNegativeInteger(output['totalMatches']) &&
      output['totalMatches'] >= output['matches'].length &&
      typeof output['truncated'] === 'boolean'
    )
  ) {
    throw new ToolProjectionInputRejectedError(
      'findWorkspaceSymbol model projection received a malformed result'
    );
  }
  return output as unknown as FindWorkspaceSymbolResult;
}

function isDiagnostic(value: unknown): value is EditDiagnostic {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isPositiveInteger(value['character']) &&
    isPositiveInteger(value['line']) &&
    typeof value['message'] === 'string' &&
    (value['severity'] === 'error' ||
      value['severity'] === 'warning' ||
      value['severity'] === 'info' ||
      value['severity'] === 'hint') &&
    isOptionalString(value['source'])
  );
}

function isQueryFailure(value: unknown): value is LspQueryFailure {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['message'] === 'string' &&
    (value['query'] === 'definition' ||
      value['query'] === 'diagnostics' ||
      value['query'] === 'hover' ||
      value['query'] === 'implementation') &&
    (value['reason'] === 'timeout' || value['reason'] === 'error')
  );
}

function isInspectLocation(value: unknown): value is InspectLocation {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isPositiveInteger(value['line']) &&
    typeof value['path'] === 'string' &&
    isOptionalString(value['preview'])
  );
}

function hasOptionalArray(
  value: Record<string, unknown>,
  key: 'definition' | 'diagnostics' | 'implementation' | 'queryFailures',
  predicate: (item: unknown) => boolean
): boolean {
  const collection = value[key];
  return collection === undefined || (Array.isArray(collection) && collection.every(predicate));
}

function parseLspInspectResult(output: unknown): LspInspectResult {
  if (
    !(
      isRecord(output) &&
      typeof output['available'] === 'boolean' &&
      typeof output['path'] === 'string' &&
      typeof output['rootName'] === 'string' &&
      isOptionalString(output['language']) &&
      isOptionalString(output['message']) &&
      isOptionalString(output['hover']) &&
      hasOptionalArray(output, 'definition', isInspectLocation) &&
      hasOptionalArray(output, 'diagnostics', isDiagnostic) &&
      hasOptionalArray(output, 'implementation', isInspectLocation) &&
      hasOptionalArray(output, 'queryFailures', isQueryFailure)
    )
  ) {
    throw new ToolProjectionInputRejectedError(
      'lspInspect model projection received a malformed result'
    );
  }
  if (
    output['available'] === false &&
    !(isUnavailableReason(output['reason']) && typeof output['message'] === 'string')
  ) {
    throw new ToolProjectionInputRejectedError(
      'lspInspect model projection received a malformed result'
    );
  }
  if (output['available'] === true && output['reason'] !== undefined) {
    throw new ToolProjectionInputRejectedError(
      'lspInspect model projection received a malformed result'
    );
  }
  return output as unknown as LspInspectResult;
}

function formatDeclaration(value: string): string[] {
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_DECLARATION_CHARS) {
    return [`declaration: ${value}`];
  }
  return [
    `declaration: ${codePoints.slice(0, MAX_DECLARATION_CHARS).join('')}`,
    `declaration_clipped: ${codePoints.length - MAX_DECLARATION_CHARS} trailing chars omitted`,
  ];
}

function clipPath(value: string): string {
  return clipProjectionMiddle(singleLine(value), MAX_PATH_CHARS, 'path');
}

function assertProjectionFits(
  toolName: 'findWorkspaceSymbol' | 'lspInspect',
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

function symbolHeader(result: FindWorkspaceSymbolResult, kept: number): string {
  return (
    `symbols | root=${clipEnd(result.rootName, MAX_ROOT_LABEL_CHARS, 'root-name')}` +
    ` | path=${clipPath(result.path)}` +
    ` | shown=${kept}/${result.totalMatches}` +
    ` | truncated=${result.truncated}`
  );
}

function formatSymbolMatch(match: SymbolMatchResult): string[] {
  return [
    `match declaration=${match.declarationLine} | range=${match.startLine}-${match.endLine}`,
    ...formatDeclaration(match.name),
    `preview: ${clipEnd(match.preview, MAX_PREVIEW_CHARS, 'preview')}`,
  ];
}

const SYMBOL_INSPECTION_GUIDANCE =
  'inspect: call brainstrike.lspInspect with the header root/path and one returned declaration line; pass the returned unique symbol name directly as match, or place exactly one <<< before the intended occurrence in a unique line fragment when the name repeats';

function symbolContinuation(result: FindWorkspaceSymbolResult, kept: number): string | null {
  if (kept < result.matches.length) {
    return 'continue: reuse the prior brainstrike.findWorkspaceSymbol input with contextLines=0 and a narrower query; offset pagination is unavailable';
  }
  if (result.truncated) {
    return 'continue: reuse the prior brainstrike.findWorkspaceSymbol input with a narrower query or larger maxMatches (up to 20); offset pagination is unavailable';
  }
  return null;
}

export function projectFindWorkspaceSymbolModelOutput(
  output: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): WorkspaceInspectionTextModelOutput {
  const result = parseFindWorkspaceSymbolResult(output);
  const keptLines: string[] = [];
  let kept = 0;

  for (const match of result.matches) {
    const matchLines = formatSymbolMatch(match);
    const candidateKept = kept + 1;
    const continuation = symbolContinuation(result, candidateKept);
    const candidate = [
      symbolHeader(result, candidateKept),
      ...keptLines,
      ...matchLines,
      SYMBOL_INSPECTION_GUIDANCE,
      ...(continuation ? [continuation] : []),
    ];
    if (decodedChars(candidate) > domainModelResultCharBudget) {
      break;
    }
    keptLines.push(...matchLines);
    kept = candidateKept;
  }

  const continuation = symbolContinuation(result, kept);
  const lines = [
    symbolHeader(result, kept),
    ...keptLines,
    ...(kept > 0 ? [SYMBOL_INSPECTION_GUIDANCE] : []),
    ...(continuation ? [continuation] : []),
  ];
  assertProjectionFits('findWorkspaceSymbol', lines, domainModelResultCharBudget);
  return makeTextModelOutput(lines);
}

function formatDiagnostic(diagnostic: EditDiagnostic): string {
  const source = diagnostic.source
    ? ` | source=${clipEnd(diagnostic.source, MAX_DIAGNOSTIC_SOURCE_CHARS, 'source')}`
    : '';
  return (
    `diagnostic ${diagnostic.severity} ${diagnostic.line}:${diagnostic.character}` +
    `${source} | ${clipEnd(diagnostic.message, MAX_DIAGNOSTIC_CHARS, 'diagnostic')}`
  );
}

function formatLocation(label: 'definition' | 'implementation', location: InspectLocation): string {
  const preview = location.preview
    ? ` | ${clipEnd(location.preview, MAX_DECLARATION_CHARS, 'preview')}`
    : '';
  return `${label} ${clipPath(location.path)}:${location.line}${preview}`;
}

function omissionSummary(
  totals: Record<LspCollectionKind, number>,
  kept: Record<LspCollectionKind, number>
): string | null {
  const omitted = {
    definitions: totals.definitions - kept.definitions,
    diagnostics: totals.diagnostics - kept.diagnostics,
    implementations: totals.implementations - kept.implementations,
  };
  if (omitted.definitions === 0 && omitted.diagnostics === 0 && omitted.implementations === 0) {
    return null;
  }
  return (
    `projection_omitted: diagnostics=${omitted.diagnostics}, ` +
    `definitions=${omitted.definitions}, implementations=${omitted.implementations}`
  );
}

function lspHeader(result: LspInspectResult): string {
  const base =
    `lsp | available=${result.available}` +
    ` | root=${clipEnd(result.rootName, MAX_ROOT_LABEL_CHARS, 'root-name')}` +
    ` | path=${clipPath(result.path)}`;
  if (!result.available) {
    return `${base} | reason=${result.reason}`;
  }
  const withLanguage = result.language ? `${base} | language=${singleLine(result.language)}` : base;
  const failures = result.queryFailures ?? [];
  if (failures.length === 0) {
    return withLanguage;
  }
  // BST-1614: name the unanswered groups IN THE HEADER, not only in the
  // detail lines below — the header is the one line the budget can never
  // drop, so "definition is absent" can't be read as "there is none".
  return `${withLanguage} | unanswered=${failures.map((failure) => failure.query).join(',')}`;
}

/** One unanswered leg, phrased so the omission above cannot read as "none". */
function formatQueryFailure(failure: LspQueryFailure): string {
  return `query_unanswered: ${failure.query} | reason=${failure.reason} | ${clipEnd(
    failure.message,
    MAX_DIAGNOSTIC_CHARS,
    'query-failure-message'
  )}`;
}

function buildLspProjectionLines(result: LspInspectResult): LspProjectionLine[] {
  const diagnostics = result.diagnostics ?? [];
  const definitions = result.definition ?? [];
  const implementations = result.implementation ?? [];
  return [
    ...diagnostics.map(
      (diagnostic): LspProjectionLine => ({
        kind: 'diagnostics',
        value: formatDiagnostic(diagnostic),
      })
    ),
    ...definitions.map(
      (location): LspProjectionLine => ({
        kind: 'definitions',
        value: formatLocation('definition', location),
      })
    ),
    ...implementations.map(
      (location): LspProjectionLine => ({
        kind: 'implementations',
        value: formatLocation('implementation', location),
      })
    ),
  ];
}

export function projectLspInspectModelOutput(
  output: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): WorkspaceInspectionTextModelOutput {
  const result = parseLspInspectResult(output);
  const header = lspHeader(result);
  if (!result.available) {
    const lines = [
      header,
      `message: ${clipEnd(result.message ?? '', MAX_DIAGNOSTIC_CHARS, 'message')}`,
    ];
    assertProjectionFits('lspInspect', lines, domainModelResultCharBudget);
    return makeTextModelOutput(lines);
  }

  const hover = result.hover ? `hover: ${clipEnd(result.hover, MAX_HOVER_CHARS, 'hover')}` : null;
  // The prelude sits above the droppable result lines, in PRIORITY order: an
  // unanswered-query line prevents a WRONG conclusion, while hover is only
  // informational, so failures outrank it under budget pressure.
  //
  // Nothing here is unconditional. `domainModelResultCharBudget` is per-run
  // (resolveScaledToolResultBudget clamps the domain allowance to 500..3000
  // tokens, so a small context window floors it at 2000 chars), and a maximal
  // header + hover + three failure lines runs to roughly 4.2k. Forcing them in
  // would make the closing assertProjectionFits THROW — turning a degraded but
  // useful inspection into a failed tool call, exactly when the language
  // server is already misbehaving. The header keeps `unanswered=<queries>`
  // whatever gets dropped, so the "absent group is not verified-empty" signal
  // never depends on a line that fits.
  const prelude: string[] = [];
  for (const line of [
    ...(result.queryFailures ?? []).map(formatQueryFailure),
    ...(hover ? [hover] : []),
  ]) {
    if (decodedChars([header, ...prelude, line]) <= domainModelResultCharBudget) {
      prelude.push(line);
    }
  }
  const candidates = buildLspProjectionLines(result);
  const totals: Record<LspCollectionKind, number> = {
    definitions: result.definition?.length ?? 0,
    diagnostics: result.diagnostics?.length ?? 0,
    implementations: result.implementation?.length ?? 0,
  };
  const kept: Record<LspCollectionKind, number> = {
    definitions: 0,
    diagnostics: 0,
    implementations: 0,
  };
  const keptLines: string[] = [];

  for (const candidate of candidates) {
    const candidateKept = { ...kept, [candidate.kind]: kept[candidate.kind] + 1 };
    const omitted = omissionSummary(totals, candidateKept);
    const lines = [
      header,
      ...prelude,
      ...keptLines,
      candidate.value,
      ...(omitted ? [omitted] : []),
    ];
    if (decodedChars(lines) > domainModelResultCharBudget) {
      continue;
    }
    keptLines.push(candidate.value);
    kept[candidate.kind] += 1;
  }

  const omitted = omissionSummary(totals, kept);
  const lines = [header, ...prelude, ...keptLines, ...(omitted ? [omitted] : [])];
  // The header is the only unconditional line, and it is self-bounding (root
  // and path are clipped), so this assertion can no longer be tripped by a
  // degraded inspection — it stays as a genuine invariant check.
  assertProjectionFits('lspInspect', lines, domainModelResultCharBudget);
  return makeTextModelOutput(lines);
}
