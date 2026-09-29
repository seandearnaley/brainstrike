/**
 * The paged `readWorkspaceFile` native tool (BST-743): single-handle streaming
 * scan (stat → binary probe → fatal-UTF-8 decode in 64 KiB chunks), 1-based
 * line-numbered page rendering, continuation-cursor validation/issue against
 * the main-process cursor registry, and self-fitting against the native result
 * + model projection budgets. See docs/agents/assistant-providers.md ("Tool
 * output budget") for the paging contract this implements.
 *
 * Leaf module: depends on the shared path-resolution/lock, workspace-root,
 * cursor-registry, and staleness leaves — never on `assistant-tools.ts`, so no
 * import cycle is possible.
 */
import fsPromises from 'node:fs/promises';
import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  NATIVE_TOOL_RESULT_CHAR_BUDGET,
  type ReadWorkspaceFileInput,
  type RuntimeData,
  recordKnownFileMtime,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { countTokensHeuristic } from '@brainstrike/tokenization';
import { assertNotAgentIgnored } from './agent-ignore-guard';
import {
  READ_WORKSPACE_FILE_CURSOR_HANDLE_LENGTH,
  type ReadWorkspaceFileCursorRegistry,
  type ReadWorkspaceFileCursorScope,
  type ReadWorkspaceFileCursorState,
} from './read-workspace-file-cursor-registry';
import { buildReadWorkspaceFileProjectionText } from './read-workspace-file-model-projection';
import {
  buildRepeatedCallRefusalResult,
  checkUnchangedReadWindow,
  type LoopGuardRefusalResult,
  readWindowKey,
  UNCHANGED_READ_STUB_MESSAGE,
} from './tool-call-loop-guards';
import { readStateScope } from './workspace-file-staleness';
import { decodedWorkspaceTextModelOutputChars } from './workspace-model-projection-helpers';
import { withStableWorkspaceFileLock } from './workspace-path-resolution';
import { describeOpenRootTopology, resolveWorkspaceRoot } from './workspace-roots';
import { MAX_READ_WORKSPACE_FILE_BYTES } from './workspace-text-file-reader';

const DEFAULT_FILE_MAX_CHARS = 12_000;
const READ_WORKSPACE_FILE_CHUNK_BYTES = 64 * 1024;

function sliceContentPrefix(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  const boundaryCode = content.charCodeAt(maxChars - 1);
  const safeEnd = boundaryCode >= 0xd8_00 && boundaryCode <= 0xdb_ff ? maxChars - 1 : maxChars;
  return content.slice(0, safeEnd);
}

interface ReadWorkspaceFilePosition {
  readonly column: number;
  readonly line: number;
}

interface ReadWorkspaceFilePage {
  readonly content: string;
  readonly lastLine: number;
  readonly nextPosition: ReadWorkspaceFilePosition | null;
}

interface ReadWorkspaceFileScannedLine {
  readonly content: string;
  readonly length: number;
  readonly line: number;
  readonly sourceStartColumn: number;
}

interface ReadWorkspaceFileScan {
  readonly absolutePath: string;
  readonly cursorLineLength: number | undefined;
  readonly lineStartOffsets: ReadonlyMap<number, number>;
  readonly lines: readonly ReadWorkspaceFileScannedLine[];
  readonly mtimeMs: number;
  readonly path: string;
  readonly requestedEndOffset: number;
  readonly size: number;
  readonly totalLines: number;
}

