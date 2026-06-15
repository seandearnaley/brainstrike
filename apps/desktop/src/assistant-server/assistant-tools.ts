import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  type FindWorkspaceSymbolInput,
  FindWorkspaceSymbolInputSchema,
  fitItemsToCharBudget,
  type GrepSearchInput,
  GrepSearchInputSchema,
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
  type RuntimeWorkspaceRoot,
  type UpdateWorkspaceContextSelectionInput,
  UpdateWorkspaceContextSelectionInputSchema,
  type UpdateWorkspaceTapestrySelectionsInput,
  UpdateWorkspaceTapestrySelectionsInputSchema,
} from '@brainstrike/agent';
import {
  EmbeddingSetsRepository,
  type EmbeddingSpaceListing,
  type EmbeddingSpaceStats,
} from '@brainstrike/db';
import { countTokensHeuristic } from '@brainstrike/text-splitter';
import type {
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
} from '@brainstrike/types';
import { defaultCollator } from '@brainstrike/utils/collator';
import { createLogger } from '@brainstrike/utils/logger';
import { BrowserWindow } from 'electron';
import type { z } from 'zod';
import { getDatabase } from '../db-main';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { getWindowRole } from '../window-role';
import { findSymbolMatches } from './find-workspace-symbol';
import { GREP_SEARCH_TOOL_ID, runGrepSearch } from './grep-search-tool';
import { runQueryEmbeddingSpace } from './retrieval-tool';
import {
  isHiddenPath,
  isWithinRoot,
  joinSegments,
  normalizeWorkspacePath,
  normalizeWorkspacePaths,
  toPathSegments,
} from './workspace-path';
import { getWorkspaceRoots, resolveWorkspaceRoot } from './workspace-roots';

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

export interface DesktopAssistantToolDependencies {
  embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
}

const logger = createLogger('DesktopAssistantTools');

const FIND_WORKSPACE_SYMBOL_TOOL_ID = 'brainstrike.findWorkspaceSymbol' as const;
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
const WORKSPACE_CONTEXT_SELECTION_EVENT =
  DESKTOP_IPC_CHANNELS.agent.workspaceContextSelectionUpdate;
const WORKSPACE_CONTEXT_TAPESTRY_EVENT = DESKTOP_IPC_CHANNELS.agent.workspaceContextTapestryUpdate;

const DEFAULT_FILE_MAX_CHARS = 12_000;
const MAX_READ_WORKSPACE_FILE_BYTES = 2_000_000;
const DEFAULT_DIRECTORY_MAX_ENTRIES = 150;
const DEFAULT_DIRECTORY_DEPTH = 1;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;
const DEFAULT_CONTEXT_MAX_FILES = 20;
const DEFAULT_CONTEXT_MAX_CHARS_PER_FILE = 12_000;
const READ_WORKSPACE_CONTEXT_BATCH_SIZE = 10;
const SELECTABLE_WORKSPACE_FILE_VALIDATION_BATCH_SIZE = 64;

type AssistantEmbeddingSpaceListing = Omit<EmbeddingSpaceListing, 'stats'> & {
  readonly coverage?: EmbeddingSpaceStats & {
    readonly coveragePercent: number;
  };
  readonly isWorkspaceIndex: boolean;
  readonly recommendedForWorkspaceSearch: boolean;
};

type ToolExecuteInput<T> = { context: T } | T;

function resolveToolExecuteInputCandidate<T>(
  schema: z.ZodType<T>,
  input: ToolExecuteInput<T>
): unknown {
  const directResult = schema.safeParse(input);
  if (directResult.success) {
    return directResult.data;
  }

  // Mastra sometimes wraps tool args as { context: T } for compatibility. Try
  // direct schema parsing first so a future tool with a legitimate top-level
  // `context` field is not silently unwrapped by this compatibility bridge.
  const maybeWrapped = input as { context?: T };
  if (
    typeof input === 'object' &&
    input !== null &&
    Object.keys(input).length === 1 &&
    'context' in input &&
    maybeWrapped.context !== undefined
  ) {
    const wrappedResult = schema.safeParse(maybeWrapped.context);
    if (wrappedResult.success) {
      return wrappedResult.data;
    }
    return input;
  }

  return input;
}

function parseToolExecuteInput<T>(schema: z.ZodType<T>, input: ToolExecuteInput<T>): T {
  return schema.parse(resolveToolExecuteInputCandidate(schema, input));
}

