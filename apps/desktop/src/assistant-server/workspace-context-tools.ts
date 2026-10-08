/**
 * The workspace-context native tool family (BST-743): listWorkspaceContext,
 * readWorkspaceContext, updateWorkspaceContextSelection, and
 * updateWorkspaceTapestrySelections — selection/tapestry normalization, batched
 * bounded reads, selection validation, and the renderer write-back broadcast
 * over the shared IPC channel catalog.
 *
 * Leaf module: depends on the read/paging, path-resolution, workspace-root,
 * and Workspace Index leaves — never on `assistant-tools.ts`, so no import
 * cycle is possible.
 */
import fsPromises from 'node:fs/promises';
import {
  fitItemsToCharBudget,
  type ListWorkspaceContextInput,
  type ReadWorkspaceContextInput,
  type RuntimeData,
  type RuntimeWorkspaceContextFileMetadata,
  type RuntimeWorkspaceContextMetadata,
  type RuntimeWorkspaceContextRangeMetadata,
  type RuntimeWorkspaceRoot,
  type UpdateWorkspaceContextSelectionInput,
  type UpdateWorkspaceTapestrySelectionsInput,
} from '@brainstrike/agent';
import {
  normalizeWorkspacePath,
  normalizeWorkspacePaths,
  REDACTED_PATH_LOG_VALUE,
  readWorkspaceTextFile,
  redactToolErrorForLog,
  resolveWorkspaceAbsolutePath,
  resolveWorkspaceRootPath,
  runReadWorkspaceFile,
} from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import { countTokensHeuristic } from '@brainstrike/tokenization';
import type {
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
} from '@brainstrike/types';
import { BrowserWindow } from 'electron';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { getWindowRole } from '../window-role';
import {
  normalizeRuntimeWorkspaceIndex,
  type WorkspaceIndexSummary,
} from './runtime-workspace-index';
import {
  getWorkspaceRoots,
  resolveFocusedWorkspaceRoot,
  resolveWorkspaceRoot,
} from './workspace-roots';

const logger = createLogger('DesktopAssistantTools');

const WORKSPACE_CONTEXT_SELECTION_EVENT =
  DESKTOP_IPC_CHANNELS.agent.workspaceContextSelectionUpdate;
const WORKSPACE_CONTEXT_TAPESTRY_EVENT = DESKTOP_IPC_CHANNELS.agent.workspaceContextTapestryUpdate;

const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;
const DEFAULT_CONTEXT_MAX_FILES = 20;
const DEFAULT_CONTEXT_MAX_CHARS_PER_FILE = 12_000;
const READ_WORKSPACE_CONTEXT_BATCH_SIZE = 10;
const SELECTABLE_WORKSPACE_FILE_VALIDATION_BATCH_SIZE = 64;

function escapeSelectionBoundaryTags(content: string): string {
  return content
    .replaceAll('</selection>', '&lt;/selection&gt;')
    .replace(/<selection(?=[\s/>])/g, '&lt;selection');
}

function truncateContent(
  content: string,
  maxChars: number
): { content: string; truncated: boolean; omittedChars: number } {
  if (content.length <= maxChars) {
    return { content, omittedChars: 0, truncated: false };
  }
  return {
    content: content.slice(0, maxChars),
    omittedChars: content.length - maxChars,
    truncated: true,
  };
}

function normalizeRuntimeSelectionFilePaths(runtimeData: RuntimeData | undefined): string[] {
  return normalizeWorkspacePaths(Array.from(runtimeData?.selectionFilePaths ?? []));
}

function resolveSelectionFolderId(
  inputFolderId: string | undefined,
  runtimeData: RuntimeData | undefined
): string {
  const folderId = inputFolderId?.trim() || runtimeData?.selectionFolderId?.trim();
  if (!folderId) {
    throw new Error('No selection folder is available. Select a workspace root first.');
  }
  return folderId;
}

function getRuntimeWorkspaceContext(
  runtimeData: RuntimeData | undefined
): RuntimeWorkspaceContextMetadata | undefined {
  return runtimeData?.workspaceContext;
}

function getRuntimeWorkspaceContextFiles(
  runtimeData: RuntimeData | undefined
): RuntimeWorkspaceContextFileMetadata[] {
  const files = getRuntimeWorkspaceContext(runtimeData)?.files;
  return Array.isArray(files) ? Array.from(files) : [];
}

