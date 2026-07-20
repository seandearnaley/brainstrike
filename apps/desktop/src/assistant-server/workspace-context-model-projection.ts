import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  type RuntimeWorkspaceContextFileMetadata,
  type RuntimeWorkspaceContextMetadata,
  type RuntimeWorkspaceContextRangeMetadata,
  type RuntimeWorkspaceRoot,
} from '@brainstrike/agent';

export interface WorkspaceContextTextModelOutput {
  type: 'text';
  value: string;
}

interface WorkspaceIndexSummary {
  embeddingSetId: string | null;
  enabled: boolean;
  mode: string | null;
  paused: boolean;
}

interface CuratedContextSummary {
  fileCount: number;
  includeProjectTree?: boolean;
  projectTreeApproxTokens?: number | null;
  rangeCount: number;
  selectedOutputApproxTokens?: number | null;
  selectedSourceApproxTokens?: number | null;
  tokenBudget?: number;
}

interface ListWorkspaceContextResult {
  curatedContext?: RuntimeWorkspaceContextMetadata;
  curatedContextSummary?: CuratedContextSummary;
  hint?: string;
  offset: number;
  selectedFileCount: number;
  selectedFiles: string[];
  selectedFilesOutsideWorkspace?: number;
  selectionFolderId?: string;
  tokenEstimates?: Array<{ approxTokens: number | null; path: string }>;
  truncated: boolean;
  workspaceIndex: WorkspaceIndexSummary;
  workspaceRootPath: string;
  workspaceRoots: RuntimeWorkspaceRoot[];
}

interface ProjectionState {
  contextLines: string[];
  keptContextFiles: number;
  keptOtherRoots: number;
  keptRanges: number;
  keptSelectedFiles: number;
}

const MAX_ID_CHARS = 160;
const MAX_NAME_CHARS = 160;
const MAX_PATH_CHARS = 800;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOptionalMetric(value: unknown): value is number | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isWorkspaceRoot(value: unknown): value is RuntimeWorkspaceRoot {
  return (
    isRecord(value) &&
    typeof value['displayName'] === 'string' &&
    typeof value['path'] === 'string' &&
    typeof value['rootId'] === 'string'
  );
}

function isWorkspaceIndex(value: unknown): value is WorkspaceIndexSummary {
  return (
    isRecord(value) &&
    (value['embeddingSetId'] === null || typeof value['embeddingSetId'] === 'string') &&
    typeof value['enabled'] === 'boolean' &&
    (value['mode'] === null || typeof value['mode'] === 'string') &&
    typeof value['paused'] === 'boolean'
  );
}

function isContextRange(value: unknown): value is RuntimeWorkspaceContextRangeMetadata {
  return (
    isRecord(value) &&
    isOptionalMetric(value['approxTokens']) &&
    isNonNegativeInteger(value['endLine']) &&
    value['endLine'] > 0 &&
    (value['isActive'] === undefined || typeof value['isActive'] === 'boolean') &&
    isNonNegativeInteger(value['startLine']) &&
    value['startLine'] > 0 &&
    value['startLine'] <= value['endLine']
  );
}

function isContextFile(value: unknown): value is RuntimeWorkspaceContextFileMetadata {
  return (
    isRecord(value) &&
    isOptionalMetric(value['approxTokens']) &&
    isOptionalMetric(value['outputApproxTokens']) &&
    typeof value['path'] === 'string' &&
    (value['ranges'] === undefined ||
      (Array.isArray(value['ranges']) && value['ranges'].every(isContextRange))) &&
    isOptionalString(value['rootDisplayName']) &&
    isOptionalString(value['rootId'])
  );
}

function isCuratedFields(value: Record<string, unknown>): boolean {
  return (
    (value['includeProjectTree'] === undefined ||
      typeof value['includeProjectTree'] === 'boolean') &&
    isOptionalMetric(value['projectTreeApproxTokens']) &&
    (value['projectTreeTokenCountLoading'] === undefined ||
      typeof value['projectTreeTokenCountLoading'] === 'boolean') &&
    isOptionalMetric(value['selectedOutputApproxTokens']) &&
    isOptionalMetric(value['selectedSourceApproxTokens']) &&
    (value['tokenBudget'] === undefined || isNonNegativeInteger(value['tokenBudget']))
  );
}