function renderReadWorkspaceFilePage(
  lines: readonly ReadWorkspaceFileScannedLine[],
  position: ReadWorkspaceFilePosition,
  endLine: number,
  maxChars: number
): ReadWorkspaceFilePage {
  const parts: string[] = [];
  let remaining = maxChars;
  let line = position.line;
  let column = position.column;
  let lastLine = position.line;

  while (line <= endLine) {
    const separator = parts.length === 0 ? '' : '\n';
    const prefix = `${line}: `;
    const overhead = separator.length + prefix.length;
    if (overhead > remaining) {
      break;
    }

    const sourceLine = lines.find((candidate) => candidate.line === line);
    if (!sourceLine || column < sourceLine.sourceStartColumn || column > sourceLine.length) {
      break;
    }
    const remainderLength = sourceLine.length - column;
    const capturedOffset = column - sourceLine.sourceStartColumn;
    const remainder = sourceLine.content.slice(capturedOffset);
    const sourceBudget = remaining - overhead;
    if (remainderLength > sourceBudget) {
      const fragment = sliceContentPrefix(remainder, sourceBudget);
      if (fragment.length === 0) {
        break;
      }
      parts.push(separator, prefix);
      lastLine = line;
      parts.push(fragment);
      column += fragment.length;
      return {
        content: parts.join(''),
        lastLine,
        nextPosition: { column, line },
      };
    }

    parts.push(separator, prefix);
    remaining = sourceBudget;
    lastLine = line;
    parts.push(remainder);
    remaining -= remainderLength;
    line += 1;
    column = 0;
  }

  return {
    content: parts.join(''),
    lastLine,
    nextPosition: line <= endLine ? { column, line } : null,
  };
}

function readWorkspaceFilePageAdvances(
  page: ReadWorkspaceFilePage,
  position: ReadWorkspaceFilePosition
): boolean {
  if (!page.nextPosition) {
    return true;
  }
  return (
    page.nextPosition.line > position.line ||
    (page.nextPosition.line === position.line && page.nextPosition.column > position.column)
  );
}

function countUnreadSourceChars(
  position: ReadWorkspaceFilePosition | null,
  lineStartOffsets: ReadonlyMap<number, number>,
  requestedEndOffset: number
): number {
  if (!position) {
    return 0;
  }
  const lineStartOffset = lineStartOffsets.get(position.line);
  if (lineStartOffset === undefined) {
    throw new Error('readWorkspaceFile lost the source offset for its continuation handle.');
  }
  const boundaryOffset = position.column === 0 && position.line > 1 ? 1 : 0;
  return requestedEndOffset - (lineStartOffset + position.column - boundaryOffset);
}

function assertReadWorkspaceFileCursorIdentity(args: {
  readonly cursor: ReadWorkspaceFileCursorState;
  readonly file: { readonly mtimeMs: number; readonly path: string; readonly size: number };
  readonly rootId: string;
}): void {
  if (args.cursor.rootId !== args.rootId) {
    throw new Error(
      'The readWorkspaceFile continuation handle belongs to another workspace root. Start a new read without cursor.'
    );
  }
  if (
    args.cursor.path !== args.file.path ||
    args.cursor.size !== args.file.size ||
    args.cursor.mtimeMs !== args.file.mtimeMs
  ) {
    throw new Error(
      'The readWorkspaceFile continuation handle is stale or belongs to another file. Start a new read without cursor.'
    );
  }
}

function assertReadWorkspaceFileRangeReplay(
  cursor: ReadWorkspaceFileCursorState,
  input: ReadWorkspaceFileInput
): void {
  const hasStartLine = input.startLine !== null && input.startLine !== undefined;
  const hasEndLine = input.endLine !== null && input.endLine !== undefined;
  const replaysStartLine =
    !hasStartLine ||
    input.startLine === cursor.requestedStartLine ||
    (cursor.requestedStartLine === null && input.startLine === 1);
  const replaysEndLine =
    !hasEndLine ||
    input.endLine === cursor.requestedEndLine ||
    (cursor.requestedEndLine === null && input.endLine === cursor.endLine);
  if (!(replaysStartLine && replaysEndLine)) {
    throw new Error(
      'A readWorkspaceFile continuation may only replay the original startLine/endLine unchanged. Reuse nextCursor without changing its range.'
    );
  }
}

function assertReadWorkspaceFileCursorPosition(args: {
  readonly cursor: ReadWorkspaceFileCursorState;
  readonly cursorLineLength: number | undefined;
  readonly totalLines: number;
}): void {
  if (
    args.cursorLineLength === undefined ||
    args.cursor.endLine > args.totalLines ||
    args.cursor.column > args.cursorLineLength
  ) {
    throw new Error(
      'The readWorkspaceFile continuation handle is stale or has an invalid source position. Start a new read without cursor.'
    );
  }
}

