/**
 * The read half of the workspace-context tool family (BST-743):
 * listWorkspaceContext reports the open roots and the index; readWorkspaceContext
 * reads explicit files with batched bounded reads. It must not import Electron:
 * the desktop agent host runs these tools in its own process.
 */
import type {
  ListWorkspaceContextInput,
  ReadWorkspaceContextInput,
  RuntimeData,
  RuntimeWorkspaceRoot,
} from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import {
  normalizeWorkspacePath,
  normalizeWorkspacePaths,
  REDACTED_PATH_LOG_VALUE,
  redactToolErrorForLog,
  runReadWorkspaceFile,
  WorkspacePathRefusal,
  type WorkspacePathRefusalReason,
} from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import type { WorkspaceIndexSummary } from './workspace-index-summary';
import { getWorkspaceRoots, resolveWorkspaceRoot } from './workspace-roots';

const logger = createLogger('DesktopAssistantTools');

const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;
const DEFAULT_CONTEXT_MAX_FILES = 20;
const DEFAULT_CONTEXT_MAX_CHARS_PER_FILE = 12_000;
const READ_WORKSPACE_CONTEXT_BATCH_SIZE = 10;

interface ListWorkspaceContextToolResult {
  workspaceIndex: WorkspaceIndexSummary;
  /**
   * MAIN root path (the assistant's operating root — `workspaceRoots[0]`,
   * client-declared with a created_at fallback).
   */
  workspaceRootPath: string | null;
  /**
   * Every open workspace root (id + display name + path). The model reads these
   * to pass a `root` qualifier to the read/search tools when several are open.
   */
  workspaceRoots: readonly RuntimeWorkspaceRoot[];
}

export function runListWorkspaceContext(
  _input: ListWorkspaceContextInput,
  runtimeData: RuntimeData | undefined,
  /** The native index's status summary, read by the caller. */
  workspaceIndex: WorkspaceIndexSummary
): ListWorkspaceContextToolResult {
  const workspaceRoots = getWorkspaceRoots(runtimeData);
  const resolvedWorkspaceRoots = runtimeData?.workspaceRoots;
  if (
    resolvedWorkspaceRoots !== undefined &&
    resolvedWorkspaceRoots.length !== workspaceRoots.length
  ) {
    throw new TypeError('Workspace root metadata is malformed. Refresh the workspace and retry.');
  }
  if (workspaceRoots.length === 0 && resolvedWorkspaceRoots === undefined) {
    throw new ToolInputError(
      'No folder is open in the workspace. Add a folder in the left file tree first.'
    );
  }
  // The first root is the MAIN root (client-declared via mainRootId, with the
  // DB created_at order as fallback — see orderWorkspaceRoots).
  return {
    workspaceIndex,
    workspaceRootPath: workspaceRoots[0]?.path ?? null,
    workspaceRoots,
  };
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

/** Each read refusal's skip reason, decided by its type, never its text (BST-1996). */
const SKIP_REASON_BY_REFUSAL = {
  binary: 'binary',
  missing: 'missing',
  'not-file': 'notFile',
  outside: 'outsideWorkspace',
  'too-large': 'oversized',
} as const satisfies Record<WorkspacePathRefusalReason, WorkspaceContextSkippedFile['reason']>;

function classifyReadContextError(
  workspacePath: string,
  error: unknown
): WorkspaceContextSkippedFile {
  if (error instanceof WorkspacePathRefusal) {
    const reason = SKIP_REASON_BY_REFUSAL[error.reason];
    // A missing file is the whole story; the other refusals carry their remedy.
    return reason === 'missing'
      ? { path: workspacePath, reason }
      : { message: error.message, path: workspacePath, reason };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // The ranged reader's file can vanish between its path check and its read.
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

interface WorkspaceContextResolvedFile {
  approxOutputTokens: number;
  content: string;
  endLine: number;
  omittedChars: number;
  path: string;
  size: number;
  startLine: number;
  totalLines: number;
  truncated: boolean;
}

async function readWorkspaceContextFile(args: {
  maxCharsPerFile: number;
  requestedPath: string;
  root: RuntimeWorkspaceRoot;
}): Promise<WorkspaceContextResolvedFile> {
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
}): Promise<WorkspaceContextBatchReadResult[]> {
  const batchResults = await Promise.allSettled(
    args.batchPaths.map(async (requestedPath) => {
      const file = await readWorkspaceContextFile({
        maxCharsPerFile: args.maxCharsPerFile,
        requestedPath: normalizeWorkspacePath(requestedPath),
        root: args.root,
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
  return {
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
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  const requestedPaths = normalizeWorkspacePaths(input.filePaths);
  if (requestedPaths.length === 0) {
    throw new ToolInputError('Provide the workspace-relative filePaths to read.');
  }

  const tokenBudget = input.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
  const maxFiles = input.maxFiles ?? DEFAULT_CONTEXT_MAX_FILES;
  const maxCharsPerFile = input.maxCharsPerFile ?? DEFAULT_CONTEXT_MAX_CHARS_PER_FILE;
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
    const batchResults = await readWorkspaceContextBatch({ batchPaths, maxCharsPerFile, root });
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
    workspaceRootPath: root.path,
  };
}
