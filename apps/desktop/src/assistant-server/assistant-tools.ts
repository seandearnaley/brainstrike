import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { countTokensHeuristic, createLogger } from '@brainstrike/utils';
import { BrowserWindow } from 'electron';
import { z } from 'zod';

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

interface ReadWorkspaceFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
  maxChars?: number;
}

interface ReadWorkspaceDirectoryInput {
  path?: string;
  depth?: number;
  maxEntries?: number;
  includeFiles?: boolean;
  includeDirectories?: boolean;
  includeHidden?: boolean;
}

interface BatchSelectWorkspaceFilesInput {
  filePaths: string[];
  mode?: 'replace' | 'add' | 'remove';
  selectionTarget?: 'leftRootFileTree' | 'contextExplorer' | 'both';
  selectionScope?: 'rootFileTree' | 'contextExplorer' | 'both';
  targetSurface?: 'rootFileTree' | 'contextExplorer' | 'both' | 'bothPanels';
  folderId?: string;
}

const logger = createLogger('DesktopAssistantTools');
const ASSISTANT_BATCH_SELECT_EVENT = 'assistant:batch-select-files';

const READ_WORKSPACE_FILE_TOOL_ID = 'brainstrike.readWorkspaceFile' as const;
const READ_WORKSPACE_DIRECTORY_TOOL_ID = 'brainstrike.readWorkspaceDirectory' as const;
const BATCH_SELECT_WORKSPACE_FILES_TOOL_ID = 'brainstrike.batchSelectWorkspaceFiles' as const;

const DEFAULT_FILE_MAX_CHARS = 12_000;
const DEFAULT_DIRECTORY_MAX_ENTRIES = 150;
const DEFAULT_DIRECTORY_DEPTH = 1;

const ReadWorkspaceFileToolInputSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().max(50_000).optional(),
  })
  .strict();

const ReadWorkspaceDirectoryToolInputSchema = z
  .object({
    path: z.string().optional(),
    depth: z.number().int().min(0).max(5).optional(),
    maxEntries: z.number().int().positive().max(500).optional(),
    includeFiles: z.boolean().optional(),
    includeDirectories: z.boolean().optional(),
    includeHidden: z.boolean().optional(),
  })
  .strict();

const BatchSelectWorkspaceFilesToolInputSchema = z
  .object({
    filePaths: z.array(z.string().min(1)).min(1).max(5000),
    mode: z.enum(['replace', 'add', 'remove']).optional(),
    selectionTarget: z.enum(['leftRootFileTree', 'contextExplorer', 'both']).optional(),
    selectionScope: z.enum(['rootFileTree', 'contextExplorer', 'both']).optional(),
    targetSurface: z.enum(['rootFileTree', 'contextExplorer', 'both', 'bothPanels']).optional(),
    folderId: z.string().min(1).optional(),
  })
  .strict();

type ToolExecuteInput<T> = { context: T } | T;