function normalizeWorkspaceContextRange(
  range: RuntimeWorkspaceContextRangeMetadata
): RuntimeWorkspaceContextRangeMetadata | null {
  if (!(Number.isInteger(range.startLine) && Number.isInteger(range.endLine))) {
    return null;
  }
  if (range.startLine < 1 || range.endLine < range.startLine) {
    return null;
  }
  return {
    endLine: range.endLine,
    startLine: range.startLine,
    ...(typeof range.approxTokens === 'number' ? { approxTokens: range.approxTokens } : {}),
    ...(range.isActive === false ? { isActive: false } : { isActive: true }),
  };
}

function buildRuntimeTapestryRangesByPath(
  runtimeData: RuntimeData | undefined
): Map<string, RuntimeWorkspaceContextRangeMetadata[]> {
  const rangesByPath = new Map<string, RuntimeWorkspaceContextRangeMetadata[]>();
  for (const file of getRuntimeWorkspaceContextFiles(runtimeData)) {
    const normalizedPath = normalizeWorkspacePath(file.path);
    const ranges = Array.from(file.ranges ?? [])
      .map((range) => normalizeWorkspaceContextRange(range))
      .filter((range): range is RuntimeWorkspaceContextRangeMetadata => range !== null);
    if (ranges.length > 0) {
      rangesByPath.set(normalizedPath, ranges);
    }
  }
  return rangesByPath;
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

/** Counts and token budgets only — the per-file range metadata stays behind detail: true. */
function summarizeCuratedContext(context: RuntimeWorkspaceContextMetadata): CuratedContextSummary {
  const files = Array.isArray(context.files) ? context.files : [];
  const rangeCount = files.reduce((total, file) => total + (file.ranges?.length ?? 0), 0);
  return {
    fileCount: files.length,
    rangeCount,
    ...(context.tokenBudget === undefined ? {} : { tokenBudget: context.tokenBudget }),
    ...(context.includeProjectTree === undefined
      ? {}
      : { includeProjectTree: context.includeProjectTree }),
    ...(context.projectTreeApproxTokens === undefined
      ? {}
      : { projectTreeApproxTokens: context.projectTreeApproxTokens }),
    ...(context.selectedSourceApproxTokens === undefined
      ? {}
      : { selectedSourceApproxTokens: context.selectedSourceApproxTokens }),
    ...(context.selectedOutputApproxTokens === undefined
      ? {}
      : { selectedOutputApproxTokens: context.selectedOutputApproxTokens }),
  };
}

interface ListWorkspaceContextToolResult {
  curatedContext?: RuntimeWorkspaceContextMetadata;
  curatedContextSummary?: CuratedContextSummary;
  /** Actionable next step when the selected-file listing was truncated. */
  hint?: string;
  offset: number;
  selectedFileCount: number;
  selectedFiles: string[];
  /**
   * Multi-root forest: selected files in OTHER workspace roots this
   * single-root toolset cannot address — reported so the model can tell the
   * user instead of acting as if the selection were complete.
   */
  selectedFilesOutsideWorkspace?: number;
  selectionFolderId?: string | null;
  tokenEstimates?: Array<{ path: string; approxTokens: number | null }>;
  truncated: boolean;
  workspaceIndex: WorkspaceIndexSummary;
  /**
   * MAIN root path (the assistant's operating root — `workspaceRoots[0]`,
   * client-declared with a created_at fallback). NOT the focused root:
   * selected files live in the FOCUSED root — see selectionFolderId.
   */
  workspaceRootPath: string | null;
  /**
   * Every open workspace root (id + display name + path). The model reads these
   * to pass a `root` qualifier to the read/search tools when several are open.
   */
  workspaceRoots: readonly RuntimeWorkspaceRoot[];
}

export function runListWorkspaceContext(
  input: ListWorkspaceContextInput,
  runtimeData: RuntimeData | undefined
): ListWorkspaceContextToolResult {
  const workspaceRoots = getWorkspaceRoots(runtimeData);
  const resolvedWorkspaceRoots = runtimeData?.workspaceRoots;
  if (
    resolvedWorkspaceRoots !== undefined &&
    resolvedWorkspaceRoots.length !== workspaceRoots.length
  ) {
    throw new TypeError('Workspace root metadata is malformed. Refresh the workspace and retry.');
  }
  if (workspaceRoots.length === 0) {
    if (resolvedWorkspaceRoots === undefined) {
      throw new Error(
        'No folder is open in the workspace. Add a folder in the left file tree first.'
      );
    }
    if ((runtimeData?.selectionFilePathsFromOtherRoots ?? 0) > 0) {
      throw new TypeError(
        'Workspace root metadata is inconsistent: a zero-root workspace cannot retain selections from other roots.'
      );
    }
    return {
      offset: input.offset ?? 0,
      selectedFileCount: 0,
      selectedFiles: [],
      selectionFolderId: null,
      truncated: false,
      workspaceIndex: normalizeRuntimeWorkspaceIndex(runtimeData),
      workspaceRootPath: null,
      workspaceRoots: [],
      ...(input.includeTokenEstimates === true ? { tokenEstimates: [] } : {}),
    };
  }
  // The first root is the MAIN root (client-declared via mainRootId, with the
  // DB created_at order as fallback — see orderWorkspaceRoots). Identical to
  // the legacy resolveWorkspaceRootPath value in the single-root case.
  const workspaceRootPath = workspaceRoots[0]?.path ?? '';
  const selectedFiles = normalizeRuntimeSelectionFilePaths(runtimeData);
  const curatedContext = getRuntimeWorkspaceContext(runtimeData);
  const curatedFilesByPath = new Map(
    getRuntimeWorkspaceContextFiles(runtimeData).map((file) => [
      normalizeWorkspacePath(file.path),
      file,
    ])
  );
  const detail = input.detail ?? false;
  const offset = input.offset ?? 0;
  // Multi-root forest: count of selected files outside this workspace root.
  const outsideWorkspaceCount = runtimeData?.selectionFilePathsFromOtherRoots ?? 0;
  const workspaceIndex = normalizeRuntimeWorkspaceIndex(runtimeData);
  const pagedFiles = selectedFiles.slice(offset);

  // Large selections can hold thousands of paths; bound the listing (and its
  // parallel token-estimate list) to the tool output budget, with the hint
  // built inside the fitted candidate.
  const { result } = fitItemsToCharBudget(pagedFiles, (files): ListWorkspaceContextToolResult => {
    const truncated = offset + files.length < selectedFiles.length;
    const hint = truncated
      ? `Showing selected files ${offset + 1}-${offset + files.length} of ${selectedFiles.length}. ` +
        `Continue with offset: ${offset + files.length}.`
      : undefined;
    return {
      offset,
      selectedFileCount: selectedFiles.length,
      selectedFiles: files,
      truncated,
      workspaceIndex,
      workspaceRootPath,
      workspaceRoots,
      ...(outsideWorkspaceCount > 0
        ? { selectedFilesOutsideWorkspace: outsideWorkspaceCount }
        : {}),
      ...(hint ? { hint } : {}),
      ...(typeof runtimeData?.selectionFolderId === 'string'
        ? { selectionFolderId: runtimeData.selectionFolderId }
        : {}),
      ...(curatedContext
        ? detail
          ? { curatedContext }
          : { curatedContextSummary: summarizeCuratedContext(curatedContext) }
        : {}),
      ...(input.includeTokenEstimates === true
        ? {
            tokenEstimates: files.map((filePath) => ({
              approxTokens: curatedFilesByPath.get(filePath)?.approxTokens ?? null,
              path: filePath,
            })),
          }
        : {}),
    };
  });
  return result;
}

interface WorkspaceContextFileResult {
  approxTokens: number;
  content: string;
  endLine: number;
  omittedChars: number;
  path: string;
  size: number;
  startLine: number;
  tapestryRangeCount?: number;
  tapestryRanges?: Array<{
    approxTokens: number;
    content: string;
    endLine: number;
    startLine: number;
  }>;
  totalLines: number;
  truncated: boolean;
}

interface WorkspaceContextSkippedFile {
  message?: string;
  path: string;
  reason:
    | 'binary'
    | 'maxFiles'
    | 'missing'
    | 'notFile'
    | 'oversized'
    | 'outsideWorkspace'
    | 'readError'
    | 'tokenBudget';
}

function classifyReadContextError(
  workspacePath: string,
  error: unknown
): WorkspaceContextSkippedFile {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('outside the selected workspace root')) {
    return { message, path: workspacePath, reason: 'outsideWorkspace' };
  }
  if (message.includes('is a binary file')) {
    return { message, path: workspacePath, reason: 'binary' };
  }
  if (message.includes('exceeds')) {
    return { message, path: workspacePath, reason: 'oversized' };
  }
  if (message.includes('is not a file')) {
    return { message, path: workspacePath, reason: 'notFile' };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return { path: workspacePath, reason: 'missing' };
  }
  logger.warn('Skipped workspace context file read', {
    code,
    error: redactToolErrorForLog(error),
    path: REDACTED_PATH_LOG_VALUE,
  });
  return { path: workspacePath, reason: 'readError' };
}

