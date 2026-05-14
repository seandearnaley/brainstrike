import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  type ListEmbeddingSetsInput,
  ListEmbeddingSetsInputSchema,
  type ListWorkspaceContextInput,
  ListWorkspaceContextInputSchema,
  type QueryEmbeddingSpaceInput,
  QueryEmbeddingSpaceInputSchema,
  type ReadWorkspaceContextInput,
  ReadWorkspaceContextInputSchema,
  type ReadWorkspaceDirectoryInput,
  ReadWorkspaceDirectoryInputSchema,
  type ReadWorkspaceFileInput,
  ReadWorkspaceFileInputSchema,
  type RuntimeData,
  type RuntimeWorkspaceContextFileMetadata,
  type RuntimeWorkspaceContextMetadata,
  type RuntimeWorkspaceContextRangeMetadata,
  type UpdateWorkspaceContextSelectionInput,
  UpdateWorkspaceContextSelectionInputSchema,
  type UpdateWorkspaceTapestrySelectionsInput,
  UpdateWorkspaceTapestrySelectionsInputSchema,
} from '@brainstrike/agent';
import { countTokensHeuristic } from '@brainstrike/text-splitter';
import type {
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
} from '@brainstrike/types';
import { defaultCollator } from '@brainstrike/utils/collator';
import { createLogger } from '@brainstrike/utils/logger';
import { BrowserWindow } from 'electron';
import { getDatabase } from '../db-main';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import { runQueryEmbeddingSpace } from './retrieval-tool';

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

export interface DesktopAssistantToolDependencies {
  embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
}

const logger = createLogger('DesktopAssistantTools');

const READ_WORKSPACE_FILE_TOOL_ID = 'brainstrike.readWorkspaceFile' as const;
const READ_WORKSPACE_DIRECTORY_TOOL_ID = 'brainstrike.readWorkspaceDirectory' as const;
const LIST_WORKSPACE_CONTEXT_TOOL_ID = 'brainstrike.listWorkspaceContext' as const;
const READ_WORKSPACE_CONTEXT_TOOL_ID = 'brainstrike.readWorkspaceContext' as const;
const UPDATE_WORKSPACE_CONTEXT_SELECTION_TOOL_ID =
  'brainstrike.updateWorkspaceContextSelection' as const;
const UPDATE_WORKSPACE_TAPESTRY_SELECTIONS_TOOL_ID =
  'brainstrike.updateWorkspaceTapestrySelections' as const;
const LIST_EMBEDDING_SPACES_TOOL_ID = 'brainstrike.listEmbeddingSpaces' as const;
const QUERY_EMBEDDING_SPACE_TOOL_ID = 'brainstrike.queryEmbeddingSpace' as const;
const WORKSPACE_CONTEXT_SELECTION_EVENT = 'assistant:workspace-context-selection-update' as const;
const WORKSPACE_CONTEXT_TAPESTRY_EVENT = 'assistant:workspace-context-tapestry-update' as const;

const DEFAULT_FILE_MAX_CHARS = 12_000;
const MAX_READ_WORKSPACE_FILE_BYTES = 2_000_000;
const DEFAULT_DIRECTORY_MAX_ENTRIES = 150;
const DEFAULT_DIRECTORY_DEPTH = 1;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;
const DEFAULT_CONTEXT_MAX_FILES = 20;
const DEFAULT_CONTEXT_MAX_CHARS_PER_FILE = 12_000;
const READ_WORKSPACE_CONTEXT_BATCH_SIZE = 10;

type ToolExecuteInput<T> = { context: T } | T;

function resolveToolExecuteInput<T>(input: ToolExecuteInput<T>): T {
  // Mastra sometimes wraps tool args as { context: T } for compatibility.
  // Assumption: none of our direct tool input shapes define a top-level `context` field.
  const maybeWrapped = input as { context?: T };
  if (
    typeof input === 'object' &&
    input !== null &&
    'context' in input &&
    maybeWrapped.context !== undefined
  ) {
    return maybeWrapped.context;
  }
  return input as T;
}

function normalizeWorkspacePath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/');
  const withoutDotPrefix = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  const withoutTrailing = withoutDotPrefix.replace(/\/+$/, '');
  return withoutTrailing.length > 0 ? withoutTrailing : '/';
}

function normalizeWorkspacePaths(paths: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const filePath of paths) {
    const normalized = normalizeWorkspacePath(filePath);
    if (normalized.length > 0) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

function normalizeWorkspaceRootPath(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !path.isAbsolute(trimmed)) {
    return;
  }
  return path.resolve(trimmed);
}

function resolveWorkspaceRootPath(runtimeData: RuntimeData | undefined): string {
  const rootPath = normalizeWorkspaceRootPath(runtimeData?.workspaceRootPath);
  if (!rootPath) {
    throw new Error(
      'No workspace root is available. Open/select a folder in the left file tree first.'
    );
  }
  return rootPath;
}

