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
} from '@brainstrike/agent';
import { countTokensHeuristic } from '@brainstrike/text-splitter';
import { defaultCollator } from '@brainstrike/utils/collator';
import { createLogger } from '@brainstrike/utils/logger';
import { getDatabase } from '../db-main';
import { runQueryEmbeddingSpace } from './retrieval-tool';

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

const logger = createLogger('DesktopAssistantTools');

const READ_WORKSPACE_FILE_TOOL_ID = 'brainstrike.readWorkspaceFile' as const;
const READ_WORKSPACE_DIRECTORY_TOOL_ID = 'brainstrike.readWorkspaceDirectory' as const;
const LIST_WORKSPACE_CONTEXT_TOOL_ID = 'brainstrike.listWorkspaceContext' as const;
const READ_WORKSPACE_CONTEXT_TOOL_ID = 'brainstrike.readWorkspaceContext' as const;
const LIST_EMBEDDING_SPACES_TOOL_ID = 'brainstrike.listEmbeddingSpaces' as const;
const QUERY_EMBEDDING_SPACE_TOOL_ID = 'brainstrike.queryEmbeddingSpace' as const;

const DEFAULT_FILE_MAX_CHARS = 12_000;
const MAX_READ_WORKSPACE_FILE_BYTES = 2_000_000;
const DEFAULT_DIRECTORY_MAX_ENTRIES = 150;
const DEFAULT_DIRECTORY_DEPTH = 1;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;
const DEFAULT_CONTEXT_MAX_FILES = 20;
const DEFAULT_CONTEXT_MAX_CHARS_PER_FILE = 12_000;

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

function normalizeRuntimeSelectionFilePaths(runtimeData: RuntimeData | undefined): string[] {
  return normalizeWorkspacePaths(Array.from(runtimeData?.selectionFilePaths ?? []));
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
  workspaceRootPath: string;
  selectionFolderId?: string;
  selectedFileCount: number;
  selectedFiles: string[];
  tokenEstimates?: Array<{ path: string; approxTokens: number | null }>;
  workspaceIndex: WorkspaceIndexSummary;
} {
  const workspaceRootPath = resolveWorkspaceRootPath(runtimeData);
  const selectedFiles = normalizeRuntimeSelectionFilePaths(runtimeData);
  const result: {
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
  if (typeof runtimeData?.selectionFolderId === 'string') {
    result.selectionFolderId = runtimeData.selectionFolderId;
  }
  if (input.includeTokenEstimates === true) {
    result.tokenEstimates = selectedFiles.map((filePath) => ({
      path: filePath,
      approxTokens: null,
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
  const files: WorkspaceContextFileResult[] = [];
  const skippedFiles: WorkspaceContextSkippedFile[] = [];
  let totalApproxTokens = 0;

  for (const requestedPath of requestedPaths) {
    if (files.length >= maxFiles) {
      skippedFiles.push({ path: requestedPath, reason: 'maxFiles' });
      continue;
    }

    try {
      const file = await runReadWorkspaceFile(
        {
          path: requestedPath,
          maxChars: maxCharsPerFile,
        },
        { workspaceRootPath }
      );
      const approxTokens = file.approxOutputTokens;
      if (totalApproxTokens + approxTokens > tokenBudget) {
        skippedFiles.push({
          path: file.path,
          reason: 'tokenBudget',
          message: `Including this file would exceed the ${tokenBudget} token budget.`,
        });
        continue;
      }
      totalApproxTokens += approxTokens;
      files.push({
        path: file.path,
        size: file.size,
        startLine: file.startLine,
        endLine: file.endLine,
        totalLines: file.totalLines,
        truncated: file.truncated,
        omittedChars: file.omittedChars,
        approxTokens,
        content: file.content,
      });
    } catch (error) {
      skippedFiles.push(classifyReadContextError(requestedPath, error));
    }
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
        'Read selected or explicit workspace files under maxFiles, per-file, and token budgets. Use after semantic search when you need exact source lines. Skipped and truncated files are reported explicitly.',
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
        'Query a specific embedding space by explicit embeddingSetId. For workspace/codebase searches, use listEmbeddingSpaces first and prefer its recommended workspace index. Provide tokenBudget, limit, threshold, and optional filePaths to keep retrieval bounded.',
      inputSchema: QueryEmbeddingSpaceInputSchema,
      execute: async (input: ToolExecuteInput<QueryEmbeddingSpaceInput>) => {
        const resolvedInput = resolveQueryEmbeddingSpaceInput(input);
        try {
          return await runQueryEmbeddingSpace(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('queryEmbeddingSpace failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
  };
}