function buildRangedContextContent(args: {
  content: string;
  maxChars: number;
  ranges: readonly RuntimeWorkspaceContextRangeMetadata[];
}): {
  approxTokens: number;
  content: string;
  endLine: number;
  omittedChars: number;
  ranges: NonNullable<WorkspaceContextFileResult['tapestryRanges']>;
  startLine: number;
  totalLines: number;
  truncated: boolean;
} {
  const fullLines = args.content.split('\n');
  const totalLines = fullLines.length;
  const activeRanges = args.ranges
    .filter((range) => range.isActive !== false)
    .map((range) => ({
      endLine: Math.max(1, Math.min(range.endLine, totalLines)),
      startLine: Math.max(1, Math.min(range.startLine, totalLines)),
    }))
    .filter((range) => range.endLine >= range.startLine)
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);

  if (activeRanges.length === 0) {
    return {
      approxTokens: 0,
      content: '<selection_summary>No active tapestry ranges selected.</selection_summary>',
      endLine: 1,
      omittedChars: 0,
      ranges: [],
      startLine: 1,
      totalLines,
      truncated: false,
    };
  }

  let remainingChars = args.maxChars;
  let omittedChars = 0;
  let truncated = false;
  const rangeResults: NonNullable<WorkspaceContextFileResult['tapestryRanges']> = [];

  const measureRangeChars = (range: (typeof activeRanges)[number]): number =>
    fullLines.slice(range.startLine - 1, range.endLine).join('\n').length;

  for (const [rangeIndex, range] of activeRanges.entries()) {
    const sliced = fullLines.slice(range.startLine - 1, range.endLine).join('\n');
    const truncatedRange = truncateContent(sliced, Math.max(remainingChars, 0));
    if (sliced.length > 0 && truncatedRange.content.length === 0) {
      const laterRanges = activeRanges.slice(rangeIndex + 1);
      omittedChars +=
        sliced.length +
        laterRanges.reduce((sum, laterRange) => sum + measureRangeChars(laterRange), 0);
      truncated = true;
      break;
    }
    if (truncatedRange.truncated) {
      truncated = true;
      omittedChars += truncatedRange.omittedChars;
    }
    remainingChars -= truncatedRange.content.length;
    rangeResults.push({
      approxTokens: countTokensHeuristic(truncatedRange.content),
      content: truncatedRange.content,
      endLine: range.endLine,
      startLine: range.startLine,
    });
    if (remainingChars <= 0) {
      const laterRanges = activeRanges.slice(rangeIndex + 1);
      omittedChars += laterRanges.reduce(
        (sum, laterRange) => sum + measureRangeChars(laterRange),
        0
      );
      truncated = laterRanges.length > 0 || truncated;
      break;
    }
  }

  const content = rangeResults
    .map(
      (
        range,
        index
      ) => `<selection index="${index + 1}" start_line="${range.startLine}" end_line="${range.endLine}">
${escapeSelectionBoundaryTags(range.content)}
</selection>`
    )
    .join('\n');

  return {
    approxTokens: countTokensHeuristic(content),
    content,
    endLine: activeRanges.at(-1)?.endLine ?? 1,
    omittedChars,
    ranges: rangeResults,
    startLine: activeRanges[0]?.startLine ?? 1,
    totalLines,
    truncated,
  };
}