function escapeSelectionBoundaryTags(content: string): string {
  return content
    .replaceAll('</selection>', '&lt;/selection&gt;')
    .replace(/<selection(?=[\s/>])/g, '&lt;selection');
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
      'No folder is open in the workspace. Add a folder in the left file tree first.'
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
  // Resolve symlinks on both sides, then check containment on the canonical
  // paths. ".." can't escape (clamped in normalizeWorkspacePath); this guards
  // the remaining vector — a symlink whose target lives outside the root.
  const canonicalRootPath = await fsPromises.realpath(rootPath);
  const canonicalAbsolutePath = await fsPromises.realpath(absolutePath);
  if (!isWithinRoot(canonicalRootPath, canonicalAbsolutePath)) {
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

async function runFindWorkspaceSymbol(
  input: FindWorkspaceSymbolInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  rootName: string;
  path: string;
  totalMatches: number;
  truncated: boolean;
  matches: ReturnType<typeof findSymbolMatches>['matches'];
}> {
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  // Route through the checked reader so the same guards apply (isFile, 2 MB size
  // cap, NUL-byte binary probe). Symbol scanning returns only a tiny bounded
  // result, so a multi-MB bundle or binary file must error cleanly rather than
  // be loaded and scanned in full on the main process.
  const file = await readWorkspaceTextFile({ rootPath: root.path, requestedPath: input.path });
  const { matches, totalMatches, truncated } = findSymbolMatches(file.content, input.query, {
    maxMatches: input.maxMatches ?? 5,
    contextLines: input.contextLines ?? 2,
  });
  return { rootName: root.displayName, path: file.path, totalMatches, truncated, matches };
}

async function runReadWorkspaceFile(
  input: ReadWorkspaceFileInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  rootName: string;
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
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  const requestedPath = input.path;
  const file = await readWorkspaceTextFile({ rootPath: root.path, requestedPath });
  const ranged = sliceContentByLineRange(file.content, input.startLine, input.endLine);
  const maxChars = input.maxChars ?? DEFAULT_FILE_MAX_CHARS;
  const truncated = truncateContent(ranged.content, maxChars);

  return {
    rootName: root.displayName,
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
  /** Present only in detail mode (concise entries are path + type). */
  depth?: number;
  path: string;
  size?: number;
  tokenCount?: number;
  type: 'directory' | 'file';
}

type FsDirent = import('node:fs').Dirent;

interface DirectoryTraversalOptions {
  baseSegments: readonly string[];
  depth: number;
  /** When true, entries include depth and file size (extra stat call per file). */
  detail: boolean;
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
      ...(options.detail ? { depth: context.childDepth } : {}),
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

  if (!options.detail) {
    pushDirectoryEntry(state, { path: context.childPath, type: 'file' });
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

interface ReadWorkspaceDirectoryToolResult {
  count: number;
  entries: DirectoryEntry[];
  /** Actionable next step when the listing was truncated. */
  hint?: string;
  offset: number;
  path: string;
  /** Display name of the folder this listing is from (multi-root). */
  rootName: string;
  /** Entries collected by the traversal (lower bound when truncated). */
  totalEntries: number;
  totalMatchedFiles: number;
  truncated: boolean;
}

async function runReadWorkspaceDirectory(
  input: ReadWorkspaceDirectoryInput,
  runtimeData: RuntimeData | undefined
): Promise<ReadWorkspaceDirectoryToolResult> {
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  const requestedPath = input.path ?? '/';
  const normalizedPath = normalizeWorkspacePath(requestedPath);
  const resolvedBase = await resolveWorkspaceAbsolutePath(root.path, normalizedPath);

  const baseStats = await fsPromises.stat(resolvedBase.absolutePath);
  if (!baseStats.isDirectory()) {
    throw new Error(`Path "${normalizedPath}" is not a directory.`);
  }

  const depth = input.depth ?? DEFAULT_DIRECTORY_DEPTH;
  const maxEntries = input.maxEntries ?? DEFAULT_DIRECTORY_MAX_ENTRIES;
  const includeFiles = input.includeFiles ?? true;
  const includeDirectories = input.includeDirectories ?? true;
  const includeHidden = input.includeHidden ?? false;
  const detail = input.detail ?? false;
  const offset = input.offset ?? 0;

  const options: DirectoryTraversalOptions = {
    baseSegments: normalizedPath === '/' ? [] : toPathSegments(normalizedPath),
    includeHidden,
    includeDirectories,
    includeFiles,
    depth,
    detail,
  };
  const state: DirectoryTraversalState = {
    entries: [],
    // Collect through the requested page so offset paging can skip into it.
    maxEntries: offset + maxEntries,
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

  const pagedEntries = state.entries.slice(offset);
  // The hint is part of the fitted candidate so it can never push the final
  // result back over the budget.
  const { result } = fitItemsToCharBudget(
    pagedEntries,
    (entries): ReadWorkspaceDirectoryToolResult => {
      // Truncated when entries were dropped (traversal cap, paging, or budget fitting).
      const truncated = state.truncated || offset + entries.length < state.entries.length;
      const traversalNote = state.truncated
        ? ' The traversal stopped early, so totals are lower bounds.'
        : '';
      const hint = truncated
        ? `Showing entries ${offset + 1}-${offset + entries.length} of ${state.entries.length}+ under "${normalizedPath}".` +
          `${traversalNote} Continue with offset: ${offset + entries.length}, or list a more specific subdirectory.`
        : undefined;
      return {
        rootName: root.displayName,
        path: normalizedPath,
        entries,
        count: entries.length,
        totalEntries: state.entries.length,
        totalMatchedFiles: state.totalMatchedFiles,
        offset,
        truncated,
        ...(hint ? { hint } : {}),
      };
    }
  );
  return result;
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

interface CuratedContextSummary {
  fileCount: number;
  includeProjectTree?: boolean;
  projectTreeApproxTokens?: number | null;
  rangeCount: number;
  selectedOutputApproxTokens?: number | null;
  selectedSourceApproxTokens?: number | null;
  tokenBudget?: number;
  useTapestryRanges?: boolean;
}

/** Counts and token budgets only — the per-file range metadata stays behind detail: true. */
function summarizeCuratedContext(context: RuntimeWorkspaceContextMetadata): CuratedContextSummary {
  const files = Array.isArray(context.files) ? context.files : [];
  const rangeCount = files.reduce((total, file) => total + (file.ranges?.length ?? 0), 0);
  return {
    fileCount: files.length,
    rangeCount,
    ...(context.tokenBudget === undefined ? {} : { tokenBudget: context.tokenBudget }),
    ...(context.useTapestryRanges === undefined
      ? {}
      : { useTapestryRanges: context.useTapestryRanges }),
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
  selectionFolderId?: string;
  tokenEstimates?: Array<{ path: string; approxTokens: number | null }>;
  truncated: boolean;
  workspaceIndex: WorkspaceIndexSummary;
  /** Primary/focused root path (back-compat); see workspaceRoots for the full set. */
  workspaceRootPath: string;
  /**
   * Every open workspace root (id + display name + path). The model reads these
   * to pass a `root` qualifier to the read/search tools when several are open.
   */
  workspaceRoots: readonly RuntimeWorkspaceRoot[];
}

function runListWorkspaceContext(
  input: ListWorkspaceContextInput,
  runtimeData: RuntimeData | undefined
): ListWorkspaceContextToolResult {
  const workspaceRoots = getWorkspaceRoots(runtimeData);
  if (workspaceRoots.length === 0) {
    throw new Error(
      'No folder is open in the workspace. Add a folder in the left file tree first.'
    );
  }
  // The first root is the primary/focused one (path.resolve matches the legacy
  // resolveWorkspaceRootPath value for the single-root case).
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
      workspaceRootPath,
      workspaceRoots,
      selectedFileCount: selectedFiles.length,
      selectedFiles: files,
      workspaceIndex,
      offset,
      truncated,
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
              path: filePath,
              approxTokens: curatedFilesByPath.get(filePath)?.approxTokens ?? null,
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
      startLine: range.startLine,
      endLine: range.endLine,
      approxTokens: countTokensHeuristic(truncatedRange.content),
      content: truncatedRange.content,
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

type SelectableWorkspaceFileValidation =
  | { selectedFile: string }
  | { skippedFile: WorkspaceContextSkippedPath };

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
  const { requestedCount, selectedFiles, skippedFiles } = await validateSelectableWorkspaceFiles({
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
    requestedCount,
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
        ...(range.color === undefined ? {} : { color: range.color }),
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

async function runListEmbeddingSpaces(
  input: ListEmbeddingSetsInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  count: number;
  workspaceIndex: WorkspaceIndexSummary;
  spaces: AssistantEmbeddingSpaceListing[];
}> {
  const workspaceIndex = normalizeRuntimeWorkspaceIndex(runtimeData);
  const db = await getDatabase();
  const embeddingSetsRepository = new EmbeddingSetsRepository(db);
  const listings = await embeddingSetsRepository.listEmbeddingSpaces({
    includeStats: input.includeStats === true,
  });
  const mappedSpaces = listings.map((listing: EmbeddingSpaceListing) => {
    const isWorkspaceIndex = listing.id === workspaceIndex.embeddingSetId;
    const space = {
      id: listing.id,
      name: listing.name,
      description: listing.description,
      modelKey: listing.modelKey,
      modelId: listing.modelId,
      dimensions: listing.dimensions,
      distance: listing.distance,
      createdAt: listing.createdAt,
      isWorkspaceIndex,
      recommendedForWorkspaceSearch: isWorkspaceIndex,
    };
    if (input.includeStats !== true || !listing.stats) {
      return space;
    }
    const {
      embeddedChunks,
      fileCount,
      tokenizedChunkCount,
      totalChunks,
      totalTokens,
      averageTokensPerChunk,
    } = listing.stats;
    return {
      ...space,
      coverage: {
        embeddedChunks,
        fileCount,
        tokenizedChunkCount,
        totalChunks,
        totalTokens,
        averageTokensPerChunk,
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
  const raw = resolveToolExecuteInputCandidate(
    QueryEmbeddingSpaceInputSchema,
    input
  ) as Partial<QueryEmbeddingSpaceInput>;
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
    [FIND_WORKSPACE_SYMBOL_TOOL_ID]: {
      id: FIND_WORKSPACE_SYMBOL_TOOL_ID,
      description:
        "Find a symbol's best-effort enclosing 1-based line range in a workspace file without returning whole-file content. Matching is substring-based, so verify the returned range. Use this to get a function/type/section range, then pass it to brainstrike.updateWorkspaceTapestrySelections.",
      inputSchema: FindWorkspaceSymbolInputSchema,
      execute: async (input: ToolExecuteInput<FindWorkspaceSymbolInput>) => {
        const resolvedInput = parseToolExecuteInput(FindWorkspaceSymbolInputSchema, input);
        try {
          return await runFindWorkspaceSymbol(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('findWorkspaceSymbol failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
    [GREP_SEARCH_TOOL_ID]: {
      id: GREP_SEARCH_TOOL_ID,
      description:
        "Grep indexed file content for an exact string (default) or JavaScript regex. Use this FIRST for identifiers, exact strings, and error messages. Default outputMode 'files' cheaply surveys WHICH files match; then call again with outputMode 'content' and filePaths to see the matching lines. Results are truncated to a fixed budget — follow the returned hint (offset, filters) to continue.",
      inputSchema: GrepSearchInputSchema,
      execute: async (input: ToolExecuteInput<GrepSearchInput>) => {
        const resolvedInput = parseToolExecuteInput(GrepSearchInputSchema, input);
        try {
          return await runGrepSearch(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('grepSearch failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
    [READ_WORKSPACE_FILE_TOOL_ID]: {
      id: READ_WORKSPACE_FILE_TOOL_ID,
      description:
        'Read a workspace file from the selected root. Use line ranges and maxChars to keep context efficient.',
      inputSchema: ReadWorkspaceFileInputSchema,
      execute: async (input: ToolExecuteInput<ReadWorkspaceFileInput>) => {
        const resolvedInput = parseToolExecuteInput(ReadWorkspaceFileInputSchema, input);
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
        'List workspace directory entries (path + type by default; detail: true adds sizes). Prefer specific subdirectories over the root. Truncated listings include a hint with the offset to continue from.',
      inputSchema: ReadWorkspaceDirectoryInputSchema,
      execute: async (input: ToolExecuteInput<ReadWorkspaceDirectoryInput>) => {
        const resolvedInput = parseToolExecuteInput(ReadWorkspaceDirectoryInputSchema, input);
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
        'Inspect the current workspace root, selected context paths, token budgets, and workspace index hint without returning file contents. Compact summary by default; set detail: true for per-file Tapestry ranges. Use before reading selected context.',
      inputSchema: ListWorkspaceContextInputSchema,
      execute: async (input: ToolExecuteInput<ListWorkspaceContextInput>) => {
        const resolvedInput = parseToolExecuteInput(ListWorkspaceContextInputSchema, input);
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
        const resolvedInput = parseToolExecuteInput(ReadWorkspaceContextInputSchema, input);
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
        const resolvedInput = parseToolExecuteInput(
          UpdateWorkspaceContextSelectionInputSchema,
          input
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
        const resolvedInput = parseToolExecuteInput(
          UpdateWorkspaceTapestrySelectionsInputSchema,
          input
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
        'List available embedding spaces, identify the configured Workspace Index, and optionally include coverage stats. Use this when you need to inspect non-default embedding spaces or index coverage.',
      inputSchema: ListEmbeddingSetsInputSchema,
      execute: async (input: ToolExecuteInput<ListEmbeddingSetsInput>) => {
        const resolvedInput = parseToolExecuteInput(ListEmbeddingSetsInputSchema, input);
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
        'Query semantic workspace context and return bounded source text plus metadata-only chunks with persisted line ranges. For workspace/codebase searches, omit embeddingSetId to use the Workspace Index. Provide embeddingSetId only for a specific non-default embedding space; use tokenBudget, limit, threshold, and optional filePaths to keep retrieval bounded.',
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
  if (enabledSet.size === 0) {
    logger.warn('Runtime preferences disabled all desktop assistant native tools', {
      availableCount: Object.keys(tools).length,
    });
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