function resolveReadWorkspaceFilePageRequest(args: {
  readonly cursor: ReadWorkspaceFileCursorState | null;
  readonly file: { readonly mtimeMs: number; readonly path: string; readonly size: number };
  readonly input: ReadWorkspaceFileInput;
  readonly cursorLineLength: number | undefined;
  readonly rootId: string;
  readonly totalLines: number;
}): {
  readonly endLine: number;
  readonly position: ReadWorkspaceFilePosition;
  readonly requestedEndLine: number | null;
  readonly requestedStartLine: number | null;
} {
  const { cursor, cursorLineLength, file, input, rootId, totalLines } = args;
  if (cursor) {
    assertReadWorkspaceFileRangeReplay(cursor, input);
    assertReadWorkspaceFileCursorIdentity({ cursor, file, rootId });
    assertReadWorkspaceFileCursorPosition({ cursor, cursorLineLength, totalLines });
    return {
      endLine: cursor.endLine,
      position: { column: cursor.column, line: cursor.line },
      requestedEndLine: cursor.requestedEndLine,
      requestedStartLine: cursor.requestedStartLine,
    };
  }

  const startLine = Math.max(1, Math.min(input.startLine ?? 1, totalLines));
  return {
    endLine: Math.max(startLine, Math.min(input.endLine ?? totalLines, totalLines)),
    position: { column: 0, line: startLine },
    requestedEndLine: input.endLine ?? null,
    requestedStartLine: input.startLine ?? null,
  };
}

interface ReadWorkspaceFileCapture {
  content: string;
  readonly overhead: number;
  readonly sourceBudget: number;
  readonly sourceStartColumn: number;
}

interface ReadWorkspaceFileScanState {
  readonly candidateEndLine: number;
  readonly candidateStartColumn: number;
  readonly candidateStartLine: number;
  captureComplete: boolean;
  captureRemaining: number;
  currentCapture: ReadWorkspaceFileCapture | undefined;
  currentLine: number;
  currentLineLength: number;
  currentLinePrefix: string;
  currentLineStartOffset: number;
  readonly cursorLine: number | undefined;
  cursorLineLength: number | undefined;
  lastLine: ReadWorkspaceFileScannedLine;
  lastLineStartOffset: number;
  readonly lineStartOffsets: Map<number, number>;
  readonly maxChars: number;
  requestedEndOffset: number | undefined;
  readonly scannedLines: ReadWorkspaceFileScannedLine[];
  sourceOffset: number;
}

function beginReadWorkspaceFileLine(state: ReadWorkspaceFileScanState): void {
  state.currentCapture = undefined;
  if (
    state.captureComplete ||
    state.currentLine < state.candidateStartLine ||
    state.currentLine > state.candidateEndLine
  ) {
    return;
  }

  state.lineStartOffsets.set(state.currentLine, state.currentLineStartOffset);
  const separatorLength = state.scannedLines.length === 0 ? 0 : 1;
  const overhead = separatorLength + `${state.currentLine}: `.length;
  if (overhead > state.captureRemaining) {
    state.captureComplete = true;
    return;
  }
  state.currentCapture = {
    content: '',
    overhead,
    sourceBudget: state.captureRemaining - overhead,
    sourceStartColumn:
      state.currentLine === state.candidateStartLine ? state.candidateStartColumn : 0,
  };
}

