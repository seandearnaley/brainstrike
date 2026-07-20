import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import type {
  EditDiagnostic,
  InspectLocation,
  LspInspectionResult,
  LspUnavailableReason,
} from './lsp-diagnostics';

export interface WorkspaceInspectionTextModelOutput {
  type: 'text';
  value: string;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

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
    throw new TypeError('findWorkspaceSymbol model projection received a malformed result');
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
  key: 'definition' | 'diagnostics' | 'implementation',
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
      hasOptionalArray(output, 'implementation', isInspectLocation)
    )
  ) {
    throw new TypeError('lspInspect model projection received a malformed result');
  }
  if (
    output['available'] === false &&
    !(isUnavailableReason(output['reason']) && typeof output['message'] === 'string')
  ) {
    throw new TypeError('lspInspect model projection received a malformed result');
  }
  if (output['available'] === true && output['reason'] !== undefined) {
    throw new TypeError('lspInspect model projection received a malformed result');
  }
  return output as unknown as LspInspectResult;
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
  return `${codePoints.slice(0, maxChars).join('')}…[${
    codePoints.length - maxChars
  } ${label} chars omitted]`;
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

function makeTextModelOutput(lines: readonly string[]): WorkspaceInspectionTextModelOutput {
  return { type: 'text', value: lines.join('\n') };
}

function serializedChars(lines: readonly string[]): number {
  return JSON.stringify(makeTextModelOutput(lines)).length;
}

function assertProjectionFits(
  toolName: 'findWorkspaceSymbol' | 'lspInspect',
  lines: readonly string[]
): void {
  if (serializedChars(lines) <= MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
    return;
  }
  throw new RangeError(
    `${toolName} model projection exceeds the ${MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET}-character domain budget`
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
  'inspect: call brainstrike.lspInspect with the header root/path and one returned declaration line; place exactly one <<< immediately before the intended symbol in the returned declaration text';

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
  output: unknown
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
    if (serializedChars(candidate) > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
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
  assertProjectionFits('findWorkspaceSymbol', lines);
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
  return result.language ? `${base} | language=${singleLine(result.language)}` : base;
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

export function projectLspInspectModelOutput(output: unknown): WorkspaceInspectionTextModelOutput {
  const result = parseLspInspectResult(output);
  const header = lspHeader(result);
  if (!result.available) {
    const lines = [
      header,
      `message: ${clipEnd(result.message ?? '', MAX_DIAGNOSTIC_CHARS, 'message')}`,
    ];
    assertProjectionFits('lspInspect', lines);
    return makeTextModelOutput(lines);
  }

  const hover = result.hover ? `hover: ${clipEnd(result.hover, MAX_HOVER_CHARS, 'hover')}` : null;
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
      ...(hover ? [hover] : []),
      ...keptLines,
      candidate.value,
      ...(omitted ? [omitted] : []),
    ];
    if (serializedChars(lines) > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
      continue;
    }
    keptLines.push(candidate.value);
    kept[candidate.kind] += 1;
  }

  const omitted = omissionSummary(totals, kept);
  const lines = [header, ...(hover ? [hover] : []), ...keptLines, ...(omitted ? [omitted] : [])];
  assertProjectionFits('lspInspect', lines);
  return makeTextModelOutput(lines);
}
