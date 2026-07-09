import { constants as fsConstants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  applyStringReplace,
  type DeleteWorkspaceFileInput,
  DeleteWorkspaceFileInputSchema,
  type ExecuteCommandInput,
  ExecuteCommandInputSchema,
  type FindWorkspaceSymbolInput,
  FindWorkspaceSymbolInputSchema,
  fitItemsToCharBudget,
  type GlobWorkspaceInput,
  GlobWorkspaceInputSchema,
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
  type RenameWorkspaceFileInput,
  RenameWorkspaceFileInputSchema,
  type RuntimeData,
  type RuntimeWorkspaceContextFileMetadata,
  type RuntimeWorkspaceContextMetadata,
  type RuntimeWorkspaceContextRangeMetadata,
  type RuntimeWorkspaceRoot,
  type StringReplaceMatchType,
  type StringReplaceWorkspaceFileInput,
  StringReplaceWorkspaceFileInputSchema,
  type UpdateWorkspaceContextSelectionInput,
  UpdateWorkspaceContextSelectionInputSchema,
  type UpdateWorkspaceTapestrySelectionsInput,
  UpdateWorkspaceTapestrySelectionsInputSchema,
  type WebSearchInput,
  WebSearchInputSchema,
  type WriteWorkspaceFileInput,
  WriteWorkspaceFileInputSchema,
  withFileLock,
} from '@brainstrike/agent';
import {
  EmbeddingSetsRepository,
  type EmbeddingSpaceListing,
  type EmbeddingSpaceStats,
  invalidateManagedCacheEntriesByIdentity,
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
import { EXECUTE_COMMAND_TOOL_ID, runExecuteCommand } from './execute-command-tool';
import { findSymbolMatches } from './find-workspace-symbol';
import { GLOB_WORKSPACE_TOOL_ID, runGlobWorkspace } from './glob-workspace-tool';
import { GREP_SEARCH_TOOL_ID, runGrepSearch } from './grep-search-tool';
import { type ReindexDatabaseHandle, reindexEditedFile, statMtimeMs } from './reindex-edited-file';
import { runQueryEmbeddingSpace } from './retrieval-tool';
import {
  runWebSearch,
  WEB_SEARCH_TOOL_ID,
  type WebSearchToolDependencies,
} from './web-search-tool';
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
  /**
   * Optional override for the webSearch tool's network/key resolution. Used by
   * tests to inject a stubbed Tavily fetch and key resolver so the loop runs
   * hermetically. In production this is omitted and runWebSearch resolves the
   * real keychain key and uses the real fetch.
   */
  webSearch?: WebSearchToolDependencies | undefined;
}

const logger = createLogger('DesktopAssistantTools');

const FIND_WORKSPACE_SYMBOL_TOOL_ID = 'brainstrike.findWorkspaceSymbol' as const;
const READ_WORKSPACE_FILE_TOOL_ID = 'brainstrike.readWorkspaceFile' as const;
const WRITE_WORKSPACE_FILE_TOOL_ID = 'brainstrike.writeWorkspaceFile' as const;
const STRING_REPLACE_WORKSPACE_FILE_TOOL_ID = 'brainstrike.stringReplaceWorkspaceFile' as const;
const DELETE_WORKSPACE_FILE_TOOL_ID = 'brainstrike.deleteWorkspaceFile' as const;
const RENAME_WORKSPACE_FILE_TOOL_ID = 'brainstrike.renameWorkspaceFile' as const;
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
const MAX_WRITE_WORKSPACE_FILE_BYTES = 2_000_000;
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

function redactToolInputForLog(input: object): { fields: string[]; redacted: true } {
  return { fields: Object.keys(input), redacted: true };
}

const REDACTED_PATH_LOG_VALUE = { redacted: true } as const;

function redactToolErrorForLog(error: unknown): {
  code?: string | number;
  name: string;
  redacted: true;
} {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return {
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    name: error instanceof Error && error.name.length > 0 ? error.name : typeof error,
    redacted: true,
  };
}

function logToolFailure(message: string, error: unknown, input: object): void {
  logger.error(message, {
    error: redactToolErrorForLog(error),
    input: redactToolInputForLog(input),
  });
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
    absolutePath: canonicalAbsolutePath,
    workspacePath: normalizedWorkspacePath,
  };
}

/**
 * Find the canonical (symlink-resolved) path of the nearest existing ancestor of
 * `absolutePath`. The target file may not exist yet (the common write case), so
 * `fs.realpath` on it would throw ENOENT. We walk up until a directory exists,
 * `realpath` THAT, then re-append the not-yet-created tail. This canonicalizes
 * every existing symlink on the path so a symlinked parent that points outside
 * the root is still caught by the containment check below.
 */