async function resolveWorkspaceAbsolutePath(
  rootPath: string,
  workspacePath: string
): Promise<{ workspacePath: string; absolutePath: string }> {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  const relativePath =
    normalizedWorkspacePath === '/' ? '' : normalizedWorkspacePath.replace(/^\/+/, '');
  const absolutePath = path.resolve(rootPath, relativePath);
  const canonicalRootPath = await fsPromises.realpath(rootPath);
  const canonicalAbsolutePath = await fsPromises.realpath(absolutePath);
  const relativeFromRoot = path.relative(canonicalRootPath, canonicalAbsolutePath);
  if (
    relativeFromRoot.startsWith('..') ||
    relativeFromRoot.includes(`${path.sep}..${path.sep}`) ||
    relativeFromRoot === '..' ||
    path.isAbsolute(relativeFromRoot)
  ) {
    throw new Error(`Path "${workspacePath}" is outside the selected workspace root.`);
  }
  return {
    workspacePath: normalizedWorkspacePath,
    absolutePath: canonicalAbsolutePath,
  };
}

function sliceContentByLineRange(
  content: string,
  startLine: number | undefined,
  endLine: number | undefined
): { content: string; startLine: number; endLine: number; totalLines: number } {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const resolvedStart = Math.max(1, Math.min(startLine ?? 1, totalLines));
  const resolvedEnd = Math.max(resolvedStart, Math.min(endLine ?? totalLines, totalLines));
  const sliced = lines.slice(resolvedStart - 1, resolvedEnd).join('\n');
  return { content: sliced, startLine: resolvedStart, endLine: resolvedEnd, totalLines };
}

function truncateContent(
  content: string,
  maxChars: number
): { content: string; truncated: boolean; omittedChars: number } {
  if (content.length <= maxChars) {
    return { content, truncated: false, omittedChars: 0 };
  }
  return {
    content: content.slice(0, maxChars),
    truncated: true,
    omittedChars: content.length - maxChars,
  };
}