function appendReadWorkspaceFileLineSegment(
  state: ReadWorkspaceFileScanState,
  segment: string
): void {
  if (state.currentLinePrefix.length < state.maxChars) {
    state.currentLinePrefix += segment.slice(0, state.maxChars - state.currentLinePrefix.length);
  }
  const capture = state.currentCapture;
  if (capture && capture.content.length < capture.sourceBudget + 1) {
    const segmentStartColumn = state.currentLineLength;
    const captureEndColumn = capture.sourceStartColumn + capture.sourceBudget + 1;
    const sliceStart = Math.max(0, capture.sourceStartColumn - segmentStartColumn);
    const sliceEnd = Math.min(segment.length, captureEndColumn - segmentStartColumn);
    if (sliceEnd > sliceStart) {
      // Keep one code unit of lookahead so renderReadWorkspaceFilePage can
      // detect a high surrogate exactly at the page boundary and refuse to
      // emit half of the pair.
      capture.content += segment.slice(sliceStart, sliceEnd);
    }
  }
  state.currentLineLength += segment.length;
  state.sourceOffset += segment.length;
}

function finishReadWorkspaceFileLine(state: ReadWorkspaceFileScanState): void {
  state.lastLine = {
    content: state.currentLinePrefix,
    length: state.currentLineLength,
    line: state.currentLine,
    sourceStartColumn: 0,
  };
  state.lastLineStartOffset = state.currentLineStartOffset;
  if (state.currentLine === state.cursorLine) {
    state.cursorLineLength = state.currentLineLength;
  }
  if (state.currentLine === state.candidateEndLine) {
    state.requestedEndOffset = state.currentLineStartOffset + state.currentLineLength;
  }
  const capture = state.currentCapture;
  if (!capture) {
    return;
  }

  state.scannedLines.push({
    content: capture.content,
    length: state.currentLineLength,
    line: state.currentLine,
    sourceStartColumn: capture.sourceStartColumn,
  });
  const remainderLength = Math.max(0, state.currentLineLength - capture.sourceStartColumn);
  if (remainderLength > capture.sourceBudget || state.currentLine >= state.candidateEndLine) {
    state.captureComplete = true;
    return;
  }
  state.captureRemaining -= capture.overhead + remainderLength;
}

function processReadWorkspaceFileText(state: ReadWorkspaceFileScanState, text: string): void {
  let segmentStart = 0;
  for (let newlineIndex = text.indexOf('\n'); newlineIndex !== -1; ) {
    appendReadWorkspaceFileLineSegment(state, text.slice(segmentStart, newlineIndex));
    finishReadWorkspaceFileLine(state);
    state.sourceOffset += 1;
    state.currentLine += 1;
    state.currentLineLength = 0;
    state.currentLinePrefix = '';
    state.currentLineStartOffset = state.sourceOffset;
    beginReadWorkspaceFileLine(state);
    segmentStart = newlineIndex + 1;
    newlineIndex = text.indexOf('\n', segmentStart);
  }
  appendReadWorkspaceFileLineSegment(state, text.slice(segmentStart));
}

function decodeReadWorkspaceFileText(
  decoder: TextDecoder,
  bytes: Uint8Array | undefined,
  requestedPath: string
): string {
  try {
    return bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        `Path "${requestedPath}" contains malformed UTF-8 and cannot be read as text.`
      );
    }
    throw error;
  }
}

function assertReadWorkspaceFileChunkIsText(
  bytes: Uint8Array,
  byteOffset: number,
  requestedPath: string
): void {
  const binaryProbeEnd = Math.min(bytes.length, Math.max(0, 4096 - byteOffset));
  for (let index = 0; index < binaryProbeEnd; index += 1) {
    if (bytes[index] === 0) {
      throw new Error(`Path "${requestedPath}" is a binary file and cannot be read as text.`);
    }
  }
}