async function resolveCanonicalWritablePath(absolutePath: string): Promise<string> {
  const segments: string[] = [];
  let current = absolutePath;
  // Walk up to the nearest existing ancestor. `path.dirname` is a fixpoint at the
  // filesystem root, so the loop always terminates.
  for (;;) {
    try {
      const canonicalExisting = await fsPromises.realpath(current);
      return segments.length > 0
        ? path.join(canonicalExisting, ...segments.reverse())
        : canonicalExisting;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor; return
        // the path unchanged (containment is still checked by the caller).
        return absolutePath;
      }
      segments.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a virtual workspace path to a containment-checked absolute path for a
 * WRITE, where the target file (and possibly some parent directories) may not yet
 * exist. Mirrors {@link resolveWorkspaceAbsolutePath}'s guarantees: ".." is
 * clamped in `normalizeWorkspacePath`, and the canonical existing-ancestor path
 * is containment-checked against the canonical root so a symlinked directory
 * cannot redirect the write outside the workspace.
 */
async function resolveWorkspaceWritePath(
  rootPath: string,
  workspacePath: string
): Promise<{ canonicalRootPath: string; workspacePath: string; absolutePath: string }> {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  const relativePath =
    normalizedWorkspacePath === '/' ? '' : normalizedWorkspacePath.replace(/^\/+/, '');
  if (relativePath.length === 0) {
    throw new Error(`Path "${workspacePath}" is the workspace root, not a writable file.`);
  }
  const absolutePath = path.resolve(rootPath, relativePath);
  const canonicalRootPath = await fsPromises.realpath(rootPath);
  const canonicalAbsolutePath = await resolveCanonicalWritablePath(absolutePath);
  if (!isWithinRoot(canonicalRootPath, canonicalAbsolutePath)) {
    throw new Error(`Path "${workspacePath}" is outside the selected workspace root.`);
  }
  return {
    absolutePath: canonicalAbsolutePath,
    canonicalRootPath,
    workspacePath: normalizedWorkspacePath,
  };
}

/**
 * Create every missing directory between `canonicalRootPath` (which must already
 * exist) and `targetDir`, ONE component at a time, rejecting any existing
 * component that is a symlink. A plain `mkdir -p` would happily traverse a
 * symlinked intermediate directory (including a dangling one, by creating its
 * target), which is a containment-escape vector. Walking component-by-component
 * with an `lstat` guard keeps every created/traversed segment a real directory
 * inside the root.
 */
async function ensureContainedDirectory(
  canonicalRootPath: string,
  targetDir: string
): Promise<void> {
  if (targetDir === canonicalRootPath) {
    return;
  }
  const relative = path.relative(canonicalRootPath, targetDir);
  // Defence in depth: resolveWorkspaceWritePath already guarantees containment.
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${targetDir}" is outside the selected workspace root.`);
  }
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  let current = canonicalRootPath;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats: import('node:fs').Stats | undefined;
    try {
      stats = await fsPromises.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (stats) {
      // An existing component that is a symlink (live OR dangling) could redirect
      // the write outside the root — reject it rather than traverse it.
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Path component "${current}" is a symlink, which is outside the selected workspace root.`
        );
      }
      if (!stats.isDirectory()) {
        throw new Error(`Path component "${current}" is not a directory.`);
      }
      continue;
    }
    // Component does not exist: mkdir creates a REAL directory (it never follows
    // into a symlink it did not create).
    await fsPromises.mkdir(current);
  }
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
  return { content: sliced, endLine: resolvedEnd, startLine: resolvedStart, totalLines };
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

export async function readWorkspaceTextFile(args: {
  requestedPath: string;
  rootPath: string;
}): Promise<{
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
    content: fileBuffer.toString('utf8'),
    path: resolved.workspacePath,
    size: Number(stat.size),
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
  const file = await readWorkspaceTextFile({ requestedPath: input.path, rootPath: root.path });
  const { matches, totalMatches, truncated } = findSymbolMatches(file.content, input.query, {
    contextLines: input.contextLines ?? 2,
    maxMatches: input.maxMatches ?? 5,
  });
  return { matches, path: file.path, rootName: root.displayName, totalMatches, truncated };
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
  const file = await readWorkspaceTextFile({ requestedPath, rootPath: root.path });
  const ranged = sliceContentByLineRange(file.content, input.startLine, input.endLine);
  const maxChars = input.maxChars ?? DEFAULT_FILE_MAX_CHARS;
  const truncated = truncateContent(ranged.content, maxChars);

  return {
    approxOutputTokens: countTokensHeuristic(truncated.content),
    content: truncated.content,
    endLine: ranged.endLine,
    omittedChars: truncated.omittedChars,
    path: file.path,
    rootName: root.displayName,
    size: file.size,
    startLine: ranged.startLine,
    tokenCount: null,
    totalLines: ranged.totalLines,
    truncated: truncated.truncated,
  };
}

/**
 * Symlink-safe, containment-checked write of `buffer` to the already-resolved
 * workspace write path. This is the SINGLE audited write path shared by
 * `writeWorkspaceFile` and `stringReplaceWorkspaceFile` — do not fork a weaker
 * copy. It enforces every PR-2.1 guarantee:
 *  - leaf lstat rejects a symlink leaf (live OR dangling) and a directory target,
 *  - parents are created one component at a time, rejecting symlinked intermediates,
 *  - the final open uses O_NOFOLLOW to close the lstat→open TOCTOU window.
 *
 * Caller must have resolved the path through {@link resolveWorkspaceWritePath}
 * (so ".." is clamped and the canonical existing-ancestor is contained) and must
 * pass `requestedPath` only for error messages. Returns whether the file was
 * newly created.
 */
async function writeContainedFileBytes(args: {
  resolved: { absolutePath: string; canonicalRootPath: string };
  buffer: Buffer;
  requestedPath: string;
}): Promise<{ created: boolean }> {
  const { resolved, buffer, requestedPath } = args;

  // Inspect the leaf WITHOUT following symlinks. A symlink leaf (live OR
  // dangling) passes the canonical-ancestor containment check yet writeFile would
  // follow it OUTSIDE the root — reject it as a containment escape. lstat also
  // distinguishes a directory target, which cannot be overwritten with content.
  let created = true;
  try {
    const leafStats = await fsPromises.lstat(resolved.absolutePath);
    if (leafStats.isSymbolicLink()) {
      throw new Error(`Path "${requestedPath}" is outside the selected workspace root.`);
    }
    if (leafStats.isDirectory()) {
      throw new Error(
        `Path "${requestedPath}" is a directory and cannot be overwritten with a file.`
      );
    }
    created = false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  // Create missing parents one component at a time, rejecting symlinked
  // intermediates (a plain mkdir -p would traverse them).
  await ensureContainedDirectory(resolved.canonicalRootPath, path.dirname(resolved.absolutePath));

  // O_NOFOLLOW closes the lstat→open TOCTOU window: if the leaf is (or becomes) a
  // symlink, the open syscall itself fails with ELOOP rather than following it.
  // (Falls back to 0 on platforms without O_NOFOLLOW, e.g. Windows; the lstat
  // guard above is the portable backstop.)
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const writeFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow;
  const fileHandle = await fsPromises.open(resolved.absolutePath, writeFlags);
  try {
    await fileHandle.writeFile(buffer);
  } finally {
    await fileHandle.close();
  }
  return { created };
}

/**
 * Convert the normalized (leading-slash, forward-slash) workspace path the write
 * tools produce into the root-relative form stored in `file_records.path`
 * (no leading slash). Both edit tools share this so the re-index lookup keys the
 * same way the importer wrote the row.
 */
function toFileRecordRelativePath(workspacePath: string): string {
  return workspacePath.replace(/^\/+/, '');
}

/**
 * Post-write hook (PR-2.3): keep the RAG index coherent after the agent edits a
 * file. The file is ALREADY written when this runs, so it runs AFTER the write
 * and is non-fatal — a re-index failure is LOGGED but never propagated, because
 * the edit already succeeded and the model is owed its write result regardless.
 *
 * It reuses the SAME entry point the background indexer uses for a changed file
 * (`applyManagedCacheBatch` in replace mode via {@link reindexEditedFile}):
 * stale chunks are cleared, in-flight embed jobs canceled, the row marked
 * un-chunked, and indexing stats refreshed. When the path is not part of the
 * Workspace Index (no embedding set, or no file_records row), it no-ops.
 *
 * Two failure tiers, both non-fatal (the edit already succeeded):
 *  - DB UNAVAILABLE (getDatabase() throws — e.g. no DB initialized, as in the
 *    DB-less unit tests): DEBUG log only. A missing DB is an environment state,
 *    not a re-index defect, so it must not raise alarm-level noise on every edit.
 *  - RE-INDEX FAILED on a real DB (the transaction throws): ERROR log, since a
 *    resolvable DB that then fails to re-index is a genuine, debuggable problem.
 */
async function triggerEditedFileReindex(args: {
  runtimeData: RuntimeData | undefined;
  rootId: string;
  workspacePath: string;
  absolutePath: string;
  content: string;
  size: number;
}): Promise<void> {
  let db: ReindexDatabaseHandle;
  try {
    db = await getDatabase();
  } catch (error) {
    // DB unavailable (no DB initialized). Non-fatal and expected outside a
    // running app — log at debug so it is traceable without alarming.
    logger.debug('Skipped re-index: database unavailable', {
      error: redactToolErrorForLog(error),
      path: REDACTED_PATH_LOG_VALUE,
    });
    return;
  }

  try {
    const relativePath = toFileRecordRelativePath(args.workspacePath);
    await reindexEditedFile(db, {
      content: args.content,
      mtimeMs: await statMtimeMs(args.absolutePath),
      name: path.basename(relativePath) || relativePath,
      relativePath,
      rootId: args.rootId,
      size: args.size,
      workspaceIndexEmbeddingSetId: args.runtimeData?.workspaceIndexEmbeddingSetId,
    });
  } catch (error) {
    // A resolvable DB that then fails to re-index is a genuine problem — surface
    // it (no silent swallow) but never fail the already-successful edit.
    logger.error('Failed to re-index edited file; RAG index may be stale until next sync', {
      error: redactToolErrorForLog(error),
      path: REDACTED_PATH_LOG_VALUE,
    });
  }
}

async function runWriteWorkspaceFile(
  input: WriteWorkspaceFileInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  rootName: string;
  path: string;
  bytesWritten: number;
  created: boolean;
}> {
  const buffer = Buffer.from(input.content, 'utf8');
  if (buffer.byteLength > MAX_WRITE_WORKSPACE_FILE_BYTES) {
    throw new Error(
      `Content for "${input.path}" is ${buffer.byteLength} bytes, exceeding the ${MAX_WRITE_WORKSPACE_FILE_BYTES} byte write limit.`
    );
  }

  const root = resolveWorkspaceRoot(runtimeData, input.root);
  const resolved = await resolveWorkspaceWritePath(root.path, input.path);

  // Serialize same-file writes against concurrent edits (Mastra runs tool calls
  // within a step concurrently). Key by the canonical absolute path so two edits
  // to the same file can never interleave and lose an update. The re-index runs
  // INSIDE the lock so the write + the re-index-enqueue are one atomic critical
  // section per file: a concurrent edit can never slip its newer bytes (and
  // mtime) between this write and its re-index, which would otherwise leave the
  // RAG row stale relative to disk. `triggerEditedFileReindex` is already
  // non-fatal (it catches+logs internally), so it never extends the lock's
  // failure surface.
  const { created } = await withFileLock(resolved.absolutePath, async () => {
    const writeResult = await writeContainedFileBytes({
      buffer,
      requestedPath: input.path,
      resolved,
    });
    await triggerEditedFileReindex({
      absolutePath: resolved.absolutePath,
      content: input.content,
      rootId: root.rootId,
      runtimeData,
      size: buffer.byteLength,
      workspacePath: resolved.workspacePath,
    });
    return writeResult;
  });

  return {
    bytesWritten: buffer.byteLength,
    created,
    path: resolved.workspacePath,
    rootName: root.displayName,
  };
}

async function runStringReplaceWorkspaceFile(
  input: StringReplaceWorkspaceFileInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  rootName: string;
  path: string;
  bytesWritten: number;
  matchType: StringReplaceMatchType;
  replaced: true;
}> {
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  // Resolve the write path up front so we can lock on the canonical absolute
  // path. resolveWorkspaceWritePath clamps ".." and contains symlinked
  // ancestors; the read below uses the same containment as the read tools.
  const resolved = await resolveWorkspaceWritePath(root.path, input.path);

  // The whole read-modify-write-AND-reindex cycle runs under the per-file lock so
  // a concurrent edit (another stringReplace, or a writeWorkspaceFile) to the
  // SAME file cannot interleave and drop an update or stale the RAG row. Edits to
  // different files still run in parallel.
  const result = await withFileLock(resolved.absolutePath, async () => {
    // Read through the SAME checked read path the read tools use (isFile, 2 MB
    // byte cap, NUL-byte binary probe, realpath-both-sides containment), so the
    // edit inherits PR-2.1's path-escape protection on the read side too.
    const file = await readWorkspaceTextFile({
      requestedPath: input.path,
      rootPath: root.path,
    });

    // Pure fuzzy-match cascade. THROWS StringReplaceError on ambiguous/not-found
    // matches — never applies a low-confidence edit (no silent fallbacks).
    const replacement = applyStringReplace({
      fileContent: file.content,
      newStr: input.newStr,
      oldStr: input.oldStr,
    });

    const buffer = Buffer.from(replacement.newContent, 'utf8');
    if (buffer.byteLength > MAX_WRITE_WORKSPACE_FILE_BYTES) {
      throw new Error(
        `Edited content for "${input.path}" is ${buffer.byteLength} bytes, exceeding the ${MAX_WRITE_WORKSPACE_FILE_BYTES} byte write limit.`
      );
    }

    await writeContainedFileBytes({ buffer, requestedPath: input.path, resolved });

    // Keep the RAG index coherent: re-index the edited file INSIDE the same
    // per-file critical section as the read-modify-write. Running it after the
    // lock released reopened the very race the lock closes — a concurrent edit
    // could land its newer bytes (and mtime) between this write and its
    // re-index, leaving the file_records row stale relative to disk and
    // self-healing-proof (matching mtime skips the next sync's re-read). No-ops
    // when the file isn't part of the Workspace Index; already non-fatal (it
    // catches+logs internally), so it never undoes a successful edit nor
    // extends the lock's failure surface.
    await triggerEditedFileReindex({
      absolutePath: resolved.absolutePath,
      content: replacement.newContent,
      rootId: root.rootId,
      runtimeData,
      size: buffer.byteLength,
      workspacePath: resolved.workspacePath,
    });

    return {
      bytesWritten: buffer.byteLength,
      matchType: replacement.matchType,
    };
  });

  return {
    bytesWritten: result.bytesWritten,
    matchType: result.matchType,
    path: resolved.workspacePath,
    replaced: true,
    rootName: root.displayName,
  };
}

/**
 * Acquire the per-file write lock for BOTH `keyA` and `keyB` before running
 * `task`, releasing both afterward. The two locks are acquired in sorted order so
 * two concurrent renames touching an overlapping pair of paths always take them
 * in the SAME order and can never deadlock (classic lock-ordering). Same-key
 * pairs (a no-op self-rename) collapse to a single lock.
 */
function withTwoFileLocks<T>(keyA: string, keyB: string, task: () => Promise<T>): Promise<T> {
  if (keyA === keyB) {
    return withFileLock(keyA, task);
  }
  const [first, second] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];
  return withFileLock(first, () => withFileLock(second, task));
}

/**
 * Post-delete/-rename index coherence (mirrors {@link triggerEditedFileReindex}):
 * remove the file's Workspace Index rows (file_records + chunks) and cancel its
 * in-flight embed jobs via the SAME standalone seam the background watcher uses
 * for a disappeared file. Runs AFTER the filesystem mutation and is non-fatal —
 * the file is already gone/renamed on disk, so a failed invalidation is LOGGED
 * (never swallowed) and reported honestly as `indexInvalidated: false` rather
 * than failing the tool. Returns whether any indexed row was actually removed.
 *
 * No-op (returns false) when no Workspace Index is configured or the DB is
 * unavailable (as in the DB-less unit tests) — there is then nothing to keep
 * coherent.
 */
async function triggerFileDeletionInvalidation(args: {
  runtimeData: RuntimeData | undefined;
  rootId: string;
  workspacePath: string;
}): Promise<{ invalidated: boolean }> {
  const embeddingSetId = args.runtimeData?.workspaceIndexEmbeddingSetId?.trim();
  if (!embeddingSetId) {
    return { invalidated: false };
  }

  let db: ReindexDatabaseHandle;
  try {
    db = await getDatabase();
  } catch (error) {
    logger.debug('Skipped index invalidation: database unavailable', {
      error: redactToolErrorForLog(error),
      path: REDACTED_PATH_LOG_VALUE,
    });
    return { invalidated: false };
  }

  try {
    const result = await invalidateManagedCacheEntriesByIdentity(
      db as Parameters<typeof invalidateManagedCacheEntriesByIdentity>[0],
      {
        embeddingSetId,
        targets: [
          {
            mode: 'exact',
            relativePath: toFileRecordRelativePath(args.workspacePath),
            rootId: args.rootId,
          },
        ],
      }
    );
    return { invalidated: result.deletedFileRecordIds.length > 0 };
  } catch (error) {
    logger.error(
      'Failed to invalidate index rows for a removed/renamed file; RAG index may be stale until next sync',
      {
        error: redactToolErrorForLog(error),
        path: REDACTED_PATH_LOG_VALUE,
      }
    );
    return { invalidated: false };
  }
}

/**
 * Best-effort re-index of a rename DESTINATION through the same seam edits use
 * ({@link triggerEditedFileReindex}). That seam only UPDATES an existing
 * file_records row, so for a brand-new destination path (the common case — a
 * rename requires the target NOT to exist) it no-ops and the destination's row is
 * imported by the background workspace sync; it matters only when the destination
 * path had a stale row. Reading the content is bounded (2 MB + binary probe); a
 * binary/oversized/unreadable destination simply skips (non-fatal — the file is
 * already renamed on disk).
 */
async function triggerRenamedDestinationReindex(args: {
  runtimeData: RuntimeData | undefined;
  rootId: string;
  rootPath: string;
  workspacePath: string;
  absolutePath: string;
}): Promise<void> {
  let file: { content: string; size: number };
  try {
    file = await readWorkspaceTextFile({
      requestedPath: args.workspacePath,
      rootPath: args.rootPath,
    });
  } catch (error) {
    logger.debug('Skipped renamed-destination re-index: not readable as text', {
      error: redactToolErrorForLog(error),
      path: REDACTED_PATH_LOG_VALUE,
    });
    return;
  }
  await triggerEditedFileReindex({
    absolutePath: args.absolutePath,
    content: file.content,
    rootId: args.rootId,
    runtimeData: args.runtimeData,
    size: file.size,
    workspacePath: args.workspacePath,
  });
}

async function runDeleteWorkspaceFile(
  input: DeleteWorkspaceFileInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  ok: true;
  path: string;
  rootName: string;
  indexInvalidated: boolean;
}> {
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  // Same path hardening as the write tools: clamps "..", contains symlinked
  // ancestors, and rejects the workspace root itself. The delete + index
  // invalidation run inside the per-file lock so a concurrent edit to the same
  // path cannot interleave.
  const resolved = await resolveWorkspaceWritePath(root.path, input.path);

  return withFileLock(resolved.absolutePath, async () => {
    let leafStats: import('node:fs').Stats;
    try {
      leafStats = await fsPromises.lstat(resolved.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Path "${input.path}" does not exist.`);
      }
      throw error;
    }
    // A symlink leaf here is a dangling one (a live symlink was already resolved
    // to its target by resolveWorkspaceWritePath, and one pointing outside the
    // root would have failed containment). Reject it as a containment escape.
    if (leafStats.isSymbolicLink()) {
      throw new Error(`Path "${input.path}" is outside the selected workspace root.`);
    }
    if (leafStats.isDirectory()) {
      throw new Error(
        `Path "${input.path}" is a directory. Deleting directories is not supported — use executeCommand for that.`
      );
    }

    await fsPromises.unlink(resolved.absolutePath);
    const { invalidated } = await triggerFileDeletionInvalidation({
      rootId: root.rootId,
      runtimeData,
      workspacePath: resolved.workspacePath,
    });

    return {
      indexInvalidated: invalidated,
      ok: true,
      path: resolved.workspacePath,
      rootName: root.displayName,
    };
  });
}