interface WorkspaceContextResolvedFile {
  approxOutputTokens: number;
  content: string;
  endLine: number;
  omittedChars: number;
  path: string;
  size: number;
  startLine: number;
  tapestryRangeCount?: number;
  tapestryRanges?: WorkspaceContextFileResult['tapestryRanges'];
  totalLines: number;
  truncated: boolean;
}

async function readWorkspaceContextFile(args: {
  maxCharsPerFile: number;
  requestedPath: string;
  root: RuntimeWorkspaceRoot;
  tapestryRanges: RuntimeWorkspaceContextRangeMetadata[] | undefined;
}): Promise<WorkspaceContextResolvedFile> {
  if (args.tapestryRanges && args.tapestryRanges.length > 0) {
    const rawFile = await readWorkspaceTextFile({
      requestedPath: args.requestedPath,
      rootPath: args.root.path,
    });
    const ranged = buildRangedContextContent({
      content: rawFile.content,
      maxChars: args.maxCharsPerFile,
      ranges: args.tapestryRanges,
    });
    return {
      approxOutputTokens: ranged.approxTokens,
      content: ranged.content,
      endLine: ranged.endLine,
      omittedChars: ranged.omittedChars,
      path: rawFile.path,
      size: rawFile.size,
      startLine: ranged.startLine,
      tapestryRangeCount: ranged.ranges.length,
      tapestryRanges: ranged.ranges,
      totalLines: ranged.totalLines,
      truncated: ranged.truncated,
    };
  }

  const file = await runReadWorkspaceFile(
    {
      maxChars: args.maxCharsPerFile,
      path: args.requestedPath,
    },
    { workspaceRootPath: args.root.path, workspaceRoots: [args.root] },
    null
  );
  return {
    approxOutputTokens: file.approxOutputTokens,
    content: file.content,
    endLine: file.endLine,
    omittedChars: file.omittedChars,
    path: file.path,
    size: file.size,
    startLine: file.startLine,
    totalLines: file.totalLines,
    truncated: file.truncated,
  };
}