async function scanReadWorkspaceFileHandle(args: {
  readonly handle: Awaited<ReturnType<typeof fsPromises.open>>;
  readonly requestedPath: string;
  readonly size: number;
  readonly state: ReadWorkspaceFileScanState;
}): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const readBuffer = Buffer.allocUnsafe(READ_WORKSPACE_FILE_CHUNK_BYTES);
  beginReadWorkspaceFileLine(args.state);
  let byteOffset = 0;
  while (byteOffset < args.size) {
    const bytesRequested = Math.min(READ_WORKSPACE_FILE_CHUNK_BYTES, args.size - byteOffset);
    const { bytesRead } = await args.handle.read(readBuffer, 0, bytesRequested, byteOffset);
    if (bytesRead === 0) {
      break;
    }
    const bytes = readBuffer.subarray(0, bytesRead);
    assertReadWorkspaceFileChunkIsText(bytes, byteOffset, args.requestedPath);
    processReadWorkspaceFileText(
      args.state,
      decodeReadWorkspaceFileText(decoder, bytes, args.requestedPath)
    );
    byteOffset += bytesRead;
  }
  processReadWorkspaceFileText(
    args.state,
    decodeReadWorkspaceFileText(decoder, undefined, args.requestedPath)
  );
  finishReadWorkspaceFileLine(args.state);
}

async function readWorkspaceFilePageSource(args: {
  readonly absolutePath: string;
  readonly cursor: ReadWorkspaceFileCursorState | null;
  readonly input: ReadWorkspaceFileInput;
  readonly maxChars: number;
  readonly requestedPath: string;
  readonly workspacePath: string;
}): Promise<ReadWorkspaceFileScan> {
  const cursor = args.cursor;
  const candidateStartLine = cursor?.line ?? Math.max(1, args.input.startLine ?? 1);
  const candidateStartColumn = cursor?.column ?? 0;
  const candidateEndLine =
    cursor?.endLine ?? Math.max(candidateStartLine, args.input.endLine ?? Number.MAX_SAFE_INTEGER);
  const handle = await fsPromises.open(args.absolutePath, 'r');

  try {
    const initialStat = await handle.stat();
    if (!initialStat.isFile()) {
      throw new Error(`Path "${args.requestedPath}" is not a file.`);
    }
    if (initialStat.size > MAX_READ_WORKSPACE_FILE_BYTES) {
      throw new Error(
        `Path "${args.requestedPath}" exceeds ${MAX_READ_WORKSPACE_FILE_BYTES} bytes and cannot be read.`
      );
    }

    const state: ReadWorkspaceFileScanState = {
      candidateEndLine,
      candidateStartColumn,
      candidateStartLine,
      captureComplete: false,
      captureRemaining: args.maxChars,
      currentCapture: undefined,
      currentLine: 1,
      currentLineLength: 0,
      currentLinePrefix: '',
      currentLineStartOffset: 0,
      cursorLine: cursor?.line,
      cursorLineLength: undefined,
      lastLine: {
        content: '',
        length: 0,
        line: 1,
        sourceStartColumn: 0,
      },
      lastLineStartOffset: 0,
      lineStartOffsets: new Map<number, number>(),
      maxChars: args.maxChars,
      requestedEndOffset: undefined,
      scannedLines: [],
      sourceOffset: 0,
    };

    await scanReadWorkspaceFileHandle({
      handle,
      requestedPath: args.requestedPath,
      size: initialStat.size,
      state,
    });

    const finalStat = await handle.stat();
    if (finalStat.size !== initialStat.size || finalStat.mtimeMs !== initialStat.mtimeMs) {
      throw new Error(`Path "${args.requestedPath}" changed while it was being read. Retry.`);
    }

    const totalLines = state.currentLine;
    if (!cursor && candidateStartLine > totalLines) {
      state.scannedLines.push(state.lastLine);
      state.lineStartOffsets.set(state.lastLine.line, state.lastLineStartOffset);
    }
    if (state.requestedEndOffset === undefined) {
      state.requestedEndOffset = state.lastLineStartOffset + state.lastLine.length;
    }

    return {
      absolutePath: args.absolutePath,
      cursorLineLength: state.cursorLineLength,
      lineStartOffsets: state.lineStartOffsets,
      lines: state.scannedLines,
      mtimeMs: initialStat.mtimeMs,
      path: args.workspacePath,
      requestedEndOffset: state.requestedEndOffset,
      size: Number(initialStat.size),
      totalLines,
    };
  } finally {
    await handle.close();
  }
}