async function runRenameWorkspaceFile(
  input: RenameWorkspaceFileInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  ok: true;
  fromPath: string;
  toPath: string;
  rootName: string;
  indexInvalidated: boolean;
}> {
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  const fromResolved = await resolveWorkspaceWritePath(root.path, input.fromPath);
  const toResolved = await resolveWorkspaceWritePath(root.path, input.toPath);
  // Both paths resolve against the SAME single `root`, so a cross-root move is not
  // expressible through this schema; assert equal canonical roots as defense in
  // depth (never silently accept a cross-root move).
  if (fromResolved.canonicalRootPath !== toResolved.canonicalRootPath) {
    throw new Error(
      'Cross-root moves are not supported. Both paths must be in the same open folder.'
    );
  }
  if (fromResolved.absolutePath === toResolved.absolutePath) {
    throw new Error(
      `fromPath and toPath resolve to the same file "${toResolved.workspacePath}"; nothing to rename.`
    );
  }

  // Lock BOTH canonical paths (sorted order → deadlock-free) so a concurrent edit
  // or rename touching either path cannot interleave with this move.
  return withTwoFileLocks(fromResolved.absolutePath, toResolved.absolutePath, async () => {
    let fromStats: import('node:fs').Stats;
    try {
      fromStats = await fsPromises.lstat(fromResolved.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Path "${input.fromPath}" does not exist.`);
      }
      throw error;
    }
    if (fromStats.isSymbolicLink()) {
      throw new Error(`Path "${input.fromPath}" is outside the selected workspace root.`);
    }
    if (fromStats.isDirectory()) {
      throw new Error(
        `Path "${input.fromPath}" is a directory. Renaming directories is not supported — use executeCommand for that.`
      );
    }

    // Destination must NOT already exist (no overwrite in v1). lstat so a symlink
    // at the destination also counts as "exists".
    let destinationExists = true;
    try {
      await fsPromises.lstat(toResolved.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      destinationExists = false;
    }
    if (destinationExists) {
      throw new Error(
        `Destination "${input.toPath}" already exists. Delete it first or choose another path (rename does not overwrite).`
      );
    }

    // Create any missing destination parent directories one component at a time,
    // rejecting symlinked intermediates (a plain mkdir -p would traverse them).
    await ensureContainedDirectory(
      toResolved.canonicalRootPath,
      path.dirname(toResolved.absolutePath)
    );

    await fsPromises.rename(fromResolved.absolutePath, toResolved.absolutePath);

    // Index coherence: invalidate the SOURCE rows immediately (the differentiator
    // vs a shell mv). `indexInvalidated` reflects that source removal. The
    // DESTINATION is re-indexed through the edit seam, which no-ops for a
    // brand-new path — a not-previously-indexed destination's row is imported by
    // the background workspace sync (the documented staleness window: the moved
    // file is searchable via the live grep pass immediately, and via the semantic
    // index once the next sync imports it).
    const { invalidated } = await triggerFileDeletionInvalidation({
      rootId: root.rootId,
      runtimeData,
      workspacePath: fromResolved.workspacePath,
    });
    await triggerRenamedDestinationReindex({
      absolutePath: toResolved.absolutePath,
      rootId: root.rootId,
      rootPath: root.path,
      runtimeData,
      workspacePath: toResolved.workspacePath,
    });

    return {
      fromPath: fromResolved.workspacePath,
      indexInvalidated: invalidated,
      ok: true,
      rootName: root.displayName,
      toPath: toResolved.workspacePath,
    };
  });
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
    childDepth: childSegments.length,
    childPath,
    childSegments,
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
    depth: context.childDepth,
    path: context.childPath,
    type: 'file',
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
    depth,
    detail,
    includeDirectories,
    includeFiles,
    includeHidden,
  };
  const state: DirectoryTraversalState = {
    entries: [],
    // Collect through the requested page so offset paging can skip into it.
    maxEntries: offset + maxEntries,
    totalMatchedFiles: 0,
    truncated: false,
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
        count: entries.length,
        entries,
        offset,
        path: normalizedPath,
        rootName: root.displayName,
        totalEntries: state.entries.length,
        totalMatchedFiles: state.totalMatchedFiles,
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
  rootPath: string;
  tapestryRanges: RuntimeWorkspaceContextRangeMetadata[] | undefined;
}): Promise<WorkspaceContextResolvedFile> {
  if (args.tapestryRanges && args.tapestryRanges.length > 0) {
    const rawFile = await readWorkspaceTextFile({
      requestedPath: args.requestedPath,
      rootPath: args.rootPath,
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
    { workspaceRootPath: args.rootPath }
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
  tapestryRangesByPath: ReadonlyMap<string, RuntimeWorkspaceContextRangeMetadata[]>;
  workspaceRootPath: string;
}): Promise<WorkspaceContextBatchReadResult[]> {
  const batchResults = await Promise.allSettled(
    args.batchPaths.map(async (requestedPath) => {
      const normalizedRequestedPath = normalizeWorkspacePath(requestedPath);
      const file = await readWorkspaceContextFile({
        maxCharsPerFile: args.maxCharsPerFile,
        requestedPath: normalizedRequestedPath,
        rootPath: args.workspaceRootPath,
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

async function runReadWorkspaceContext(
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
  const root = resolveWorkspaceRoot(runtimeData, input.root);
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
      createdAt: listing.createdAt,
      description: listing.description,
      dimensions: listing.dimensions,
      distance: listing.distance,
      id: listing.id,
      isWorkspaceIndex,
      modelId: listing.modelId,
      modelKey: listing.modelKey,
      name: listing.name,
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
        averageTokensPerChunk,
        coveragePercent: totalChunks > 0 ? Math.round((embeddedChunks / totalChunks) * 100) : 0,
        embeddedChunks,
        fileCount,
        tokenizedChunkCount,
        totalChunks,
        totalTokens,
      },
    };
  });
  const spaces =
    input.workspaceIndexOnly === true
      ? mappedSpaces.filter((space) => space.isWorkspaceIndex)
      : mappedSpaces;
  return { count: spaces.length, spaces, workspaceIndex };
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
      description:
        "Find a symbol's best-effort enclosing 1-based line range in a workspace file without returning whole-file content. Matching is substring-based, so verify the returned range. Use this to get a function/type/section range, then pass it to brainstrike.updateWorkspaceTapestrySelections.",
      execute: async (input: ToolExecuteInput<FindWorkspaceSymbolInput>) => {
        const resolvedInput = parseToolExecuteInput(FindWorkspaceSymbolInputSchema, input);
        try {
          return await runFindWorkspaceSymbol(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('findWorkspaceSymbol failed', error, resolvedInput);
          throw error;
        }
      },
      id: FIND_WORKSPACE_SYMBOL_TOOL_ID,
      inputSchema: FindWorkspaceSymbolInputSchema,
    },
    [GREP_SEARCH_TOOL_ID]: {
      description:
        "Grep file content for an exact string (default) or JavaScript regex. HYBRID: searches BOTH the index AND the live on-disk files and merges, so just-edited / not-yet-reindexed files are found fresh (each match is labelled source: 'index' | 'live' | 'both'; re-grep after an edit to confirm your change is on disk). Use this FIRST for identifiers, exact strings, and error messages. Default outputMode 'files' cheaply surveys WHICH files match; then call again with outputMode 'content' and filePaths to see the matching lines. Results are truncated to a fixed budget — follow the returned hint (offset, filters) to continue.",
      execute: async (input: ToolExecuteInput<GrepSearchInput>) => {
        const resolvedInput = parseToolExecuteInput(GrepSearchInputSchema, input);
        try {
          return await runGrepSearch(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('grepSearch failed', error, resolvedInput);
          throw error;
        }
      },
      id: GREP_SEARCH_TOOL_ID,
      inputSchema: GrepSearchInputSchema,
    },
    [GLOB_WORKSPACE_TOOL_ID]: {
      description:
        'Enumerate workspace files by glob pattern (e.g. **/*.test.ts, src/**/*.tsx, **/package.json). Use this to find files by NAME/PATH shape when you do not know their content — complementary to grepSearch (content) and readWorkspaceDirectory (one level). Skips .git/node_modules/build output by default (includeIgnored to override). Results are truncated to a fixed budget — follow the returned hint (offset, narrower pattern) to continue.',
      execute: async (input: ToolExecuteInput<GlobWorkspaceInput>) => {
        const resolvedInput = parseToolExecuteInput(GlobWorkspaceInputSchema, input);
        try {
          return await runGlobWorkspace(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('globWorkspace failed', error, resolvedInput);
          throw error;
        }
      },
      id: GLOB_WORKSPACE_TOOL_ID,
      inputSchema: GlobWorkspaceInputSchema,
    },
    [WEB_SEARCH_TOOL_ID]: {
      description:
        'Search the web via Tavily for current documentation, APIs, error messages, and library usage you do not already know. SENDS YOUR QUERY TO AN EXTERNAL SERVICE (Tavily) — never include secrets or private workspace contents. Use this only for general/public web knowledge; for THIS project\'s code use grepSearch/queryEmbeddingSpace instead. Requires a Tavily API key in Settings → API Keys: when none is configured the tool returns a non-fatal "unavailable, add a key" result rather than failing. Results (title, url, snippet) are truncated to a fixed budget.',
      // The Tavily key is resolved server-side inside runWebSearch and never
      // returned to the model. No injected deps here → real fetch + keychain.
      execute: async (input: ToolExecuteInput<WebSearchInput>) => {
        const resolvedInput = parseToolExecuteInput(WebSearchInputSchema, input);
        try {
          return await runWebSearch(resolvedInput, dependencies.webSearch);
        } catch (error) {
          logToolFailure('webSearch failed', error, resolvedInput);
          throw error;
        }
      },
      id: WEB_SEARCH_TOOL_ID,
      inputSchema: WebSearchInputSchema,
    },
    [READ_WORKSPACE_FILE_TOOL_ID]: {
      description:
        'Read a workspace file from the selected root. Use line ranges and maxChars to keep context efficient.',
      execute: async (input: ToolExecuteInput<ReadWorkspaceFileInput>) => {
        const resolvedInput = parseToolExecuteInput(ReadWorkspaceFileInputSchema, input);
        try {
          return await runReadWorkspaceFile(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('readWorkspaceFile failed', error, resolvedInput);
          throw error;
        }
      },
      id: READ_WORKSPACE_FILE_TOOL_ID,
      inputSchema: ReadWorkspaceFileInputSchema,
    },
    [WRITE_WORKSPACE_FILE_TOOL_ID]: {
      description:
        'Write or create a UTF-8 file in the selected workspace root. Overwrites existing content and creates missing parent directories. The path is clamped to the workspace root and can never escape it. Requires user approval (edit-risk).',
      execute: async (input: ToolExecuteInput<WriteWorkspaceFileInput>) => {
        const resolvedInput = parseToolExecuteInput(WriteWorkspaceFileInputSchema, input);
        try {
          return await runWriteWorkspaceFile(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('writeWorkspaceFile failed', error, resolvedInput);
          throw error;
        }
      },
      id: WRITE_WORKSPACE_FILE_TOOL_ID,
      inputSchema: WriteWorkspaceFileInputSchema,
    },
    [STRING_REPLACE_WORKSPACE_FILE_TOOL_ID]: {
      description:
        'Surgically edit an existing workspace file: replace one oldStr block with newStr. Read the file first, then pass an oldStr with enough surrounding context to identify ONE location (a single line matching several places is refused), and the newStr (empty deletes the block). Matching is fuzzy (exact → whitespace-tolerant → close-match) but ambiguous or not-found matches are refused, never guessed. The path is clamped to the workspace root. Requires user approval (edit-risk).',
      execute: async (input: ToolExecuteInput<StringReplaceWorkspaceFileInput>) => {
        const resolvedInput = parseToolExecuteInput(StringReplaceWorkspaceFileInputSchema, input);
        try {
          return await runStringReplaceWorkspaceFile(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('stringReplaceWorkspaceFile failed', error, resolvedInput);
          throw error;
        }
      },
      id: STRING_REPLACE_WORKSPACE_FILE_TOOL_ID,
      inputSchema: StringReplaceWorkspaceFileInputSchema,
    },
    [DELETE_WORKSPACE_FILE_TOOL_ID]: {
      description:
        'Delete a single file from the selected workspace root. FILES ONLY — a directory path is refused (use executeCommand for directory removal). The path is clamped to the workspace root and can never escape it. Removes the file from the workspace index when it was indexed. Requires user approval (edit-risk).',
      execute: async (input: ToolExecuteInput<DeleteWorkspaceFileInput>) => {
        const resolvedInput = parseToolExecuteInput(DeleteWorkspaceFileInputSchema, input);
        try {
          return await runDeleteWorkspaceFile(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('deleteWorkspaceFile failed', error, resolvedInput);
          throw error;
        }
      },
      id: DELETE_WORKSPACE_FILE_TOOL_ID,
      inputSchema: DeleteWorkspaceFileInputSchema,
    },
    [RENAME_WORKSPACE_FILE_TOOL_ID]: {
      description:
        'Rename or move a single file within the selected workspace root. FILES ONLY. The destination must NOT already exist (rename never overwrites — delete the target first). Both paths stay inside ONE open folder (cross-root moves refused); missing destination parent directories are created. Prefer this over a shell "mv" so the workspace index stays coherent. Requires user approval (edit-risk).',
      execute: async (input: ToolExecuteInput<RenameWorkspaceFileInput>) => {
        const resolvedInput = parseToolExecuteInput(RenameWorkspaceFileInputSchema, input);
        try {
          return await runRenameWorkspaceFile(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('renameWorkspaceFile failed', error, resolvedInput);
          throw error;
        }
      },
      id: RENAME_WORKSPACE_FILE_TOOL_ID,
      inputSchema: RenameWorkspaceFileInputSchema,
    },
    [READ_WORKSPACE_DIRECTORY_TOOL_ID]: {
      description:
        'List workspace directory entries (path + type by default; detail: true adds sizes). Prefer specific subdirectories over the root. Truncated listings include a hint with the offset to continue from.',
      execute: async (input: ToolExecuteInput<ReadWorkspaceDirectoryInput>) => {
        const resolvedInput = parseToolExecuteInput(ReadWorkspaceDirectoryInputSchema, input);
        try {
          return await runReadWorkspaceDirectory(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('readWorkspaceDirectory failed', error, resolvedInput);
          throw error;
        }
      },
      id: READ_WORKSPACE_DIRECTORY_TOOL_ID,
      inputSchema: ReadWorkspaceDirectoryInputSchema,
    },
    [LIST_WORKSPACE_CONTEXT_TOOL_ID]: {
      description:
        'Inspect the current workspace root, selected context paths, token budgets, and workspace index hint without returning file contents. Compact summary by default; set detail: true for per-file Tapestry ranges. Use before reading selected context.',
      execute: async (input: ToolExecuteInput<ListWorkspaceContextInput>) => {
        const resolvedInput = parseToolExecuteInput(ListWorkspaceContextInputSchema, input);
        try {
          return runListWorkspaceContext(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('listWorkspaceContext failed', error, resolvedInput);
          throw error;
        }
      },
      id: LIST_WORKSPACE_CONTEXT_TOOL_ID,
      inputSchema: ListWorkspaceContextInputSchema,
    },
    [READ_WORKSPACE_CONTEXT_TOOL_ID]: {
      description:
        'Read selected or explicit workspace files under maxFiles, per-file, and token budgets. Uses curated Tapestry ranges by default when available. Use after semantic search when you need exact source lines. Skipped and truncated files are reported explicitly.',
      execute: async (input: ToolExecuteInput<ReadWorkspaceContextInput>) => {
        const resolvedInput = parseToolExecuteInput(ReadWorkspaceContextInputSchema, input);
        try {
          return await runReadWorkspaceContext(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('readWorkspaceContext failed', error, resolvedInput);
          throw error;
        }
      },
      id: READ_WORKSPACE_CONTEXT_TOOL_ID,
      inputSchema: ReadWorkspaceContextInputSchema,
    },
    [UPDATE_WORKSPACE_CONTEXT_SELECTION_TOOL_ID]: {
      description:
        'Bulk add, remove, or replace files selected in the workspace context explorer. Use this to curate reusable context for the user; listWorkspaceContext reports token counts afterward.',
      execute: async (input: ToolExecuteInput<UpdateWorkspaceContextSelectionInput>) => {
        const resolvedInput = parseToolExecuteInput(
          UpdateWorkspaceContextSelectionInputSchema,
          input
        );
        try {
          return await runUpdateWorkspaceContextSelection(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('updateWorkspaceContextSelection failed', error, resolvedInput);
          throw error;
        }
      },
      id: UPDATE_WORKSPACE_CONTEXT_SELECTION_TOOL_ID,
      inputSchema: UpdateWorkspaceContextSelectionInputSchema,
    },
    [UPDATE_WORKSPACE_TAPESTRY_SELECTIONS_TOOL_ID]: {
      description:
        'Create, add, or clear Tapestry line selections for workspace context files using 1-based inclusive line numbers. Use after embedding search and file reads to keep only verified source ranges.',
      execute: async (input: ToolExecuteInput<UpdateWorkspaceTapestrySelectionsInput>) => {
        const resolvedInput = parseToolExecuteInput(
          UpdateWorkspaceTapestrySelectionsInputSchema,
          input
        );
        try {
          return await runUpdateWorkspaceTapestrySelections(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('updateWorkspaceTapestrySelections failed', error, resolvedInput);
          throw error;
        }
      },
      id: UPDATE_WORKSPACE_TAPESTRY_SELECTIONS_TOOL_ID,
      inputSchema: UpdateWorkspaceTapestrySelectionsInputSchema,
    },
    [LIST_EMBEDDING_SPACES_TOOL_ID]: {
      description:
        'List available embedding spaces, identify the configured Workspace Index, and optionally include coverage stats. Use this when you need to inspect non-default embedding spaces or index coverage.',
      execute: async (input: ToolExecuteInput<ListEmbeddingSetsInput>) => {
        const resolvedInput = parseToolExecuteInput(ListEmbeddingSetsInputSchema, input);
        try {
          return await runListEmbeddingSpaces(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('listEmbeddingSpaces failed', error, resolvedInput);
          throw error;
        }
      },
      id: LIST_EMBEDDING_SPACES_TOOL_ID,
      inputSchema: ListEmbeddingSetsInputSchema,
    },
    [QUERY_EMBEDDING_SPACE_TOOL_ID]: {
      description:
        'Query semantic workspace context and return bounded source text plus metadata-only chunks with persisted line ranges. For workspace/codebase searches, omit embeddingSetId to use the Workspace Index. Provide embeddingSetId only for a specific non-default embedding space; use tokenBudget, limit, threshold, and optional filePaths to keep retrieval bounded.',
      execute: async (input: ToolExecuteInput<QueryEmbeddingSpaceInput>) => {
        const resolvedInput = resolveQueryEmbeddingSpaceInput(input);
        try {
          return await runQueryEmbeddingSpace(resolvedInput, runtimeData, {
            embeddingHostManager: dependencies.embeddingHostManager,
          });
        } catch (error) {
          logToolFailure('queryEmbeddingSpace failed', error, resolvedInput);
          throw error;
        }
      },
      id: QUERY_EMBEDDING_SPACE_TOOL_ID,
      inputSchema: QueryEmbeddingSpaceInputSchema,
    },
  };

  // Arbitrary shell execution is registered like every other native tool and
  // gated by the permission engine. With enforce-on-by-default, its 'execute'
  // risk bucket resolves to 'ask', so the run SUSPENDS for per-call approval
  // before the command runs (approve → execute, decline → skip). A user can set
  // execute to 'allow'/yolo to run it unprompted, or 'deny' to omit it — that is
  // the permission gate's job now, not a registration-time conditional.
  tools[EXECUTE_COMMAND_TOOL_ID] = {
    description:
      "Run an arbitrary shell command on the user's machine (tests, builds, linters, git, package managers). This is ARBITRARY COMMAND EXECUTION with NO sandbox — the command can do anything the user can. The command runs in the user's shell starting in the workspace root (override with cwd, which must still be inside an open folder). On timeout or cancellation the ENTIRE process tree is killed so nothing is left running. Output is bounded to a fixed budget (most recent lines kept) — pipe through '| tail -n N' for long output. Prefer non-destructive commands; never run destructive ones (rm -rf, force pushes, resets) without an explicit user request.",
    // The second arg carries the Mastra ToolExecutionContext, whose abortSignal
    // we thread into the run so a cancelled run kills the process tree.
    execute: async (
      input: ToolExecuteInput<ExecuteCommandInput>,
      options?: { abortSignal?: AbortSignal }
    ) => {
      const resolvedInput = parseToolExecuteInput(ExecuteCommandInputSchema, input);
      try {
        return await runExecuteCommand(resolvedInput, runtimeData, {
          signal: options?.abortSignal,
        });
      } catch (error) {
        logToolFailure('executeCommand failed', error, resolvedInput);
        throw error;
      }
    },
    id: EXECUTE_COMMAND_TOOL_ID,
    inputSchema: ExecuteCommandInputSchema,
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