type WorkspaceContextBatchReadResult =
  | {
      file: WorkspaceContextResolvedFile;
      requestedPath: string;
      status: 'fulfilled';
    }
  | {
      error: unknown;
      requestedPath: string;
      status: 'rejected';
    };

async function readWorkspaceContextBatch(args: {
  batchPaths: readonly string[];
  maxCharsPerFile: number;
  root: RuntimeWorkspaceRoot;
  tapestryRangesByPath: ReadonlyMap<string, RuntimeWorkspaceContextRangeMetadata[]>;
}): Promise<WorkspaceContextBatchReadResult[]> {
  const batchResults = await Promise.allSettled(
    args.batchPaths.map(async (requestedPath) => {
      const normalizedRequestedPath = normalizeWorkspacePath(requestedPath);
      const file = await readWorkspaceContextFile({
        maxCharsPerFile: args.maxCharsPerFile,
        requestedPath: normalizedRequestedPath,
        root: args.root,
        tapestryRanges: args.tapestryRangesByPath.get(normalizedRequestedPath),
      });
      return { file, requestedPath };
    })
  );

  return batchResults.map((result, index) => {
    const requestedPath = args.batchPaths[index] ?? '';
    if (result.status === 'rejected') {
      return { error: result.reason, requestedPath, status: 'rejected' };
    }
    return { ...result.value, status: 'fulfilled' };
  });
}

function toWorkspaceContextFileResult(
  file: WorkspaceContextResolvedFile,
  approxTokens: number
): WorkspaceContextFileResult {
  const fileResult: WorkspaceContextFileResult = {
    approxTokens,
    content: file.content,
    endLine: file.endLine,
    omittedChars: file.omittedChars,
    path: file.path,
    size: file.size,
    startLine: file.startLine,
    totalLines: file.totalLines,
    truncated: file.truncated,
  };
  if (file.tapestryRangeCount !== undefined) {
    fileResult.tapestryRangeCount = file.tapestryRangeCount;
  }
  if (file.tapestryRanges !== undefined) {
    fileResult.tapestryRanges = file.tapestryRanges;
  }
  return fileResult;
}