function requireReadWorkspaceFileCursorScope(
  runtimeData: RuntimeData | undefined,
  executionThreadId?: string
): ReadWorkspaceFileCursorScope {
  const resourceId = runtimeData?.memory?.resourceId;
  const threadId = executionThreadId ?? runtimeData?.memory?.threadId;
  if (!(resourceId?.trim() && threadId?.trim())) {
    throw new Error(
      'readWorkspaceFile continuation handles require a persisted assistant thread and workspace resource.'
    );
  }
  return { resourceId, threadId };
}

export interface ReadWorkspaceFileResult {
  readonly ambiguousRootNames?: string[];
  readonly approxOutputTokens: number;
  readonly content: string;
  readonly dedup?: boolean;
  readonly endLine: number;
  readonly nextCursor: string | null;
  readonly omittedChars: number;
  readonly openRoots?: number;
  readonly path: string;
  readonly rootId: string;
  readonly rootName: string;
  readonly size: number;
  readonly startLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export interface ReadWorkspaceFileLoopGuardOptions {
  readonly domainModelResultCharBudget?: number;
  readonly threadScope: string;
}

function fitReadWorkspaceFileResult(args: {
  readonly buildResult: (page: ReadWorkspaceFilePage) => ReadWorkspaceFileResult;
  readonly effectiveEndLine: number;
  readonly file: ReadWorkspaceFileScan;
  readonly fitsResultBudgets: (result: ReadWorkspaceFileResult) => boolean;
  readonly domainModelResultCharBudget: number;
  readonly maxChars: number;
  readonly startPosition: ReadWorkspaceFilePosition;
}): { readonly page: ReadWorkspaceFilePage; readonly result: ReadWorkspaceFileResult } {
  const requestedPage = renderReadWorkspaceFilePage(
    args.file.lines,
    args.startPosition,
    args.effectiveEndLine,
    args.maxChars
  );
  if (!readWorkspaceFilePageAdvances(requestedPage, args.startPosition)) {
    throw new RangeError(
      'readWorkspaceFile cannot advance the source cursor within maxChars. Increase maxChars.'
    );
  }
  const requestedResult = args.buildResult(requestedPage);
  if (args.fitsResultBudgets(requestedResult)) {
    return { page: requestedPage, result: requestedResult };
  }

  const emptyResult = args.buildResult({
    content: '',
    lastLine: args.startPosition.line,
    nextPosition: args.startPosition,
  });
  if (JSON.stringify(emptyResult).length > NATIVE_TOOL_RESULT_CHAR_BUDGET) {
    throw new RangeError(
      `readWorkspaceFile metadata exceeds the ${NATIVE_TOOL_RESULT_CHAR_BUDGET}-character native result budget`
    );
  }
  if (
    decodedWorkspaceTextModelOutputChars([
      buildReadWorkspaceFileProjectionText(emptyResult).value,
    ]) > args.domainModelResultCharBudget
  ) {
    throw new RangeError(
      `readWorkspaceFile metadata exceeds the ${args.domainModelResultCharBudget}-character model projection budget`
    );
  }

  let low = 1;
  let high = args.maxChars;
  let best: {
    readonly page: ReadWorkspaceFilePage;
    readonly result: ReadWorkspaceFileResult;
  } | null = null;
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const page = renderReadWorkspaceFilePage(
      args.file.lines,
      args.startPosition,
      args.effectiveEndLine,
      kept
    );
    if (!readWorkspaceFilePageAdvances(page, args.startPosition)) {
      low = kept + 1;
      continue;
    }
    const result = args.buildResult(page);
    if (args.fitsResultBudgets(result)) {
      best = { page, result };
      low = kept + 1;
      continue;
    }
    high = kept - 1;
  }
  if (!best) {
    throw new RangeError(
      'readWorkspaceFile cannot fit a line-numbered page inside the model result budget.'
    );
  }
  return best;
}

