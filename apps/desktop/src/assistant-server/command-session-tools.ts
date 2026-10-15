import type {
  InspectCommandSessionsInput,
  ManageCommandSessionInput,
  RuntimeData,
} from '@brainstrike/agent';
import {
  normalizeInspectCommandSessionsInput,
  normalizeManageCommandSessionInput,
} from '@brainstrike/agent';
import {
  type GuardedToolError,
  isGuardedToolError,
  ToolInputError,
} from '@brainstrike/assistant-contract';
import {
  COMMAND_SESSION_READ_PAGE_UTF16_CODE_UNITS,
  CommandSessionError,
  type CommandSessionInfo,
  type CommandSessionManager,
  type CommandSessionRead,
  type ExitedCommandSession,
  getDesktopCommandSessionManager,
  type RunningCommandSession,
} from './command-session-manager';
import { resolveWorkspaceRoot } from './workspace-roots';

export interface CommandSessionToolDependencies {
  readonly manager?: CommandSessionManager;
  /** Start sessions in the run's own admitted roots rather than the manager's resolver. */
  readonly rootsFromRuntime?: boolean;
}

type InspectCommandSessionsResult =
  | (Omit<CommandSessionRead, 'nextCursor'> & {
      readonly availableEndCursor: number;
      readonly nextCursor: number;
      readonly remainingUtf16CodeUnits: number;
      readonly session: CommandSessionInfo;
    })
  | {
      readonly nextOffset?: number;
      readonly offset: number;
      readonly rootId: string;
      readonly sessions: readonly CommandSessionInfo[];
      readonly totalSessions: number;
      readonly truncated: boolean;
    };

type ManageCommandSessionResult =
  | CommandSessionInfo
  | { readonly id: string; readonly removed: true; readonly rootId: string }
  | { readonly session: CommandSessionInfo; readonly writtenUtf16CodeUnits: number };

export const COMMAND_SESSION_TOOL_RESULT_MAX_UTF8_BYTES = 5500;
const UTF8_ENCODER = new TextEncoder();

type CommandSessionTranscriptInfo =
  | Omit<ExitedCommandSession, 'cwd'>
  | Omit<RunningCommandSession, 'cwd'>;

type CommandSessionTransformPhase =
  | 'approval'
  | 'error'
  | 'input-available'
  | 'input-delta'
  | 'output-available'
  | 'resume'
  | 'suspend';

interface CommandSessionTransformContext {
  readonly error?: unknown;
  readonly input?: unknown;
  readonly inputTextDelta?: string;
  readonly output?: unknown;
  readonly phase: CommandSessionTransformPhase;
  readonly resumeData?: unknown;
  readonly suspendPayload?: unknown;
  readonly target: 'display' | 'transcript';
  readonly toolCallId: string;
  readonly toolName: string;
}

type CommandSessionTransformFunction = (
  context: CommandSessionTransformContext
) => Promise<unknown> | unknown;

export interface CommandSessionPayloadTransformTarget {
  readonly approval?: CommandSessionTransformFunction;
  readonly error?: CommandSessionTransformFunction;
  readonly input?: CommandSessionTransformFunction;
  readonly inputDelta?: CommandSessionTransformFunction;
  readonly output?: CommandSessionTransformFunction;
  readonly resume?: CommandSessionTransformFunction;
  readonly suspend?: CommandSessionTransformFunction;
}

export interface CommandSessionPayloadTransform {
  readonly transcript: CommandSessionPayloadTransformTarget;
}

function serializedUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Command-session tool result could not be serialized.');
  }
  return UTF8_ENCODER.encode(serialized).byteLength;
}

function buildSessionListPage(
  rootId: string,
  sessions: readonly CommandSessionInfo[],
  offset: number,
  endOffset: number
): Extract<InspectCommandSessionsResult, { readonly sessions: readonly CommandSessionInfo[] }> {
  const truncated = endOffset < sessions.length;
  return {
    ...(truncated ? { nextOffset: endOffset } : {}),
    offset,
    rootId,
    sessions: sessions.slice(offset, endOffset),
    totalSessions: sessions.length,
    truncated,
  };
}

function fitSessionListPage(
  rootId: string,
  sessions: readonly CommandSessionInfo[],
  offset: number
): Extract<InspectCommandSessionsResult, { readonly sessions: readonly CommandSessionInfo[] }> {
  if (offset > sessions.length) {
    throw new RangeError(
      `Command-session list offset ${offset} exceeds the session count ${sessions.length}.`
    );
  }
  let endOffset = offset;
  while (endOffset < sessions.length) {
    const candidate = buildSessionListPage(rootId, sessions, offset, endOffset + 1);
    if (serializedUtf8Bytes(candidate) > COMMAND_SESSION_TOOL_RESULT_MAX_UTF8_BYTES) {
      break;
    }
    endOffset += 1;
  }
  const page = buildSessionListPage(rootId, sessions, offset, endOffset);
  if (endOffset === offset && offset < sessions.length) {
    throw new TypeError('One command-session inventory entry exceeds the tool result byte budget.');
  }
  return page;
}