function isCuratedContext(value: unknown): value is RuntimeWorkspaceContextMetadata {
  return (
    isRecord(value) &&
    isCuratedFields(value) &&
    (value['files'] === undefined ||
      (Array.isArray(value['files']) && value['files'].every(isContextFile)))
  );
}

function isCuratedSummary(value: unknown): value is CuratedContextSummary {
  return (
    isRecord(value) &&
    isCuratedFields(value) &&
    isNonNegativeInteger(value['fileCount']) &&
    isNonNegativeInteger(value['rangeCount'])
  );
}

function isTokenEstimate(value: unknown): value is { approxTokens: number | null; path: string } {
  return (
    isRecord(value) &&
    (value['approxTokens'] === null ||
      (typeof value['approxTokens'] === 'number' &&
        Number.isFinite(value['approxTokens']) &&
        value['approxTokens'] >= 0)) &&
    typeof value['path'] === 'string'
  );
}

function throwMalformed(): never {
  throw new TypeError('listWorkspaceContext model projection received a malformed result');
}

function parseListWorkspaceContextResult(output: unknown): ListWorkspaceContextResult {
  if (
    !(
      isRecord(output) &&
      isNonNegativeInteger(output['offset']) &&
      isNonNegativeInteger(output['selectedFileCount']) &&
      Array.isArray(output['selectedFiles']) &&
      output['selectedFiles'].every((pathValue) => typeof pathValue === 'string') &&
      typeof output['truncated'] === 'boolean' &&
      isWorkspaceIndex(output['workspaceIndex']) &&
      typeof output['workspaceRootPath'] === 'string' &&
      Array.isArray(output['workspaceRoots']) &&
      output['workspaceRoots'].length > 0 &&
      output['workspaceRoots'].every(isWorkspaceRoot) &&
      isOptionalString(output['hint']) &&
      isOptionalString(output['selectionFolderId']) &&
      (output['selectedFilesOutsideWorkspace'] === undefined ||
        (isNonNegativeInteger(output['selectedFilesOutsideWorkspace']) &&
          output['selectedFilesOutsideWorkspace'] > 0)) &&
      (output['tokenEstimates'] === undefined ||
        (Array.isArray(output['tokenEstimates']) &&
          output['tokenEstimates'].every(isTokenEstimate))) &&
      (output['curatedContext'] === undefined || isCuratedContext(output['curatedContext'])) &&
      (output['curatedContextSummary'] === undefined ||
        isCuratedSummary(output['curatedContextSummary']))
    )
  ) {
    return throwMalformed();
  }

  const result = output as unknown as ListWorkspaceContextResult;
  if (
    result.workspaceRootPath !== result.workspaceRoots[0]?.path ||
    result.selectedFiles.length > result.selectedFileCount ||
    (result.curatedContext !== undefined && result.curatedContextSummary !== undefined) ||
    (result.tokenEstimates !== undefined &&
      (result.tokenEstimates.length !== result.selectedFiles.length ||
        result.tokenEstimates.some(
          (estimate, index) => estimate.path !== result.selectedFiles[index]
        )))
  ) {
    return throwMalformed();
  }

  const producerTruncated = result.offset + result.selectedFiles.length < result.selectedFileCount;
  if (producerTruncated !== result.truncated) {
    return throwMalformed();
  }
  if (!result.truncated) {
    if (result.hint !== undefined) {
      return throwMalformed();
    }
    return result;
  }
  if (result.selectedFiles.length === 0) {
    throw new RangeError('listWorkspaceContext truncated without an advancing selected-file page');
  }
  if (result.hint === undefined || result.hint.trim().length === 0) {
    return throwMalformed();
  }
  return result;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function escapePathLineBreaks(value: string): string {
  return value
    .replace(/\r/gu, String.raw`\r`)
    .replace(/\n/gu, String.raw`\n`)
    .replace(/\u2028/gu, String.raw`\u2028`)
    .replace(/\u2029/gu, String.raw`\u2029`);
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

function clipPath(value: string): string {
  const escaped = escapePathLineBreaks(value);
  const codePoints = Array.from(escaped);
  if (codePoints.length <= MAX_PATH_CHARS) {
    return escaped;
  }
  const keptAtEachEnd = Math.floor(MAX_PATH_CHARS / 2);
  const omitted = codePoints.length - keptAtEachEnd * 2;
  return `${codePoints.slice(0, keptAtEachEnd).join('')}…[${omitted} path clipped]…${codePoints
    .slice(-keptAtEachEnd)
    .join('')}`;
}

function metric(value: number | null | undefined): string {
  return value === undefined || value === null ? 'unavailable' : String(value);
}

function makeOutput(lines: readonly string[]): WorkspaceContextTextModelOutput {
  return { type: 'text', value: lines.join('\n') };
}

function serializedChars(lines: readonly string[]): number {
  return JSON.stringify(makeOutput(lines)).length;
}

function pageLabel(result: ListWorkspaceContextResult, kept: number): string {
  if (result.selectedFileCount === 0 || kept === 0) {
    return `empty/${result.selectedFileCount}`;
  }
  return `${result.offset + 1}-${result.offset + kept}/${result.selectedFileCount}`;
}

function contextHeader(result: ListWorkspaceContextResult, kept: number): string {
  const focusedRoot = result.selectionFolderId
    ? ` | focused_root_id=${clipEnd(result.selectionFolderId, MAX_ID_CHARS, 'root-id')}`
    : '';
  return (
    `workspace context | main=${clipPath(result.workspaceRootPath)}` +
    ` | selected=${result.selectedFileCount}` +
    ` | outside=${result.selectedFilesOutsideWorkspace ?? 0}` +
    ` | page=${pageLabel(result, kept)}` +
    ` | truncated=${result.truncated}${focusedRoot}`
  );
}

function indexLine(result: ListWorkspaceContextResult): string {
  const { workspaceIndex } = result;
  return (
    `index | enabled=${workspaceIndex.enabled} | paused=${workspaceIndex.paused}` +
    ` | mode=${workspaceIndex.mode ? clipEnd(workspaceIndex.mode, MAX_NAME_CHARS, 'mode') : 'unavailable'}` +
    ` | embedding_set=${
      workspaceIndex.embeddingSetId
        ? clipEnd(workspaceIndex.embeddingSetId, MAX_ID_CHARS, 'embedding-set-id')
        : 'unavailable'
    }`
  );
}

function rootLine(root: RuntimeWorkspaceRoot, main: boolean): string {
  return (
    `root${main ? ' main' : ''}` +
    ` | name=${clipEnd(root.displayName, MAX_NAME_CHARS, 'root-name')}` +
    ` | id=${clipEnd(root.rootId, MAX_ID_CHARS, 'root-id')}` +
    ` | path=${clipPath(root.path)}`
  );
}

function selectedLine(result: ListWorkspaceContextResult, index: number): string {
  const estimate = result.tokenEstimates?.[index];
  const suffix = estimate ? ` | approx_tokens=${metric(estimate.approxTokens)}` : '';
  return `selected ${clipPath(result.selectedFiles[index] ?? '')}${suffix}`;
}

function curatedFields(
  value: CuratedContextSummary | RuntimeWorkspaceContextMetadata,
  fileCount: number,
  rangeCount: number
): string {
  return (
    `files=${fileCount} | ranges=${rangeCount} | budget=${metric(value.tokenBudget)}` +
    ` | selected_source_tokens=${metric(value.selectedSourceApproxTokens)}` +
    ` | selected_output_tokens=${metric(value.selectedOutputApproxTokens)}` +
    ` | project_tree=${
      value.includeProjectTree === undefined ? 'unavailable' : value.includeProjectTree
    }` +
    ` | project_tree_tokens=${metric(value.projectTreeApproxTokens)}`
  );
}

function curatedLine(result: ListWorkspaceContextResult): string | null {
  if (result.curatedContextSummary) {
    return `curated | ${curatedFields(
      result.curatedContextSummary,
      result.curatedContextSummary.fileCount,
      result.curatedContextSummary.rangeCount
    )}`;
  }
  if (!result.curatedContext) {
    return null;
  }
  const files = result.curatedContext.files ?? [];
  const rangeCount = files.reduce((sum, file) => sum + (file.ranges?.length ?? 0), 0);
  const loading =
    result.curatedContext.projectTreeTokenCountLoading === undefined
      ? 'unavailable'
      : String(result.curatedContext.projectTreeTokenCountLoading);
  return (
    `curated detail | ${curatedFields(result.curatedContext, files.length, rangeCount)}` +
    ` | project_tree_loading=${loading}`
  );
}

function contextFileLine(file: RuntimeWorkspaceContextFileMetadata, index: number): string {
  const root =
    file.rootDisplayName || file.rootId
      ? `${clipEnd(file.rootDisplayName ?? 'unavailable', MAX_NAME_CHARS, 'root-name')}|${clipEnd(
          file.rootId ?? 'unavailable',
          MAX_ID_CHARS,
          'root-id'
        )}`
      : 'unqualified';
  return (
    `context_file ${index + 1} | root=${root} | path=${clipPath(file.path)}` +
    ` | source_tokens=${metric(file.approxTokens)}` +
    ` | output_tokens=${metric(file.outputApproxTokens)}` +
    ` | ranges=${file.ranges?.length ?? 0}`
  );
}

function contextRangeLine(
  range: RuntimeWorkspaceContextRangeMetadata,
  fileIndex: number,
  rangeIndex: number
): string {
  const active = range.isActive === undefined ? 'unavailable' : String(range.isActive);
  return (
    `range ${fileIndex + 1}.${rangeIndex + 1} | lines=${range.startLine}-${range.endLine}` +
    ` | active=${active} | approx_tokens=${metric(range.approxTokens)}`
  );
}

function totalDetailCounts(result: ListWorkspaceContextResult): {
  files: number;
  ranges: number;
} {
  const files = result.curatedContext?.files ?? [];
  return {
    files: files.length,
    ranges: files.reduce((sum, file) => sum + (file.ranges?.length ?? 0), 0),
  };
}

function omissionLine(result: ListWorkspaceContextResult, state: ProjectionState): string | null {
  const detail = totalDetailCounts(result);
  const omitted = {
    contextFiles: detail.files - state.keptContextFiles,
    ranges: detail.ranges - state.keptRanges,
    roots: result.workspaceRoots.length - 1 - state.keptOtherRoots,
    selectedFiles: result.selectedFiles.length - state.keptSelectedFiles,
  };
  if (Object.values(omitted).every((count) => count === 0)) {
    return null;
  }
  return (
    `projection_omitted: roots=${omitted.roots}, selected_files=${omitted.selectedFiles}, ` +
    `context_files=${omitted.contextFiles}, ranges=${omitted.ranges}`
  );
}

function continuationLine(
  result: ListWorkspaceContextResult,
  keptSelectedFiles: number
): string | null {
  if (keptSelectedFiles === result.selectedFiles.length && !result.truncated) {
    return null;
  }
  return (
    'continue: reuse the prior brainstrike.listWorkspaceContext input with ' +
    `offset=${result.offset + keptSelectedFiles}`
  );
}

function buildLines(result: ListWorkspaceContextResult, state: ProjectionState): string[] {
  const omitted = omissionLine(result, state);
  const continuation = continuationLine(result, state.keptSelectedFiles);
  const curated = curatedLine(result);
  return [
    contextHeader(result, state.keptSelectedFiles),
    indexLine(result),
    rootLine(result.workspaceRoots[0] as RuntimeWorkspaceRoot, true),
    ...result.workspaceRoots
      .slice(1, state.keptOtherRoots + 1)
      .map((root) => rootLine(root, false)),
    ...result.selectedFiles
      .slice(0, state.keptSelectedFiles)
      .map((_, index) => selectedLine(result, index)),
    ...(curated ? [curated] : []),
    ...state.contextLines,
    ...(omitted ? [omitted] : []),
    ...(continuation ? [continuation] : []),
  ];
}

function fits(result: ListWorkspaceContextResult, state: ProjectionState): boolean {
  return serializedChars(buildLines(result, state)) <= MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET;
}

function fitSelectedFiles(result: ListWorkspaceContextResult, state: ProjectionState): void {
  while (state.keptSelectedFiles < result.selectedFiles.length) {
    const candidate = { ...state, keptSelectedFiles: state.keptSelectedFiles + 1 };
    if (!fits(result, candidate)) {
      return;
    }
    state.keptSelectedFiles += 1;
  }
}

function reserveAdvancingSelectedFile(
  result: ListWorkspaceContextResult,
  state: ProjectionState
): void {
  if (result.selectedFiles.length === 0) {
    return;
  }
  const candidate = { ...state, keptSelectedFiles: 1 };
  if (!fits(result, candidate)) {
    throw new RangeError(
      'listWorkspaceContext projection cannot emit an advancing selected-file page'
    );
  }
  state.keptSelectedFiles = 1;
}

function assertProjectionCanAdvance(
  result: ListWorkspaceContextResult,
  state: ProjectionState
): void {
  if (result.selectedFiles.length > 0 && state.keptSelectedFiles === 0) {
    throw new RangeError(
      'listWorkspaceContext projection cannot emit an advancing selected-file page'
    );
  }
}

function fitOtherRoots(result: ListWorkspaceContextResult, state: ProjectionState): void {
  const otherRootCount = result.workspaceRoots.length - 1;
  while (state.keptOtherRoots < otherRootCount) {
    const candidate = { ...state, keptOtherRoots: state.keptOtherRoots + 1 };
    if (!fits(result, candidate)) {
      return;
    }
    state.keptOtherRoots += 1;
  }
}

function fitContextDetails(result: ListWorkspaceContextResult, state: ProjectionState): void {
  const contextFiles = result.curatedContext?.files ?? [];
  for (const [fileIndex, file] of contextFiles.entries()) {
    const fileLine = contextFileLine(file, fileIndex);
    const fileCandidate = {
      ...state,
      contextLines: [...state.contextLines, fileLine],
      keptContextFiles: state.keptContextFiles + 1,
    };
    if (!fits(result, fileCandidate)) {
      return;
    }
    state.contextLines.push(fileLine);
    state.keptContextFiles += 1;

    for (const [rangeIndex, range] of (file.ranges ?? []).entries()) {
      const rangeLine = contextRangeLine(range, fileIndex, rangeIndex);
      const rangeCandidate = {
        ...state,
        contextLines: [...state.contextLines, rangeLine],
        keptRanges: state.keptRanges + 1,
      };
      if (!fits(result, rangeCandidate)) {
        return;
      }
      state.contextLines.push(rangeLine);
      state.keptRanges += 1;
    }
  }
}

export function projectListWorkspaceContextModelOutput(
  output: unknown
): WorkspaceContextTextModelOutput {
  const result = parseListWorkspaceContextResult(output);
  const state: ProjectionState = {
    contextLines: [],
    keptContextFiles: 0,
    keptOtherRoots: 0,
    keptRanges: 0,
    keptSelectedFiles: 0,
  };

  reserveAdvancingSelectedFile(result, state);
  fitOtherRoots(result, state);
  fitSelectedFiles(result, state);
  assertProjectionCanAdvance(result, state);
  fitContextDetails(result, state);

  const lines = buildLines(result, state);
  if (serializedChars(lines) > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
    throw new RangeError(
      `listWorkspaceContext model projection exceeds the ${MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET}-character domain budget`
    );
  }
  return makeOutput(lines);
}