function appendWorkspaceContextBatch(args: {
  batchResults: readonly WorkspaceContextBatchReadResult[];
  files: WorkspaceContextFileResult[];
  skippedFiles: WorkspaceContextSkippedFile[];
  tokenBudget: number;
  totalApproxTokens: number;
}): number {
  let nextTotalApproxTokens = args.totalApproxTokens;
  for (const result of args.batchResults) {
    if (result.status === 'rejected') {
      args.skippedFiles.push(classifyReadContextError(result.requestedPath, result.error));
      continue;
    }

    const approxTokens = result.file.approxOutputTokens;
    if (nextTotalApproxTokens + approxTokens > args.tokenBudget) {
      args.skippedFiles.push({
        message: `Including this file would exceed the ${args.tokenBudget} token budget.`,
        path: result.file.path,
        reason: 'tokenBudget',
      });
      continue;
    }
    nextTotalApproxTokens += approxTokens;
    args.files.push(toWorkspaceContextFileResult(result.file, approxTokens));
  }
  return nextTotalApproxTokens;
}

export async function runReadWorkspaceContext(
  input: ReadWorkspaceContextInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  workspaceRootPath: string;
  rootId: string;
  rootName: string;
  requestedCount: number;
  includedCount: number;
  skippedCount: number;
  tokenBudget: number;
  totalApproxTokens: number;
  truncated: boolean;
  files: WorkspaceContextFileResult[];
  skippedFiles: WorkspaceContextSkippedFile[];
}> {
  const root =
    input.root === undefined && input.filePaths === undefined
      ? resolveFocusedWorkspaceRoot(runtimeData)
      : resolveWorkspaceRoot(runtimeData, input.root);
  const workspaceRootPath = root.path;
  // The selected-context default (runtimeData.selectionFilePaths) is relative to
  // the FOCUSED root only, so it cannot be resolved against an explicitly chosen
  // root — require explicit filePaths in that case rather than read wrong files.
  if (input.root !== undefined && input.filePaths === undefined) {
    throw new Error(
      `Provide filePaths when reading from a specific root ("${root.displayName}"); the selected-context default only applies to the focused folder.`
    );
  }
  const requestedPaths = normalizeWorkspacePaths(
    input.filePaths ? input.filePaths : Array.from(runtimeData?.selectionFilePaths ?? [])
  );
  if (requestedPaths.length === 0) {
    throw new Error(
      'No workspace context files are selected. Provide filePaths or select files first.'
    );
  }

  const tokenBudget = input.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
  const maxFiles = input.maxFiles ?? DEFAULT_CONTEXT_MAX_FILES;
  const maxCharsPerFile = input.maxCharsPerFile ?? DEFAULT_CONTEXT_MAX_CHARS_PER_FILE;
  const useTapestrySelections = input.useTapestrySelections !== false;
  const tapestryRangesByPath = useTapestrySelections
    ? buildRuntimeTapestryRangesByPath(runtimeData)
    : new Map<string, RuntimeWorkspaceContextRangeMetadata[]>();
  const files: WorkspaceContextFileResult[] = [];
  const skippedFiles: WorkspaceContextSkippedFile[] = [];
  let totalApproxTokens = 0;
  let cursor = 0;

  while (cursor < requestedPaths.length && files.length < maxFiles) {
    const remainingSlots = maxFiles - files.length;
    const batchSize = Math.min(
      READ_WORKSPACE_CONTEXT_BATCH_SIZE,
      remainingSlots,
      requestedPaths.length - cursor
    );
    const batchPaths = requestedPaths.slice(cursor, cursor + batchSize);
    cursor += batchSize;
    const batchResults = await readWorkspaceContextBatch({
      batchPaths,
      maxCharsPerFile,
      root,
      tapestryRangesByPath,
    });
    totalApproxTokens = appendWorkspaceContextBatch({
      batchResults,
      files,
      skippedFiles,
      tokenBudget,
      totalApproxTokens,
    });
  }

  for (const skippedPath of requestedPaths.slice(cursor)) {
    skippedFiles.push({ path: skippedPath, reason: 'maxFiles' });
  }

  return {
    files,
    includedCount: files.length,
    requestedCount: requestedPaths.length,
    rootId: root.rootId,
    rootName: root.displayName,
    skippedCount: skippedFiles.length,
    skippedFiles,
    tokenBudget,
    totalApproxTokens,
    truncated: files.some((file) => file.truncated) || skippedFiles.length > 0,
    workspaceRootPath,
  };
}