function safeUtf16PrefixLength(value: string, requestedLength: number): number {
  if (requestedLength <= 0 || requestedLength >= value.length) {
    return Math.max(0, Math.min(requestedLength, value.length));
  }
  const previous = value.charCodeAt(requestedLength - 1);
  const next = value.charCodeAt(requestedLength);
  if (previous >= 0xd8_00 && previous <= 0xdb_ff && next >= 0xdc_00 && next <= 0xdf_ff) {
    return requestedLength - 1;
  }
  return requestedLength;
}

function buildSessionReadPage(
  read: CommandSessionRead,
  session: CommandSessionInfo,
  outputLength: number
): Extract<InspectCommandSessionsResult, { readonly session: CommandSessionInfo }> {
  const availableEndCursor = read.nextCursor;
  const replayStartCursor =
    read.requestedCursor === -1
      ? availableEndCursor
      : Math.max(read.requestedCursor, read.bufferStartCursor);
  if (read.output.length !== availableEndCursor - replayStartCursor) {
    throw new TypeError('Command-session read cursors are incoherent with the returned output.');
  }
  const safeOutputLength = safeUtf16PrefixLength(read.output, outputLength);
  const nextCursor = replayStartCursor + safeOutputLength;
  return {
    ...read,
    availableEndCursor,
    hasMore: read.hasMore || safeOutputLength < read.output.length,
    nextCursor,
    output: read.output.slice(0, safeOutputLength),
    remainingUtf16CodeUnits: availableEndCursor - nextCursor,
    session,
  };
}

