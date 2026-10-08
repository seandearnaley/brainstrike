import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  type RuntimeWorkspaceContextFileMetadata,
  type RuntimeWorkspaceContextMetadata,
  type RuntimeWorkspaceContextRangeMetadata,
  type RuntimeWorkspaceRoot,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import {
  clipProjectionEnd as clipEnd,
  clipProjectionMiddle,
  decodedWorkspaceTextModelOutputChars as decodedChars,
  escapeProjectionPathLineBreaks as escapePathLineBreaks,
  isNonNegativeInteger,
  isRecord,
  makeWorkspaceTextModelOutput as makeOutput,
  type WorkspaceTextModelOutput,
} from '@brainstrike/host-capabilities/native-tools';

export type WorkspaceContextTextModelOutput = WorkspaceTextModelOutput;

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
  selectionFolderId?: string | null;
  tokenEstimates?: Array<{ approxTokens: number | null; path: string }>;
  truncated: boolean;
  workspaceIndex: WorkspaceIndexSummary;
  workspaceRootPath: string | null;
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

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === null || isOptionalString(value);
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
  throw new ToolProjectionInputRejectedError(
    'listWorkspaceContext model projection received a malformed result'
  );
}

function hasCoherentRootState(result: ListWorkspaceContextResult): boolean {
  const mainRoot = result.workspaceRoots[0];
  if (mainRoot) {
    return result.workspaceRootPath === mainRoot.path && result.selectionFolderId !== null;
  }
  return (
    result.workspaceRootPath === null &&
    result.selectionFolderId === null &&
    result.selectedFileCount === 0 &&
    result.selectedFiles.length === 0 &&
    result.selectedFilesOutsideWorkspace === undefined &&
    result.curatedContext === undefined &&
    result.curatedContextSummary === undefined
  );
}

function isListWorkspaceContextResultShape(value: unknown): value is ListWorkspaceContextResult {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value['offset']) &&
    isNonNegativeInteger(value['selectedFileCount']) &&
    Array.isArray(value['selectedFiles']) &&
    value['selectedFiles'].every((pathValue) => typeof pathValue === 'string') &&
    typeof value['truncated'] === 'boolean' &&
    isWorkspaceIndex(value['workspaceIndex']) &&
    (value['workspaceRootPath'] === null || typeof value['workspaceRootPath'] === 'string') &&
    Array.isArray(value['workspaceRoots']) &&
    value['workspaceRoots'].every(isWorkspaceRoot) &&
    isOptionalString(value['hint']) &&
    isOptionalNullableString(value['selectionFolderId']) &&
    (value['selectedFilesOutsideWorkspace'] === undefined ||
      (isNonNegativeInteger(value['selectedFilesOutsideWorkspace']) &&
        value['selectedFilesOutsideWorkspace'] > 0)) &&
    (value['tokenEstimates'] === undefined ||
      (Array.isArray(value['tokenEstimates']) && value['tokenEstimates'].every(isTokenEstimate))) &&
    (value['curatedContext'] === undefined || isCuratedContext(value['curatedContext'])) &&
    (value['curatedContextSummary'] === undefined ||
      isCuratedSummary(value['curatedContextSummary']))
  );
}