interface WorkspaceContextSkippedPath {
  message?: string;
  path: string;
  reason: 'missing' | 'notFile' | 'outsideWorkspace' | 'readError';
}

type SelectableWorkspaceFileValidation =
  | { selectedFile: string }
  | { skippedFile: WorkspaceContextSkippedPath };

function classifySelectionPathError(
  pathValue: string,
  error: unknown
): WorkspaceContextSkippedPath {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('outside the selected workspace root')) {
    return { message, path: pathValue, reason: 'outsideWorkspace' };
  }
  if (message.includes('is not a file')) {
    return { message, path: pathValue, reason: 'notFile' };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return { path: pathValue, reason: 'missing' };
  }
  return { path: pathValue, reason: 'readError' };
}

async function validateSelectableWorkspaceFile(
  rootPath: string,
  requestedPath: string
): Promise<SelectableWorkspaceFileValidation> {
  try {
    const resolved = await resolveWorkspaceAbsolutePath(rootPath, requestedPath);
    const stat = await fsPromises.stat(resolved.absolutePath);
    if (!stat.isFile()) {
      throw new Error(`Path "${requestedPath}" is not a file.`);
    }
    return { selectedFile: resolved.workspacePath };
  } catch (error) {
    return { skippedFile: classifySelectionPathError(requestedPath, error) };
  }
}

async function validateSelectableWorkspaceFiles(args: {
  filePaths: readonly string[];
  mode: 'replace' | 'add' | 'remove' | 'clear';
  rootPath: string;
}): Promise<{
  requestedCount: number;
  selectedFiles: string[];
  skippedFiles: WorkspaceContextSkippedPath[];
}> {
  const requestedPaths = normalizeWorkspacePaths(args.filePaths);
  if (args.mode === 'remove' || args.mode === 'clear') {
    return {
      requestedCount: requestedPaths.length,
      selectedFiles: requestedPaths,
      skippedFiles: [],
    };
  }

  const selectedFiles: string[] = [];
  const skippedFiles: WorkspaceContextSkippedPath[] = [];
  let cursor = 0;
  while (cursor < requestedPaths.length) {
    const batchPaths = requestedPaths.slice(
      cursor,
      cursor + SELECTABLE_WORKSPACE_FILE_VALIDATION_BATCH_SIZE
    );
    cursor += batchPaths.length;
    const validations = await Promise.all(
      batchPaths.map((requestedPath) =>
        validateSelectableWorkspaceFile(args.rootPath, requestedPath)
      )
    );
    for (const validation of validations) {
      if ('selectedFile' in validation) {
        selectedFiles.push(validation.selectedFile);
        continue;
      }
      skippedFiles.push(validation.skippedFile);
    }
  }
  return { requestedCount: requestedPaths.length, selectedFiles, skippedFiles };
}

function broadcastWorkspaceContextEvent(
  channel: typeof WORKSPACE_CONTEXT_SELECTION_EVENT | typeof WORKSPACE_CONTEXT_TAPESTRY_EVENT,
  payload: AssistantWorkspaceContextSelectionUpdatePayload | AssistantWorkspaceTapestryUpdatePayload
): number {
  let notifiedWindowCount = 0;
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (browserWindow.isDestroyed()) {
      continue;
    }
    if (getWindowRole(browserWindow) !== 'visible-ui') {
      continue;
    }
    browserWindow.webContents.send(channel, payload);
    notifiedWindowCount += 1;
  }
  return notifiedWindowCount;
}

/**
 * Resolve the target root for a selection write-back. The client RootId the
 * renderer routes by is NOT the DB roots.id, but both name the SAME absolute
 * path, so a targeted update broadcasts its `rootPath` and the renderer maps it
 * to the matching client folder (see assistant-ui-panel-wrapper).
 * - With `root`: target THAT open folder (resolveWorkspaceRoot throws on an
 *   unknown/ambiguous qualifier); broadcast rootPath/rootId so the renderer
 *   routes there.
 * - Without `root`: target the focused root; the renderer routes by the legacy
 *   client folderId (rootPath omitted).
 */