function fitSessionReadPage(
  read: CommandSessionRead,
  session: CommandSessionInfo
): Extract<InspectCommandSessionsResult, { readonly session: CommandSessionInfo }> {
  const complete = buildSessionReadPage(read, session, read.output.length);
  if (serializedUtf8Bytes(complete) <= COMMAND_SESSION_TOOL_RESULT_MAX_UTF8_BYTES) {
    return complete;
  }
  let acceptedLength = 0;
  let low = 1;
  let high = read.output.length;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const safeLength = safeUtf16PrefixLength(read.output, midpoint);
    const candidate = buildSessionReadPage(read, session, safeLength);
    if (serializedUtf8Bytes(candidate) <= COMMAND_SESSION_TOOL_RESULT_MAX_UTF8_BYTES) {
      acceptedLength = Math.max(acceptedLength, safeLength);
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  if (acceptedLength === 0 && read.output.length > 0) {
    throw new TypeError('Command-session read metadata exceeds the tool result byte budget.');
  }
  return buildSessionReadPage(read, session, acceptedLength);
}

function transcriptSessionInfo(info: CommandSessionInfo): CommandSessionTranscriptInfo {
  const common = {
    createdAt: info.createdAt,
    id: info.id,
    pid: info.pid,
    rootId: info.rootId,
  };
  if (info.status === 'running') {
    return { ...common, status: info.status };
  }
  return {
    ...common,
    exitCode: info.exitCode,
    exitedAt: info.exitedAt,
    signal: info.signal,
    status: info.status,
  };
}

function projectInspectInputForTranscript(input: unknown): InspectCommandSessionsInput | undefined {
  return input === undefined ? undefined : normalizeInspectCommandSessionsInput(input);
}

function projectGuardedErrorForTranscript(output: GuardedToolError): GuardedToolError {
  return {
    error: {
      code: output.error.code,
      message: 'Command-session tool failure details redacted.',
      toolName: output.error.toolName,
    },
    ok: false,
  };
}

function projectManageInputForTranscript(input: unknown): unknown {
  if (input === undefined) {
    return;
  }
  const parsed = normalizeManageCommandSessionInput(input);
  const operation = parsed.operation;
  if (operation.action === 'start') {
    return {
      operation: {
        action: operation.action,
        ...(operation.cols === undefined ? {} : { cols: operation.cols }),
        commandUtf16CodeUnits: operation.command.length,
        redactedFields: operation.cwd === undefined ? ['command'] : ['command', 'cwd'],
        ...(operation.rows === undefined ? {} : { rows: operation.rows }),
      },
      ...(parsed.root === undefined ? {} : { root: parsed.root }),
    };
  }
  if (operation.action === 'write') {
    return {
      operation: {
        action: operation.action,
        redactedFields: ['data'],
        sessionId: operation.sessionId,
        writtenUtf16CodeUnits: operation.data.length,
      },
      ...(parsed.root === undefined ? {} : { root: parsed.root }),
    };
  }
  return parsed;
}

function projectInspectOutputForTranscript(output: unknown): unknown {
  if (isGuardedToolError(output)) {
    return projectGuardedErrorForTranscript(output);
  }
  const result = output as InspectCommandSessionsResult;
  if ('sessions' in result) {
    return { ...result, sessions: result.sessions.map(transcriptSessionInfo) };
  }
  const { output: sensitiveOutput, ...metadata } = result;
  return {
    ...metadata,
    outputRedacted: true,
    outputUtf16CodeUnits: sensitiveOutput.length,
    session: transcriptSessionInfo(result.session),
  };
}

function projectManageOutputForTranscript(output: unknown): unknown {
  if (isGuardedToolError(output)) {
    return projectGuardedErrorForTranscript(output);
  }
  const result = output as ManageCommandSessionResult;
  if ('removed' in result) {
    return result;
  }
  if ('session' in result) {
    return { ...result, session: transcriptSessionInfo(result.session) };
  }
  return transcriptSessionInfo(result);
}

function projectErrorForTranscript(context: CommandSessionTransformContext): unknown {
  const error = context.error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return {
    ...(typeof code === 'number' || typeof code === 'string' ? { code } : {}),
    name: error instanceof Error ? error.name : typeof error,
    redacted: true,
  };
}

function commandSessionTranscriptTarget(
  projectInput: (input: unknown) => unknown,
  projectOutput: (output: unknown) => unknown
): CommandSessionPayloadTransformTarget {
  return {
    approval: (context) => projectInput(context.input),
    error: projectErrorForTranscript,
    input: (context) => projectInput(context.input),
    inputDelta: () => '[command-session input redacted]',
    output: (context) => projectOutput(context.output),
    resume: (context) => context.resumeData,
    suspend: (context) => context.suspendPayload,
  };
}

export const INSPECT_COMMAND_SESSIONS_TRANSFORM: CommandSessionPayloadTransform = {
  transcript: commandSessionTranscriptTarget(
    projectInspectInputForTranscript,
    projectInspectOutputForTranscript
  ),
};

export const MANAGE_COMMAND_SESSION_TRANSFORM: CommandSessionPayloadTransform = {
  transcript: commandSessionTranscriptTarget(
    projectManageInputForTranscript,
    projectManageOutputForTranscript
  ),
};

function resolveManager(dependencies: CommandSessionToolDependencies): CommandSessionManager {
  return dependencies.manager ?? getDesktopCommandSessionManager();
}

function resolveRootId(runtimeData: RuntimeData | undefined, root: string | undefined): string {
  return resolveWorkspaceRoot(runtimeData, root).rootId;
}

function unsupportedOperation(operation: never): never {
  throw new Error(`Unsupported command-session action: ${JSON.stringify(operation)}`);
}

export function runInspectCommandSessions(
  input: InspectCommandSessionsInput,
  runtimeData: RuntimeData | undefined,
  dependencies: CommandSessionToolDependencies = {}
): InspectCommandSessionsResult {
  const manager = resolveManager(dependencies);
  const rootId = resolveRootId(runtimeData, input.root);
  if (input.operation.action === 'list') {
    // Offsets are best-effort over the live, mutable in-memory session inventory.
    return fitSessionListPage(rootId, manager.list(rootId), input.operation.offset ?? 0);
  }
  const read = manager.read(
    rootId,
    input.operation.sessionId,
    input.operation.cursor,
    COMMAND_SESSION_READ_PAGE_UTF16_CODE_UNITS
  );
  return fitSessionReadPage(read, manager.get(rootId, input.operation.sessionId));
}

export async function runManageCommandSession(
  input: ManageCommandSessionInput,
  runtimeData: RuntimeData | undefined,
  dependencies: CommandSessionToolDependencies & {
    readonly signal?: AbortSignal;
    readonly executionThreadId?: string | undefined;
  } = {}
): Promise<ManageCommandSessionResult> {
  const manager = resolveManager(dependencies);
  const rootId = resolveRootId(runtimeData, input.root);
  const operation = input.operation;
  if (operation.action === 'start') {
    if (dependencies.executionThreadId && !runtimeData?.memory?.threadId) {
      throw new ToolInputError(
        'Command session execution requires its originating conversation identity.'
      );
    }
    return await manager
      .start({
        command: operation.command,
        ...(dependencies.rootsFromRuntime
          ? { resolver: { listRoots: async () => runtimeData?.workspaceRoots ?? [] } }
          : {}),
        rootId,
        ...(dependencies.executionThreadId &&
        dependencies.executionThreadId !== runtimeData?.memory?.threadId
          ? { delegatedThreadId: dependencies.executionThreadId }
          : {}),
        ...(operation.cols === undefined ? {} : { cols: operation.cols }),
        ...(operation.cwd === undefined ? {} : { cwd: operation.cwd }),
        ...(operation.rows === undefined ? {} : { rows: operation.rows }),
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      })
      .catch((error: unknown) => {
        if (
          error instanceof CommandSessionError &&
          (error.code === 'workspace-busy' || error.code === 'aborted')
        ) {
          throw new ToolInputError(error.message);
        }
        throw error;
      });
  }
  if (operation.action === 'write') {
    manager.write(rootId, operation.sessionId, operation.data);
    return {
      session: manager.get(rootId, operation.sessionId),
      writtenUtf16CodeUnits: operation.data.length,
    };
  }
  if (operation.action === 'stop') {
    await manager.stop(rootId, operation.sessionId);
    return manager.get(rootId, operation.sessionId);
  }
  if (operation.action === 'remove') {
    await manager.remove(rootId, operation.sessionId);
    return { id: operation.sessionId, removed: true as const, rootId };
  }
  return unsupportedOperation(operation);
}