async function readWorkspaceTextFile(args: { requestedPath: string; rootPath: string }): Promise<{
  content: string;
  path: string;
  size: number;
}> {
  const resolved = await resolveWorkspaceAbsolutePath(args.rootPath, args.requestedPath);

  const stat = await fsPromises.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Path "${args.requestedPath}" is not a file.`);
  }
  if (stat.size > MAX_READ_WORKSPACE_FILE_BYTES) {
    throw new Error(
      `Path "${args.requestedPath}" exceeds ${MAX_READ_WORKSPACE_FILE_BYTES} bytes and cannot be read in full.`
    );
  }

  const fileBuffer = await fsPromises.readFile(resolved.absolutePath);
  const binaryProbeLength = Math.min(fileBuffer.length, 4096);
  for (let index = 0; index < binaryProbeLength; index += 1) {
    if (fileBuffer[index] === 0) {
      throw new Error(`Path "${args.requestedPath}" is a binary file and cannot be read as text.`);
    }
  }

  return {
    path: resolved.workspacePath,
    size: Number(stat.size),
    content: fileBuffer.toString('utf8'),
  };
}

async function runReadWorkspaceFile(
  input: ReadWorkspaceFileInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  path: string;
  size: number;
  tokenCount: number | null;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  omittedChars: number;
  approxOutputTokens: number;
  content: string;
}> {
  const rootPath = resolveWorkspaceRootPath(runtimeData);
  const requestedPath = input.path;
  const file = await readWorkspaceTextFile({ rootPath, requestedPath });
  const ranged = sliceContentByLineRange(file.content, input.startLine, input.endLine);
  const maxChars = input.maxChars ?? DEFAULT_FILE_MAX_CHARS;
  const truncated = truncateContent(ranged.content, maxChars);

  return {
    path: file.path,
    size: file.size,
    tokenCount: null,
    startLine: ranged.startLine,
    endLine: ranged.endLine,
    totalLines: ranged.totalLines,
    truncated: truncated.truncated,
    omittedChars: truncated.omittedChars,
    approxOutputTokens: countTokensHeuristic(truncated.content),
    content: truncated.content,
  };
}

interface DirectoryEntry {
  depth: number;
  path: string;
  size?: number;
  tokenCount?: number;
  type: 'directory' | 'file';
}

function toPathSegments(workspacePath: string): string[] {
  return workspacePath
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
}

function joinSegments(baseSegments: readonly string[], childSegments: readonly string[]): string {
  const merged = [...baseSegments, ...childSegments].filter((segment) => segment.length > 0);
  return `/${merged.join('/')}`;
}

function isHiddenPath(entryPath: string): boolean {
  return toPathSegments(entryPath).some((segment) => segment.startsWith('.'));
}

type FsDirent = import('node:fs').Dirent;

interface DirectoryTraversalOptions {
  baseSegments: readonly string[];
  depth: number;
  includeDirectories: boolean;
  includeFiles: boolean;
  includeHidden: boolean;
}

interface DirectoryTraversalState {
  entries: DirectoryEntry[];
  maxEntries: number;
  totalMatchedFiles: number;
  truncated: boolean;
}

interface DirectoryVisitContext {
  childAbsolutePath: string;
  childDepth: number;
  childPath: string;
  childSegments: string[];
}

function sortDirectoryEntries(entries: FsDirent[]): FsDirent[] {
  return entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return defaultCollator.compare(a.name, b.name);
  });
}

function pushDirectoryEntry(state: DirectoryTraversalState, entry: DirectoryEntry): void {
  if (state.entries.length >= state.maxEntries) {
    state.truncated = true;
    return;
  }
  state.entries.push(entry);
}

function buildDirectoryVisitContext(
  dirent: FsDirent,
  currentAbsolutePath: string,
  relativeSegments: readonly string[],
  options: DirectoryTraversalOptions
): DirectoryVisitContext | undefined {
  const childSegments = [...relativeSegments, dirent.name];
  const childPath = joinSegments(options.baseSegments, childSegments);
  if (!options.includeHidden && isHiddenPath(childPath)) {
    return;
  }
  return {
    childAbsolutePath: path.join(currentAbsolutePath, dirent.name),
    childSegments,
    childPath,
    childDepth: childSegments.length,
  };
}

function processDirectoryEntry(
  context: DirectoryVisitContext,
  options: DirectoryTraversalOptions,
  state: DirectoryTraversalState
): boolean {
  if (options.includeDirectories && context.childDepth <= options.depth) {
    pushDirectoryEntry(state, {
      path: context.childPath,
      type: 'directory',
      depth: context.childDepth,
    });
  }
  return context.childDepth <= options.depth;
}

async function processFileEntry(
  context: DirectoryVisitContext,
  options: DirectoryTraversalOptions,
  state: DirectoryTraversalState
): Promise<void> {
  state.totalMatchedFiles += 1;
  if (!(options.includeFiles && context.childDepth <= options.depth + 1)) {
    return;
  }

  let size: number | undefined;
  try {
    const stat = await fsPromises.stat(context.childAbsolutePath);
    size = stat.size;
  } catch {
    size = undefined;
  }

  pushDirectoryEntry(state, {
    path: context.childPath,
    type: 'file',
    depth: context.childDepth,
    ...(typeof size === 'number' ? { size } : {}),
  });
}

async function runReadWorkspaceDirectory(
  input: ReadWorkspaceDirectoryInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  path: string;
  depth: number;
  maxEntries: number;
  includeFiles: boolean;
  includeDirectories: boolean;
  includeHidden: boolean;
  entries: DirectoryEntry[];
  count: number;
  totalMatchedFiles: number;
  truncated: boolean;
}> {
  const rootPath = resolveWorkspaceRootPath(runtimeData);
  const requestedPath = input.path ?? '/';
  const normalizedPath = normalizeWorkspacePath(requestedPath);
  const resolvedBase = await resolveWorkspaceAbsolutePath(rootPath, normalizedPath);

  const baseStats = await fsPromises.stat(resolvedBase.absolutePath);
  if (!baseStats.isDirectory()) {
    throw new Error(`Path "${normalizedPath}" is not a directory.`);
  }

  const depth = input.depth ?? DEFAULT_DIRECTORY_DEPTH;
  const maxEntries = input.maxEntries ?? DEFAULT_DIRECTORY_MAX_ENTRIES;
  const includeFiles = input.includeFiles ?? true;
  const includeDirectories = input.includeDirectories ?? true;
  const includeHidden = input.includeHidden ?? false;

  const options: DirectoryTraversalOptions = {
    baseSegments: normalizedPath === '/' ? [] : toPathSegments(normalizedPath),
    includeHidden,
    includeDirectories,
    includeFiles,
    depth,
  };
  const state: DirectoryTraversalState = {
    entries: [],
    maxEntries,
    truncated: false,
    totalMatchedFiles: 0,
  };

  const visit = async (currentAbsolutePath: string, relativeSegments: readonly string[]) => {
    if (state.truncated) {
      return;
    }

    const dirEntries = sortDirectoryEntries(
      await fsPromises.readdir(currentAbsolutePath, { withFileTypes: true })
    );

    for (const dirent of dirEntries) {
      if (state.truncated) {
        return;
      }

      const context = buildDirectoryVisitContext(
        dirent,
        currentAbsolutePath,
        relativeSegments,
        options
      );
      if (!context) {
        continue;
      }

      if (dirent.isDirectory()) {
        const shouldRecurse = processDirectoryEntry(context, options, state);
        if (shouldRecurse) {
          await visit(context.childAbsolutePath, context.childSegments);
        }
        continue;
      }

      if (dirent.isFile()) {
        await processFileEntry(context, options, state);
      }
    }
  };

  await visit(resolvedBase.absolutePath, []);

  return {
    path: normalizedPath,
    depth,
    maxEntries,
    includeFiles,
    includeDirectories,
    includeHidden,
    entries: state.entries,
    count: state.entries.length,
    totalMatchedFiles: state.totalMatchedFiles,
    truncated: state.truncated,
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
    startLine: range.startLine,
    endLine: range.endLine,
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

interface WorkspaceIndexSummary {
  embeddingSetId: string | null;
  enabled: boolean;
  mode: string | null;
  paused: boolean;
}

function normalizeRuntimeWorkspaceIndex(
  runtimeData: RuntimeData | undefined
): WorkspaceIndexSummary {
  const rawEmbeddingSetId = runtimeData?.workspaceIndexEmbeddingSetId;
  const embeddingSetId =
    typeof rawEmbeddingSetId === 'string' && rawEmbeddingSetId.trim().length > 0
      ? rawEmbeddingSetId.trim()
      : null;
  return {
    embeddingSetId,
    enabled: runtimeData?.workspaceIndexingEnabled === true,
    mode:
      typeof runtimeData?.workspaceIndexingMode === 'string' &&
      runtimeData.workspaceIndexingMode.trim().length > 0
        ? runtimeData.workspaceIndexingMode.trim()
        : null,
    paused: runtimeData?.workspaceIndexingPaused === true,
  };
}

function runListWorkspaceContext(
  input: ListWorkspaceContextInput,
  runtimeData: RuntimeData | undefined
): {
  curatedContext?: RuntimeWorkspaceContextMetadata;
  workspaceRootPath: string;
  selectionFolderId?: string;
  selectedFileCount: number;
  selectedFiles: string[];
  tokenEstimates?: Array<{ path: string; approxTokens: number | null }>;
  workspaceIndex: WorkspaceIndexSummary;
} {
  const workspaceRootPath = resolveWorkspaceRootPath(runtimeData);
  const selectedFiles = normalizeRuntimeSelectionFilePaths(runtimeData);
  const curatedContext = getRuntimeWorkspaceContext(runtimeData);
  const curatedFilesByPath = new Map(
    getRuntimeWorkspaceContextFiles(runtimeData).map((file) => [
      normalizeWorkspacePath(file.path),
      file,
    ])
  );
  const result: {
    curatedContext?: RuntimeWorkspaceContextMetadata;
    workspaceRootPath: string;
    selectionFolderId?: string;
    selectedFileCount: number;
    selectedFiles: string[];
    tokenEstimates?: Array<{ path: string; approxTokens: number | null }>;
    workspaceIndex: WorkspaceIndexSummary;
  } = {
    workspaceRootPath,
    selectedFileCount: selectedFiles.length,
    selectedFiles,
    workspaceIndex: normalizeRuntimeWorkspaceIndex(runtimeData),
  };
  if (curatedContext) {
    result.curatedContext = curatedContext;
  }
  if (typeof runtimeData?.selectionFolderId === 'string') {
    result.selectionFolderId = runtimeData.selectionFolderId;
  }
  if (input.includeTokenEstimates === true) {
    result.tokenEstimates = selectedFiles.map((filePath) => ({
      path: filePath,
      approxTokens: curatedFilesByPath.get(filePath)?.approxTokens ?? null,
    }));
  }
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
    return { path: workspacePath, reason: 'outsideWorkspace', message };
  }
  if (message.includes('is a binary file')) {
    return { path: workspacePath, reason: 'binary', message };
  }
  if (message.includes('exceeds')) {
    return { path: workspacePath, reason: 'oversized', message };
  }
  if (message.includes('is not a file')) {
    return { path: workspacePath, reason: 'notFile', message };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return { path: workspacePath, reason: 'missing', message };
  }
  return { path: workspacePath, reason: 'readError', message };
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
      startLine: Math.max(1, Math.min(range.startLine, totalLines)),
      endLine: Math.max(1, Math.min(range.endLine, totalLines)),
    }))
    .filter((range) => range.endLine >= range.startLine)
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);

  if (activeRanges.length === 0) {
    return {
      approxTokens: 0,
      content: '<selection_summary>No active tapestry ranges selected.</selection_summary>',
      startLine: 1,
      endLine: 1,
      totalLines,
      truncated: false,
      omittedChars: 0,
      ranges: [],
    };
  }

  let remainingChars = args.maxChars;
  let omittedChars = 0;
  let truncated = false;
  const rangeResults: NonNullable<WorkspaceContextFileResult['tapestryRanges']> = [];

  for (const range of activeRanges) {
    const sliced = fullLines.slice(range.startLine - 1, range.endLine).join('\n');
    const truncatedRange = truncateContent(sliced, Math.max(remainingChars, 0));
    if (truncatedRange.truncated) {
      truncated = true;
      omittedChars += truncatedRange.omittedChars;
    }
    remainingChars -= truncatedRange.content.length;
    rangeResults.push({
      startLine: range.startLine,
      endLine: range.endLine,
      approxTokens: countTokensHeuristic(truncatedRange.content),
      content: truncatedRange.content,
    });
    if (remainingChars <= 0) {
      const laterRanges = activeRanges.slice(rangeResults.length);
      omittedChars += laterRanges.reduce((sum, laterRange) => {
        const laterContent = fullLines
          .slice(laterRange.startLine - 1, laterRange.endLine)
          .join('\n');
        return sum + laterContent.length;
      }, 0);
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
${range.content}
</selection>`
    )
    .join('\n');

  return {
    approxTokens: countTokensHeuristic(content),
    content,
    startLine: activeRanges[0]?.startLine ?? 1,
    endLine: activeRanges.at(-1)?.endLine ?? 1,
    totalLines,
    truncated,
    omittedChars,
    ranges: rangeResults,
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
  rootPath: string;
  tapestryRanges: RuntimeWorkspaceContextRangeMetadata[] | undefined;
}): Promise<WorkspaceContextResolvedFile> {
  if (args.tapestryRanges && args.tapestryRanges.length > 0) {
    const rawFile = await readWorkspaceTextFile({
      rootPath: args.rootPath,
      requestedPath: args.requestedPath,
    });
    const ranged = buildRangedContextContent({
      content: rawFile.content,
      maxChars: args.maxCharsPerFile,
      ranges: args.tapestryRanges,
    });
    return {
      path: rawFile.path,
      size: rawFile.size,
      startLine: ranged.startLine,
      endLine: ranged.endLine,
      totalLines: ranged.totalLines,
      truncated: ranged.truncated,
      omittedChars: ranged.omittedChars,
      approxOutputTokens: ranged.approxTokens,
      content: ranged.content,
      tapestryRangeCount: ranged.ranges.length,
      tapestryRanges: ranged.ranges,
    };
  }

  const file = await runReadWorkspaceFile(
    {
      path: args.requestedPath,
      maxChars: args.maxCharsPerFile,
    },
    { workspaceRootPath: args.rootPath }
  );
  return {
    path: file.path,
    size: file.size,
    startLine: file.startLine,
    endLine: file.endLine,
    totalLines: file.totalLines,
    truncated: file.truncated,
    omittedChars: file.omittedChars,
    approxOutputTokens: file.approxOutputTokens,
    content: file.content,
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
  tapestryRangesByPath: ReadonlyMap<string, RuntimeWorkspaceContextRangeMetadata[]>;
  workspaceRootPath: string;
}): Promise<WorkspaceContextBatchReadResult[]> {
  const batchResults = await Promise.allSettled(
    args.batchPaths.map(async (requestedPath) => {
      const normalizedRequestedPath = normalizeWorkspacePath(requestedPath);
      const file = await readWorkspaceContextFile({
        rootPath: args.workspaceRootPath,
        requestedPath: normalizedRequestedPath,
        maxCharsPerFile: args.maxCharsPerFile,
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
    path: file.path,
    size: file.size,
    startLine: file.startLine,
    endLine: file.endLine,
    totalLines: file.totalLines,
    truncated: file.truncated,
    omittedChars: file.omittedChars,
    approxTokens,
    content: file.content,
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
        path: result.file.path,
        reason: 'tokenBudget',
        message: `Including this file would exceed the ${args.tokenBudget} token budget.`,
      });
      continue;
    }
    nextTotalApproxTokens += approxTokens;
    args.files.push(toWorkspaceContextFileResult(result.file, approxTokens));
  }
  return nextTotalApproxTokens;
}

async function runReadWorkspaceContext(
  input: ReadWorkspaceContextInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  workspaceRootPath: string;
  requestedCount: number;
  includedCount: number;
  skippedCount: number;
  tokenBudget: number;
  totalApproxTokens: number;
  truncated: boolean;
  files: WorkspaceContextFileResult[];
  skippedFiles: WorkspaceContextSkippedFile[];
}> {
  const workspaceRootPath = resolveWorkspaceRootPath(runtimeData);
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
  const tapestryRangesByPath =
    useTapestrySelections && getRuntimeWorkspaceContext(runtimeData)?.useTapestryRanges !== false
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
      tapestryRangesByPath,
      workspaceRootPath,
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
    workspaceRootPath,
    requestedCount: requestedPaths.length,
    includedCount: files.length,
    skippedCount: skippedFiles.length,
    tokenBudget,
    totalApproxTokens,
    truncated: files.some((file) => file.truncated) || skippedFiles.length > 0,
    files,
    skippedFiles,
  };
}