function resolveWriteBackTarget(
  runtimeData: RuntimeData | undefined,
  inputRoot: string | undefined
): { rootPath: string; broadcastRoot: { rootId: string; rootPath: string } | undefined } {
  if (inputRoot === undefined) {
    return { broadcastRoot: undefined, rootPath: resolveWorkspaceRootPath(runtimeData) };
  }
  const root = resolveWorkspaceRoot(runtimeData, inputRoot);
  return { broadcastRoot: { rootId: root.rootId, rootPath: root.path }, rootPath: root.path };
}

export async function runUpdateWorkspaceContextSelection(
  input: UpdateWorkspaceContextSelectionInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  appliedCount: number;
  folderId: string;
  mode: 'replace' | 'add' | 'remove';
  notifiedWindowCount: number;
  requestedCount: number;
  selectedFiles: string[];
  skippedCount: number;
  skippedFiles: WorkspaceContextSkippedPath[];
}> {
  const { rootPath, broadcastRoot } = resolveWriteBackTarget(runtimeData, input.root);
  const folderId = resolveSelectionFolderId(input.folderId, runtimeData);
  const mode = input.mode ?? 'add';
  const { requestedCount, selectedFiles, skippedFiles } = await validateSelectableWorkspaceFiles({
    filePaths: input.filePaths,
    mode,
    rootPath,
  });
  const notifiedWindowCount =
    selectedFiles.length > 0
      ? broadcastWorkspaceContextEvent(WORKSPACE_CONTEXT_SELECTION_EVENT, {
          filePaths: selectedFiles,
          folderId,
          mode,
          ...(broadcastRoot ?? {}),
        })
      : 0;
  return {
    appliedCount: selectedFiles.length,
    folderId,
    mode,
    notifiedWindowCount,
    requestedCount,
    selectedFiles,
    skippedCount: skippedFiles.length,
    skippedFiles,
  };
}

export async function runUpdateWorkspaceTapestrySelections(
  input: UpdateWorkspaceTapestrySelectionsInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  appliedFileCount: number;
  folderId: string;
  mode: 'replace' | 'add' | 'clear';
  notifiedWindowCount: number;
  requestedFileCount: number;
  selectedFiles: string[];
  skippedFileCount: number;
  skippedFiles: WorkspaceContextSkippedPath[];
}> {
  const { rootPath, broadcastRoot } = resolveWriteBackTarget(runtimeData, input.root);
  const folderId = resolveSelectionFolderId(input.folderId, runtimeData);
  const mode = input.mode ?? 'replace';
  const selectFiles = input.selectFiles !== false;
  const requestedPaths = input.updates.map((update) => update.path);
  const { selectedFiles, skippedFiles } = await validateSelectableWorkspaceFiles({
    filePaths: requestedPaths,
    mode,
    rootPath,
  });
  const selectedFileSet = new Set(selectedFiles);
  const updates = input.updates
    .map((update) => ({
      path: normalizeWorkspacePath(update.path),
      ranges: update.ranges.map((range) => ({
        endLine: range.endLine,
        startLine: range.startLine,
        ...(range.isActive === undefined ? {} : { isActive: range.isActive }),
        ...(range.color === undefined ? {} : { color: range.color }),
      })),
    }))
    .filter((update) => selectedFileSet.has(update.path));

  let notifiedWindowCount = 0;
  if (selectFiles && selectedFiles.length > 0) {
    notifiedWindowCount = broadcastWorkspaceContextEvent(WORKSPACE_CONTEXT_SELECTION_EVENT, {
      filePaths: selectedFiles,
      folderId,
      mode: 'add',
      ...(broadcastRoot ?? {}),
    });
  }
  if (updates.length > 0) {
    notifiedWindowCount = Math.max(
      notifiedWindowCount,
      broadcastWorkspaceContextEvent(WORKSPACE_CONTEXT_TAPESTRY_EVENT, {
        folderId,
        mode,
        updates,
        ...(broadcastRoot ?? {}),
      })
    );
  }

  return {
    appliedFileCount: updates.length,
    folderId,
    mode,
    notifiedWindowCount,
    requestedFileCount: normalizeWorkspacePaths(requestedPaths).length,
    selectedFiles,
    skippedFileCount: skippedFiles.length,
    skippedFiles,
  };
}