export function runReadWorkspaceFile(
  input: ReadWorkspaceFileInput,
  runtimeData: RuntimeData | undefined,
  cursorRegistry: ReadWorkspaceFileCursorRegistry | null
): Promise<ReadWorkspaceFileResult>;
export function runReadWorkspaceFile(
  input: ReadWorkspaceFileInput,
  runtimeData: RuntimeData | undefined,
  cursorRegistry: ReadWorkspaceFileCursorRegistry | null,
  loopGuard: ReadWorkspaceFileLoopGuardOptions
): Promise<ReadWorkspaceFileResult | LoopGuardRefusalResult>;
export async function runReadWorkspaceFile(
  input: ReadWorkspaceFileInput,
  runtimeData: RuntimeData | undefined,
  cursorRegistry: ReadWorkspaceFileCursorRegistry | null,
  loopGuard?: ReadWorkspaceFileLoopGuardOptions
): Promise<ReadWorkspaceFileResult | LoopGuardRefusalResult> {
  const domainModelResultCharBudget =
    loopGuard?.domainModelResultCharBudget ?? MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET;
  const cursorScope = input.cursor
    ? requireReadWorkspaceFileCursorScope(runtimeData, loopGuard?.threadScope)
    : null;
  if (input.cursor && !cursorRegistry) {
    throw new Error('readWorkspaceFile continuation handles are unavailable in this read mode.');
  }
  const continuationCursor =
    input.cursor && cursorScope && cursorRegistry
      ? cursorRegistry.resolve(input.cursor, cursorScope)
      : null;
  const root = resolveWorkspaceRoot(
    runtimeData,
    input.root ?? continuationCursor?.rootId ?? undefined
  );
  const requestedPath = continuationCursor?.path ?? input.path;
  if (!requestedPath) {
    throw new Error('readWorkspaceFile requires path when starting a new read.');
  }
  const topology = describeOpenRootTopology(runtimeData);
  // Resolve both before and after acquiring the per-file lock. A symlink can
  // be retargeted while this read waits; only read when both resolutions name
  // the same canonical file so containment and the staleness tracker share
  // one stable identity.
  return withStableWorkspaceFileLock(root.path, requestedPath, async (resolved) => {
    // Inside the lock, against the SAME resolution the read will use, so a
    // symlink retargeted mid-wait cannot land on an excluded file after the
    // check passed (BST-1432).
    await assertNotAgentIgnored({
      canonicalAbsolutePath: resolved.absolutePath,
      canonicalRootPath: root.path,
      relativePath: resolved.workspacePath,
    });
    const maxChars = input.maxChars ?? DEFAULT_FILE_MAX_CHARS;
    const file = await readWorkspaceFilePageSource({
      absolutePath: resolved.absolutePath,
      cursor: continuationCursor,
      input,
      maxChars,
      requestedPath,
      workspacePath: resolved.workspacePath,
    });
    const pageRequest = resolveReadWorkspaceFilePageRequest({
      cursor: continuationCursor,
      cursorLineLength: file.cursorLineLength,
      file,
      input,
      rootId: root.rootId,
      totalLines: file.totalLines,
    });
    const effectiveEndLine = pageRequest.endLine;
    const startPosition = pageRequest.position;
    const startLine = startPosition.line;
    const projectedCursor = 'x'.repeat(READ_WORKSPACE_FILE_CURSOR_HANDLE_LENGTH);
    const buildResult = (page: ReadWorkspaceFilePage): ReadWorkspaceFileResult => ({
      ...topology,
      approxOutputTokens: countTokensHeuristic(page.content),
      content: page.content,
      endLine: page.lastLine,
      nextCursor: page.nextPosition && cursorRegistry ? projectedCursor : null,
      omittedChars: countUnreadSourceChars(
        page.nextPosition,
        file.lineStartOffsets,
        file.requestedEndOffset
      ),
      path: file.path,
      rootId: root.rootId,
      rootName: root.displayName,
      size: file.size,
      startLine,
      totalLines: file.totalLines,
      truncated: page.nextPosition !== null,
    });
    const fitsResultBudgets = (result: ReturnType<typeof buildResult>): boolean =>
      JSON.stringify(result).length <= NATIVE_TOOL_RESULT_CHAR_BUDGET &&
      decodedWorkspaceTextModelOutputChars([buildReadWorkspaceFileProjectionText(result).value]) <=
        domainModelResultCharBudget;
    const finishSuccessfulRead = (
      page: ReadWorkspaceFilePage,
      result: ReturnType<typeof buildResult>
    ): ReturnType<typeof buildResult> => {
      if (input.cursor && cursorRegistry && cursorScope) {
        cursorRegistry.release(input.cursor, cursorScope);
      }
      const nextCursor =
        page.nextPosition && cursorRegistry
          ? cursorRegistry.issue(
              cursorScope ??
                requireReadWorkspaceFileCursorScope(runtimeData, loopGuard?.threadScope),
              {
                column: page.nextPosition.column,
                endLine: effectiveEndLine,
                line: page.nextPosition.line,
                mtimeMs: file.mtimeMs,
                path: file.path,
                requestedEndLine: pageRequest.requestedEndLine,
                requestedStartLine: pageRequest.requestedStartLine,
                rootId: root.rootId,
                size: file.size,
              }
            )
          : null;
      // Only a successfully validated, model-visible page is this scope's
      // fresh observation. A rejected stale cursor must not vouch for changed
      // bytes and thereby disable the later write staleness guard.
      recordKnownFileMtime(
        loopGuard?.threadScope ?? readStateScope(runtimeData),
        file.absolutePath,
        file.mtimeMs
      );
      return { ...result, nextCursor };
    };

    const selected = fitReadWorkspaceFileResult({
      buildResult,
      domainModelResultCharBudget,
      effectiveEndLine,
      file,
      fitsResultBudgets,
      maxChars,
      startPosition,
    });

    // BST-1188 loop guard (report PR #2323 review): checked ONLY after a
    // page has ALREADY been built successfully, and ONLY for a non-truncated
    // page. Checking any earlier — e.g. right after the file scan, before
    // `fitReadWorkspaceFileResult` can still throw (a `maxChars` too small to
    // advance) — would falsely record an observation for a call that never
    // produced a page, priming the model's very next (corrected) retry to
    // look like a repeat of a read that never happened. Skipping a TRUNCATED
    // page keeps the dedup stub from ever discarding the only `nextCursor`
    // pointer to the rest of a large file: the stub always exists rather than
    // resend content, and a partial page is not "the results have not
    // changed" — it is the same partial slice the model would keep needing to
    // page past regardless.
    if (loopGuard && continuationCursor === null && !selected.result.truncated) {
      const unchangedRead = checkUnchangedReadWindow(
        loopGuard.threadScope,
        readWindowKey({
          endLine: input.endLine,
          maxChars,
          path: file.path,
          rootId: root.rootId,
          startLine: input.startLine,
        }),
        file.mtimeMs
      );
      if (unchangedRead.status !== 'fresh') {
        // A deduplicated/refused read still confirms that the model's existing
        // view matches the current file. Preserve that observation so the next
        // edit does not fail the read-before-write staleness guard incorrectly.
        recordKnownFileMtime(loopGuard.threadScope, file.absolutePath, file.mtimeMs);
        if (unchangedRead.status === 'refuse') {
          return buildRepeatedCallRefusalResult(
            NATIVE_TOOL_ID.readWorkspaceFile,
            unchangedRead.count
          );
        }
        return {
          ...topology,
          approxOutputTokens: countTokensHeuristic(UNCHANGED_READ_STUB_MESSAGE),
          content: UNCHANGED_READ_STUB_MESSAGE,
          dedup: true,
          endLine: selected.result.endLine,
          nextCursor: null,
          omittedChars: 0,
          path: file.path,
          rootId: root.rootId,
          rootName: root.displayName,
          size: file.size,
          startLine: selected.result.startLine,
          totalLines: file.totalLines,
          truncated: false,
        };
      }
    }

    return finishSuccessfulRead(selected.page, selected.result);
  });
}