function resolveToolExecuteInput<T>(input: ToolExecuteInput<T>): T {
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
  for (const path of paths) {
    const normalized = normalizeWorkspacePath(path);
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

function resolveWorkspaceAbsolutePath(
  rootPath: string,
  workspacePath: string
): { workspacePath: string; absolutePath: string } {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  const relativePath =
    normalizedWorkspacePath === '/' ? '' : normalizedWorkspacePath.replace(/^\/+/, '');
  const absolutePath = path.resolve(rootPath, relativePath);
  const relativeFromRoot = path.relative(rootPath, absolutePath);
  if (
    relativeFromRoot.startsWith('..') ||
    relativeFromRoot.includes(`${path.sep}..${path.sep}`) ||
    relativeFromRoot === '..'
  ) {
    throw new Error(`Path "${workspacePath}" is outside the selected workspace root.`);
  }
  return {
    workspacePath: normalizedWorkspacePath,
    absolutePath,
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
  const requestedPath = typeof input.path === 'string' ? input.path : '';
  const resolved = resolveWorkspaceAbsolutePath(rootPath, requestedPath);

  const stat = await fsPromises.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Path "${requestedPath}" is not a file.`);
  }

  const content = await fsPromises.readFile(resolved.absolutePath, 'utf8');
  const ranged = sliceContentByLineRange(content, input.startLine, input.endLine);
  const maxChars = input.maxChars ?? DEFAULT_FILE_MAX_CHARS;
  const truncated = truncateContent(ranged.content, maxChars);

  return {
    path: resolved.workspacePath,
    size: Number(stat.size),
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
  path: string;
  type: 'directory' | 'file';
  depth: number;
  size?: number;
  tokenCount?: number;
}

function toPathSegments(path: string): string[] {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
}

function joinSegments(baseSegments: readonly string[], childSegments: readonly string[]): string {
  const merged = [...baseSegments, ...childSegments].filter((segment) => segment.length > 0);
  return `/${merged.join('/')}`;
}

function isHiddenPath(path: string): boolean {
  return toPathSegments(path).some((segment) => segment.startsWith('.'));
}

type FsDirent = import('node:fs').Dirent;

interface DirectoryTraversalOptions {
  baseSegments: readonly string[];
  includeHidden: boolean;
  includeDirectories: boolean;
  includeFiles: boolean;
  depth: number;
}

interface DirectoryTraversalState {
  entries: DirectoryEntry[];
  maxEntries: number;
  truncated: boolean;
  totalMatchedFiles: number;
}

interface DirectoryVisitContext {
  childAbsolutePath: string;
  childSegments: string[];
  childPath: string;
  childDepth: number;
}

function sortDirectoryEntries(entries: FsDirent[]): FsDirent[] {
  return entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
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
  if (!(options.includeHidden || !isHiddenPath(childPath))) {
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
  const requestedPath = typeof input.path === 'string' ? input.path : '/';
  const normalizedPath = normalizeWorkspacePath(requestedPath);
  const resolvedBase = resolveWorkspaceAbsolutePath(rootPath, normalizedPath);

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

function broadcastBatchSelection(payload: {
  folderId: string;
  filePaths: string[];
  mode: 'replace' | 'add' | 'remove';
  selectionTarget: 'leftRootFileTree' | 'contextExplorer' | 'both';
  selectionScope: 'rootFileTree' | 'contextExplorer' | 'both';
}): number {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  for (const win of windows) {
    win.webContents.send(ASSISTANT_BATCH_SELECT_EVENT, payload);
  }
  return windows.length;
}

function resolveBatchFolderId(
  input: BatchSelectWorkspaceFilesInput,
  runtimeData?: RuntimeData
): string {
  const folderId =
    typeof input.folderId === 'string' ? input.folderId : runtimeData?.selectionFolderId;
  if (!(typeof folderId === 'string' && folderId.trim().length > 0)) {
    throw new Error('No folder context available. Provide folderId when selecting files.');
  }
  return folderId;
}

function runBatchSelectWorkspaceFiles(
  input: BatchSelectWorkspaceFilesInput,
  runtimeData: RuntimeData | undefined
): {
  folderId: string;
  mode: 'replace' | 'add' | 'remove';
  selectionTarget: 'leftRootFileTree' | 'contextExplorer' | 'both';
  requestedCount: number;
  appliedCount: number;
  windowsNotified: number;
} {
  const folderId = resolveBatchFolderId(input, runtimeData);
  const filePaths = normalizeWorkspacePaths(input.filePaths);
  if (filePaths.length === 0) {
    throw new Error('No valid file paths were provided for batch selection.');
  }

  const mode = input.mode ?? 'replace';
  const resolvedLegacyScope =
    input.targetSurface === 'bothPanels'
      ? 'both'
      : input.targetSurface === 'rootFileTree'
        ? 'leftRootFileTree'
        : input.targetSurface;
  const resolvedSelectionScope =
    input.selectionScope === 'rootFileTree' ? 'leftRootFileTree' : input.selectionScope;
  const selectionTarget =
    input.selectionTarget ?? resolvedSelectionScope ?? resolvedLegacyScope ?? 'both';
  const legacySelectionScope: 'rootFileTree' | 'contextExplorer' | 'both' =
    selectionTarget === 'leftRootFileTree' ? 'rootFileTree' : selectionTarget;
  const windowsNotified = broadcastBatchSelection({
    folderId,
    filePaths,
    mode,
    selectionTarget,
    selectionScope: legacySelectionScope,
  });

  return {
    folderId,
    mode,
    selectionTarget,
    requestedCount: input.filePaths.length,
    appliedCount: filePaths.length,
    windowsNotified,
  };
}

/**
 * Builds the Mastra ToolsInput for the desktop assistant server.
 */
export function buildDesktopAssistantTools(runtimeData: RuntimeData | undefined): MastraTools {
  return {
    [READ_WORKSPACE_FILE_TOOL_ID]: {
      id: READ_WORKSPACE_FILE_TOOL_ID,
      description:
        'Read a workspace file from the selected root. Use line ranges and maxChars to keep context efficient.',
      inputSchema: ReadWorkspaceFileToolInputSchema,
      execute: async (input: ToolExecuteInput<ReadWorkspaceFileInput>) => {
        const resolvedInput = resolveToolExecuteInput(input);
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
      inputSchema: ReadWorkspaceDirectoryToolInputSchema,
      execute: async (input: ToolExecuteInput<ReadWorkspaceDirectoryInput>) => {
        const resolvedInput = resolveToolExecuteInput(input);
        try {
          return await runReadWorkspaceDirectory(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('readWorkspaceDirectory failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
    [BATCH_SELECT_WORKSPACE_FILES_TOOL_ID]: {
      id: BATCH_SELECT_WORKSPACE_FILES_TOOL_ID,
      description:
        'Batch update selected files so they appear in both the left root file tree and context explorer.',
      inputSchema: BatchSelectWorkspaceFilesToolInputSchema,
      execute: async (input: ToolExecuteInput<BatchSelectWorkspaceFilesInput>) => {
        const resolvedInput = resolveToolExecuteInput(input);
        try {
          return runBatchSelectWorkspaceFiles(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('batchSelectWorkspaceFiles failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
  };
}