interface WorkspaceContextSkippedPath {
  message?: string;
  path: string;
  reason: 'missing' | 'notFile' | 'outsideWorkspace' | 'readError';
}

function classifySelectionPathError(
  pathValue: string,
  error: unknown
): WorkspaceContextSkippedPath {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('outside the selected workspace root')) {
    return { path: pathValue, reason: 'outsideWorkspace', message };
  }
  if (message.includes('is not a file')) {
    return { path: pathValue, reason: 'notFile', message };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return { path: pathValue, reason: 'missing', message };
  }
  return { path: pathValue, reason: 'readError', message };
}

async function validateSelectableWorkspaceFiles(args: {
  filePaths: readonly string[];
  mode: 'replace' | 'add' | 'remove' | 'clear';
  rootPath: string;
}): Promise<{ selectedFiles: string[]; skippedFiles: WorkspaceContextSkippedPath[] }> {
  const selectedFiles: string[] = [];
  const skippedFiles: WorkspaceContextSkippedPath[] = [];
  for (const requestedPath of normalizeWorkspacePaths(args.filePaths)) {
    if (args.mode === 'remove' || args.mode === 'clear') {
      selectedFiles.push(requestedPath);
      continue;
    }
    try {
      const resolved = await resolveWorkspaceAbsolutePath(args.rootPath, requestedPath);
      const stat = await fsPromises.stat(resolved.absolutePath);
      if (!stat.isFile()) {
        throw new Error(`Path "${requestedPath}" is not a file.`);
      }
      selectedFiles.push(resolved.workspacePath);
    } catch (error) {
      skippedFiles.push(classifySelectionPathError(requestedPath, error));
    }
  }
  return { selectedFiles, skippedFiles };
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
    browserWindow.webContents.send(channel, payload);
    notifiedWindowCount += 1;
  }
  return notifiedWindowCount;
}