function parseListWorkspaceContextResult(output: unknown): ListWorkspaceContextResult {
  if (!isListWorkspaceContextResultShape(output)) {
    return throwMalformed();
  }

  const result = output;
  if (
    !hasCoherentRootState(result) ||
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

function clipPath(value: string): string {
  return clipProjectionMiddle(escapePathLineBreaks(value), MAX_PATH_CHARS, 'path');
}

function metric(value: number | null | undefined): string {
  return value === undefined || value === null ? 'unavailable' : String(value);
}

function pageLabel(result: ListWorkspaceContextResult, kept: number): string {
  if (result.selectedFileCount === 0 || kept === 0) {
    return `empty/${result.selectedFileCount}`;
  }
  return `${result.offset + 1}-${result.offset + kept}/${result.selectedFileCount}`;
}

function contextHeader(result: ListWorkspaceContextResult, kept: number): string {
  if (result.workspaceRoots.length === 0) {
    return (
      'workspace context | roots=0 | main=none | focused_root_id=none' +
      ` | selected=${result.selectedFileCount}` +
      ` | outside=${result.selectedFilesOutsideWorkspace ?? 0}` +
      ` | page=${pageLabel(result, kept)}` +
      ` | truncated=${result.truncated}`
    );
  }
  const focusedRoot = result.selectionFolderId
    ? ` | focused_root_id=${clipEnd(result.selectionFolderId, MAX_ID_CHARS, 'root-id')}`
    : '';
  return (
    `workspace context | main=${clipPath(result.workspaceRootPath ?? '')}` +
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
    roots: Math.max(0, result.workspaceRoots.length - 1) - state.keptOtherRoots,
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
    ...(result.workspaceRoots[0]
      ? [rootLine(result.workspaceRoots[0] as RuntimeWorkspaceRoot, true)]
      : []),
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

function fits(
  result: ListWorkspaceContextResult,
  state: ProjectionState,
  domainModelResultCharBudget: number
): boolean {
  return decodedChars(buildLines(result, state)) <= domainModelResultCharBudget;
}

function fitSelectedFiles(
  result: ListWorkspaceContextResult,
  state: ProjectionState,
  domainModelResultCharBudget: number
): void {
  while (state.keptSelectedFiles < result.selectedFiles.length) {
    const candidate = { ...state, keptSelectedFiles: state.keptSelectedFiles + 1 };
    if (!fits(result, candidate, domainModelResultCharBudget)) {
      return;
    }
    state.keptSelectedFiles += 1;
  }
}

function reserveAdvancingSelectedFile(
  result: ListWorkspaceContextResult,
  state: ProjectionState,
  domainModelResultCharBudget: number
): void {
  if (result.selectedFiles.length === 0) {
    return;
  }
  const candidate = { ...state, keptSelectedFiles: 1 };
  if (!fits(result, candidate, domainModelResultCharBudget)) {
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

function fitOtherRoots(
  result: ListWorkspaceContextResult,
  state: ProjectionState,
  domainModelResultCharBudget: number
): void {
  const otherRootCount = Math.max(0, result.workspaceRoots.length - 1);
  while (state.keptOtherRoots < otherRootCount) {
    const candidate = { ...state, keptOtherRoots: state.keptOtherRoots + 1 };
    if (!fits(result, candidate, domainModelResultCharBudget)) {
      return;
    }
    state.keptOtherRoots += 1;
  }
}

function fitContextDetails(
  result: ListWorkspaceContextResult,
  state: ProjectionState,
  domainModelResultCharBudget: number
): void {
  const contextFiles = result.curatedContext?.files ?? [];
  for (const [fileIndex, file] of contextFiles.entries()) {
    const fileLine = contextFileLine(file, fileIndex);
    const fileCandidate = {
      ...state,
      contextLines: [...state.contextLines, fileLine],
      keptContextFiles: state.keptContextFiles + 1,
    };
    if (!fits(result, fileCandidate, domainModelResultCharBudget)) {
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
      if (!fits(result, rangeCandidate, domainModelResultCharBudget)) {
        return;
      }
      state.contextLines.push(rangeLine);
      state.keptRanges += 1;
    }
  }
}

export function projectListWorkspaceContextModelOutput(
  output: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): WorkspaceContextTextModelOutput {
  const result = parseListWorkspaceContextResult(output);
  const state: ProjectionState = {
    contextLines: [],
    keptContextFiles: 0,
    keptOtherRoots: 0,
    keptRanges: 0,
    keptSelectedFiles: 0,
  };

  reserveAdvancingSelectedFile(result, state, domainModelResultCharBudget);
  fitOtherRoots(result, state, domainModelResultCharBudget);
  fitSelectedFiles(result, state, domainModelResultCharBudget);
  assertProjectionCanAdvance(result, state);
  fitContextDetails(result, state, domainModelResultCharBudget);

  const lines = buildLines(result, state);
  if (decodedChars(lines) > domainModelResultCharBudget) {
    throw new RangeError(
      `listWorkspaceContext model projection exceeds the ${domainModelResultCharBudget}-character domain budget`
    );
  }
  return makeOutput(lines);
}
