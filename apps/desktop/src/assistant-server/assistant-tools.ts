import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  type ReadWorkspaceDirectoryInput,
  ReadWorkspaceDirectoryInputSchema,
  type ReadWorkspaceFileInput,
  ReadWorkspaceFileInputSchema,
  type RuntimeData,
  type SelectRootTreeFilesInput,
  SelectRootTreeFilesInputSchema,
  type UpdatePreviewContextFilesInput,
  UpdatePreviewContextFilesInputSchema,
} from '@brainstrike/agent';
import { countTokensHeuristic } from '@brainstrike/text-splitter';
import { defaultCollator } from '@brainstrike/utils/collator';
import { createLogger } from '@brainstrike/utils/logger';
import { BrowserWindow } from 'electron';

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

type WorkspaceSelectionMode = 'replace' | 'add' | 'remove';

const logger = createLogger('DesktopAssistantTools');
const ASSISTANT_ROOT_TREE_SELECTION_EVENT = 'assistant:root-tree-selection-update';
const ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT = 'assistant:preview-context-selection-update';

const READ_WORKSPACE_FILE_TOOL_ID = 'brainstrike.readWorkspaceFile' as const;
const READ_WORKSPACE_DIRECTORY_TOOL_ID = 'brainstrike.readWorkspaceDirectory' as const;
const SELECT_ROOT_TREE_FILES_TOOL_ID = 'brainstrike.selectRootTreeFiles' as const;
const UPDATE_PREVIEW_CONTEXT_FILES_TOOL_ID = 'brainstrike.updatePreviewContextFiles' as const;

const DEFAULT_FILE_MAX_CHARS = 12_000;
const MAX_READ_WORKSPACE_FILE_BYTES = 2_000_000;
const DEFAULT_DIRECTORY_MAX_ENTRIES = 150;
const DEFAULT_DIRECTORY_DEPTH = 1;

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
  const resolved = await resolveWorkspaceAbsolutePath(rootPath, requestedPath);

  const stat = await fsPromises.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Path "${requestedPath}" is not a file.`);
  }
  if (stat.size > MAX_READ_WORKSPACE_FILE_BYTES) {
    throw new Error(
      `Path "${requestedPath}" exceeds ${MAX_READ_WORKSPACE_FILE_BYTES} bytes and cannot be read in full.`
    );
  }

  const fileBuffer = await fsPromises.readFile(resolved.absolutePath);
  const binaryProbeLength = Math.min(fileBuffer.length, 4096);
  for (let index = 0; index < binaryProbeLength; index += 1) {
    if (fileBuffer[index] === 0) {
      throw new Error(`Path "${requestedPath}" is a binary file and cannot be read as text.`);
    }
  }

  const content = fileBuffer.toString('utf8');
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

function broadcastSelectionUpdate(
  eventName: string,
  payload: {
    folderId: string;
    filePaths: string[];
    mode: WorkspaceSelectionMode;
  }
): number {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  for (const win of windows) {
    win.webContents.send(eventName, payload);
  }
  return windows.length;
}

function resolveBatchFolderId(
  input: SelectRootTreeFilesInput | UpdatePreviewContextFilesInput,
  runtimeData?: RuntimeData
): string {
  const folderId =
    typeof input.folderId === 'string' ? input.folderId : runtimeData?.selectionFolderId;
  if (!(typeof folderId === 'string' && folderId.trim().length > 0)) {
    throw new Error('No folder context available. Provide folderId when selecting files.');
  }
  return folderId;
}

function runSelectRootTreeFiles(
  input: SelectRootTreeFilesInput,
  runtimeData: RuntimeData | undefined
): {
  folderId: string;
  selectionSet: 'rootTree';
  mode: WorkspaceSelectionMode;
  requestedCount: number;
  appliedCount: number;
  windowsNotified: number;
} {
  const folderId = resolveBatchFolderId(input, runtimeData);
  const filePaths = normalizeWorkspacePaths(input.filePaths);
  if (filePaths.length === 0) {
    throw new Error('No valid file paths were provided for root tree selection.');
  }

  const mode = input.mode ?? 'add';
  const windowsNotified = broadcastSelectionUpdate(ASSISTANT_ROOT_TREE_SELECTION_EVENT, {
    folderId,
    filePaths,
    mode,
  });

  return {
    folderId,
    selectionSet: 'rootTree',
    mode,
    requestedCount: input.filePaths.length,
    appliedCount: filePaths.length,
    windowsNotified,
  };
}

function runUpdatePreviewContextFiles(
  input: UpdatePreviewContextFilesInput,
  runtimeData: RuntimeData | undefined
): {
  folderId: string;
  selectionSet: 'previewContext';
  mode: WorkspaceSelectionMode;
  requestedCount: number;
  appliedCount: number;
  windowsNotified: number;
} {
  const folderId = resolveBatchFolderId(input, runtimeData);
  const filePaths = normalizeWorkspacePaths(input.filePaths);
  if (filePaths.length === 0) {
    throw new Error('No valid file paths were provided for preview context selection.');
  }

  const mode = input.mode ?? 'add';
  const windowsNotified = broadcastSelectionUpdate(ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT, {
    folderId,
    filePaths,
    mode,
  });

  return {
    folderId,
    selectionSet: 'previewContext',
    mode,
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
    [SELECT_ROOT_TREE_FILES_TOOL_ID]: {
      id: SELECT_ROOT_TREE_FILES_TOOL_ID,
      description:
        'Select files from the left root tree so they populate the preview/context panel candidate set.',
      inputSchema: SelectRootTreeFilesInputSchema,
      execute: async (input: ToolExecuteInput<SelectRootTreeFilesInput>) => {
        const resolvedInput = SelectRootTreeFilesInputSchema.parse(resolveToolExecuteInput(input));
        try {
          return runSelectRootTreeFiles(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('selectRootTreeFiles failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
    [UPDATE_PREVIEW_CONTEXT_FILES_TOOL_ID]: {
      id: UPDATE_PREVIEW_CONTEXT_FILES_TOOL_ID,
      description:
        'Add, remove, or replace files in the preview/context selection used as agent context.',
      inputSchema: UpdatePreviewContextFilesInputSchema,
      execute: async (input: ToolExecuteInput<UpdatePreviewContextFilesInput>) => {
        const resolvedInput = UpdatePreviewContextFilesInputSchema.parse(
          resolveToolExecuteInput(input)
        );
        try {
          return runUpdatePreviewContextFiles(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('updatePreviewContextFiles failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
  };
}