async function runUpdateWorkspaceContextSelection(
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
  const rootPath = resolveWorkspaceRootPath(runtimeData);
  const folderId = resolveSelectionFolderId(input.folderId, runtimeData);
  const mode = input.mode ?? 'add';
  const { selectedFiles, skippedFiles } = await validateSelectableWorkspaceFiles({
    rootPath,
    filePaths: input.filePaths,
    mode,
  });
  const notifiedWindowCount =
    selectedFiles.length > 0
      ? broadcastWorkspaceContextEvent(WORKSPACE_CONTEXT_SELECTION_EVENT, {
          folderId,
          filePaths: selectedFiles,
          mode,
        })
      : 0;
  return {
    folderId,
    mode,
    requestedCount: normalizeWorkspacePaths(input.filePaths).length,
    appliedCount: selectedFiles.length,
    skippedCount: skippedFiles.length,
    selectedFiles,
    skippedFiles,
    notifiedWindowCount,
  };
}

async function runUpdateWorkspaceTapestrySelections(
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
  const rootPath = resolveWorkspaceRootPath(runtimeData);
  const folderId = resolveSelectionFolderId(input.folderId, runtimeData);
  const mode = input.mode ?? 'replace';
  const selectFiles = input.selectFiles !== false;
  const requestedPaths = input.updates.map((update) => update.path);
  const { selectedFiles, skippedFiles } = await validateSelectableWorkspaceFiles({
    rootPath,
    filePaths: requestedPaths,
    mode,
  });
  const selectedFileSet = new Set(selectedFiles);
  const updates = input.updates
    .map((update) => ({
      path: normalizeWorkspacePath(update.path),
      ranges: update.ranges.map((range) => ({
        startLine: range.startLine,
        endLine: range.endLine,
        ...(range.isActive === undefined ? {} : { isActive: range.isActive }),
      })),
    }))
    .filter((update) => selectedFileSet.has(update.path));

  let notifiedWindowCount = 0;
  if (selectFiles && selectedFiles.length > 0) {
    notifiedWindowCount = broadcastWorkspaceContextEvent(WORKSPACE_CONTEXT_SELECTION_EVENT, {
      folderId,
      filePaths: selectedFiles,
      mode: 'add',
    });
  }
  if (updates.length > 0) {
    notifiedWindowCount = Math.max(
      notifiedWindowCount,
      broadcastWorkspaceContextEvent(WORKSPACE_CONTEXT_TAPESTRY_EVENT, {
        folderId,
        mode,
        updates,
      })
    );
  }

  return {
    folderId,
    mode,
    requestedFileCount: normalizeWorkspacePaths(requestedPaths).length,
    appliedFileCount: updates.length,
    skippedFileCount: skippedFiles.length,
    selectedFiles,
    skippedFiles,
    notifiedWindowCount,
  };
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface EmbeddingSpaceRow {
  createdAt: string | null;
  description: string | null;
  dimensions: number;
  distance: string | null;
  embeddedChunks?: number | string | null;
  id: string;
  modelId: string;
  modelKey: string;
  name: string;
  totalChunks?: number | string | null;
}

async function runListEmbeddingSpaces(
  input: ListEmbeddingSetsInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  count: number;
  workspaceIndex: WorkspaceIndexSummary;
  spaces: Array<{
    id: string;
    name: string;
    description: string | null;
    modelKey: string;
    modelId: string;
    dimensions: number;
    distance: string | null;
    createdAt: string | null;
    isWorkspaceIndex: boolean;
    recommendedForWorkspaceSearch: boolean;
    coverage?: {
      embeddedChunks: number;
      totalChunks: number;
      coveragePercent: number;
    };
  }>;
}> {
  const workspaceIndex = normalizeRuntimeWorkspaceIndex(runtimeData);
  const db = await getDatabase();
  const result = input.includeStats
    ? await db.query(
        `SELECT
          es.id,
          es.name,
          es.description,
          es.model_key AS "modelKey",
          es.model_id AS "modelId",
          es.dimensions,
          es.distance,
          es.created_at AS "createdAt",
          COUNT(fc.id) FILTER (WHERE fc.embedding IS NOT NULL)::text AS "embeddedChunks",
          COUNT(fc.id)::text AS "totalChunks"
        FROM embedding_sets es
        LEFT JOIN file_chunks fc ON fc.embedding_set_id = es.id
        GROUP BY es.id, es.name, es.description, es.model_key, es.model_id, es.dimensions, es.distance, es.created_at
        ORDER BY es.created_at DESC`
      )
    : await db.query(
        `SELECT
          id,
          name,
          description,
          model_key AS "modelKey",
          model_id AS "modelId",
          dimensions,
          distance,
          created_at AS "createdAt"
        FROM embedding_sets
        ORDER BY created_at DESC`
      );
  const rows = result.rows as EmbeddingSpaceRow[];
  const mappedSpaces = rows.map((row) => {
    const isWorkspaceIndex = row.id === workspaceIndex.embeddingSetId;
    const space = {
      id: row.id,
      name: row.name,
      description: row.description,
      modelKey: row.modelKey,
      modelId: row.modelId,
      dimensions: Number(row.dimensions),
      distance: row.distance,
      createdAt: row.createdAt,
      isWorkspaceIndex,
      recommendedForWorkspaceSearch: isWorkspaceIndex,
    };
    if (input.includeStats !== true) {
      return space;
    }
    const embeddedChunks = toNumber(row.embeddedChunks);
    const totalChunks = toNumber(row.totalChunks);
    return {
      ...space,
      coverage: {
        embeddedChunks,
        totalChunks,
        coveragePercent: totalChunks > 0 ? Math.round((embeddedChunks / totalChunks) * 100) : 0,
      },
    };
  });
  const spaces =
    input.workspaceIndexOnly === true
      ? mappedSpaces.filter((space) => space.isWorkspaceIndex)
      : mappedSpaces;
  return { count: spaces.length, workspaceIndex, spaces };
}

function resolveQueryEmbeddingSpaceInput(
  input: ToolExecuteInput<QueryEmbeddingSpaceInput>
): QueryEmbeddingSpaceInput {
  const raw = resolveToolExecuteInput(input) as Partial<QueryEmbeddingSpaceInput>;
  if (!(typeof raw.embeddingSetId === 'string' && raw.embeddingSetId.trim().length > 0)) {
    throw new Error('Select an embedding space before querying semantic context.');
  }
  return QueryEmbeddingSpaceInputSchema.parse(raw);
}

/**
 * Builds the Mastra ToolsInput for the desktop assistant server.
 */
export function buildDesktopAssistantTools(
  runtimeData: RuntimeData | undefined,
  dependencies: DesktopAssistantToolDependencies = {}
): MastraTools {
  const tools: MastraTools = {
    [READ_WORKSPACE_FILE_TOOL_ID]: {
      id: READ_WORKSPACE_FILE_TOOL_ID,
      description:
        'Read a workspace file from the selected root. Use line ranges and maxChars to keep context efficient.',
      inputSchema: ReadWorkspaceFileInputSchema,
      execute: async (input: ToolExecuteInput<ReadWorkspaceFileInput>) => {
        const resolvedInput = ReadWorkspaceFileInputSchema.parse(resolveToolExecuteInput(input));
        try {
          return await runReadWorkspaceFile(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('readWorkspaceFile failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
    [READ_WORKSPACE_DIRECTORY_TOOL_ID]: {
      id: READ_WORKSPACE_DIRECTORY_TOOL_ID,
      description:
        'List workspace directory entries in a compact token-efficient format. Use depth and maxEntries to bound output.',
      inputSchema: ReadWorkspaceDirectoryInputSchema,
      execute: async (input: ToolExecuteInput<ReadWorkspaceDirectoryInput>) => {
        const resolvedInput = ReadWorkspaceDirectoryInputSchema.parse(
          resolveToolExecuteInput(input)
        );
        try {
          return await runReadWorkspaceDirectory(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('readWorkspaceDirectory failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
    [LIST_WORKSPACE_CONTEXT_TOOL_ID]: {
      id: LIST_WORKSPACE_CONTEXT_TOOL_ID,
      description:
        'Inspect the current workspace root, selected context paths, and workspace index hint without returning file contents. Use before reading selected context.',
      inputSchema: ListWorkspaceContextInputSchema,
      execute: async (input: ToolExecuteInput<ListWorkspaceContextInput>) => {
        const resolvedInput = ListWorkspaceContextInputSchema.parse(resolveToolExecuteInput(input));
        try {
          return runListWorkspaceContext(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('listWorkspaceContext failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
    [READ_WORKSPACE_CONTEXT_TOOL_ID]: {
      id: READ_WORKSPACE_CONTEXT_TOOL_ID,
      description:
        'Read selected or explicit workspace files under maxFiles, per-file, and token budgets. Uses curated Tapestry ranges by default when available. Use after semantic search when you need exact source lines. Skipped and truncated files are reported explicitly.',
      inputSchema: ReadWorkspaceContextInputSchema,
      execute: async (input: ToolExecuteInput<ReadWorkspaceContextInput>) => {
        const resolvedInput = ReadWorkspaceContextInputSchema.parse(resolveToolExecuteInput(input));
        try {
          return await runReadWorkspaceContext(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('readWorkspaceContext failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
    [UPDATE_WORKSPACE_CONTEXT_SELECTION_TOOL_ID]: {
      id: UPDATE_WORKSPACE_CONTEXT_SELECTION_TOOL_ID,
      description:
        'Bulk add, remove, or replace files selected in the workspace context explorer. Use this to curate reusable context for the user; listWorkspaceContext reports token counts afterward.',
      inputSchema: UpdateWorkspaceContextSelectionInputSchema,
      execute: async (input: ToolExecuteInput<UpdateWorkspaceContextSelectionInput>) => {
        const resolvedInput = UpdateWorkspaceContextSelectionInputSchema.parse(
          resolveToolExecuteInput(input)
        );
        try {
          return await runUpdateWorkspaceContextSelection(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('updateWorkspaceContextSelection failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
    [UPDATE_WORKSPACE_TAPESTRY_SELECTIONS_TOOL_ID]: {
      id: UPDATE_WORKSPACE_TAPESTRY_SELECTIONS_TOOL_ID,
      description:
        'Create, add, or clear Tapestry line selections for workspace context files using 1-based inclusive line numbers. Use after embedding search and file reads to keep only verified source ranges.',
      inputSchema: UpdateWorkspaceTapestrySelectionsInputSchema,
      execute: async (input: ToolExecuteInput<UpdateWorkspaceTapestrySelectionsInput>) => {
        const resolvedInput = UpdateWorkspaceTapestrySelectionsInputSchema.parse(
          resolveToolExecuteInput(input)
        );
        try {
          return await runUpdateWorkspaceTapestrySelections(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('updateWorkspaceTapestrySelections failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
    [LIST_EMBEDDING_SPACES_TOOL_ID]: {
      id: LIST_EMBEDDING_SPACES_TOOL_ID,
      description:
        'List available embedding spaces and identify the configured workspace index. For codebase questions, call this first and prefer the space marked recommendedForWorkspaceSearch, then pass its explicit id to queryEmbeddingSpace.',
      inputSchema: ListEmbeddingSetsInputSchema,
      execute: async (input: ToolExecuteInput<ListEmbeddingSetsInput>) => {
        const resolvedInput = ListEmbeddingSetsInputSchema.parse(resolveToolExecuteInput(input));
        try {
          return await runListEmbeddingSpaces(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('listEmbeddingSpaces failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
    [QUERY_EMBEDDING_SPACE_TOOL_ID]: {
      id: QUERY_EMBEDDING_SPACE_TOOL_ID,
      description:
        'Query a specific embedding space by explicit embeddingSetId and return bounded source text plus metadata-only chunks with persisted line ranges. For workspace/codebase searches, use listEmbeddingSpaces first and prefer its recommended workspace index. Provide tokenBudget, limit, threshold, and optional filePaths; read files afterward only when surrounding context is needed.',
      inputSchema: QueryEmbeddingSpaceInputSchema,
      execute: async (input: ToolExecuteInput<QueryEmbeddingSpaceInput>) => {
        const resolvedInput = resolveQueryEmbeddingSpaceInput(input);
        try {
          return await runQueryEmbeddingSpace(resolvedInput, runtimeData, {
            embeddingHostManager: dependencies.embeddingHostManager,
          });
        } catch (error) {
          logger.error('queryEmbeddingSpace failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
  };
  const enabledNativeToolIds = runtimeData?.enabledNativeToolIds;
  if (!Array.isArray(enabledNativeToolIds)) {
    return tools;
  }

  const enabledSet = new Set(
    enabledNativeToolIds.filter((toolId): toolId is string => typeof toolId === 'string')
  );
  const unknownToolIds = Array.from(enabledSet).filter((toolId) => tools[toolId] === undefined);
  if (unknownToolIds.length > 0) {
    logger.warn('Ignoring unknown enabled native tool ids', { toolIds: unknownToolIds });
  }
  const filteredTools: MastraTools = {};
  for (const [toolId, tool] of Object.entries(tools)) {
    if (enabledSet.has(toolId)) {
      filteredTools[toolId] = tool;
    }
  }
  const disabledCount = Object.keys(tools).length - Object.keys(filteredTools).length;
  if (disabledCount > 0) {
    logger.debug('Filtered desktop assistant native tools', {
      disabledCount,
      enabledCount: Object.keys(filteredTools).length,
    });
  }
  return filteredTools;
}
