/**
 * Desktop-main owner for long-lived assistant command sessions.
 *
 * Unlike `executeCommand`, start returns as soon as a PTY is created. Output is
 * retained in a bounded in-memory buffer and addressed with absolute UTF-16
 * cursors, so later callers can resume without duplicate replay. Sessions are
 * scoped to a DB-backed workspace root and never persisted.
 *
 * Privacy boundary: command text, cwd, environment, and raw output are never
 * logged or persisted. Canonical cwd is returned as local session metadata;
 * retained output leaves the service only through an owning-root read.
 */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils/logger';
import type { IPty } from 'node-pty';
import * as pty from 'node-pty';
import treeKill from 'tree-kill';
import { resolveRootCwd, type WorkspaceRootResolver } from '../workspace-root-cwd';
import { resolveShellInvocation } from './execute-command-tool';

const logger = createLogger('CommandSessionManager');

const DEFAULT_BUFFER_CHARS = 2 * 1024 * 1024;
const DEFAULT_EXITED_RETENTION = 25;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 5000;
const PROCESS_EXIT_TIMEOUT_MS = 5000;
const BUFFER_BLOCK_CHARS = 16 * 1024;
const BUFFER_BLOCK_COMPACTION_THRESHOLD = 1024;
const EMPTY_BUFFER = Buffer.alloc(0);

export type CommandSessionErrorCode =
  | 'aborted'
  | 'cursor-out-of-range'
  | 'cwd-not-found'
  | 'cwd-outside-root'
  | 'invalid-input'
  | 'root-unavailable'
  | 'session-exited'
  | 'session-id-collision'
  | 'session-not-found'
  | 'start-failed'
  | 'stop-failed';

export class CommandSessionError extends Error {
  readonly code: CommandSessionErrorCode;

  constructor(code: CommandSessionErrorCode, message: string) {
    super(message);
    this.name = 'CommandSessionError';
    this.code = code;
  }
}

interface CommandSessionBase {
  readonly createdAt: number;
  readonly cwd: string;
  readonly id: string;
  readonly pid: number;
  readonly rootId: string;
}

export interface RunningCommandSession extends CommandSessionBase {
  readonly status: 'running';
}

export interface ExitedCommandSession extends CommandSessionBase {
  readonly exitCode: number;
  readonly exitedAt: number;
  readonly signal: number | null;
  readonly status: 'exited';
}

export type CommandSessionInfo = ExitedCommandSession | RunningCommandSession;

export interface StartCommandSessionInput {
  readonly cols?: number;
  readonly command: string;
  /** Absolute or workspace-relative start directory. */
  readonly cwd?: string;
  readonly rootId: string;
  readonly rows?: number;
  readonly signal?: AbortSignal;
}

export interface CommandSessionRead {
  /** Absolute cursor of the first currently retained code unit. */
  readonly bufferStartCursor: number;
  /** Cursor to pass to the next read. */
  readonly nextCursor: number;
  readonly output: string;
  /** The caller cursor (`-1` means tail), or the retained-buffer start when omitted. */
  readonly requestedCursor: number;
  /** True when requested output was evicted and replay starts at the retained boundary. */
  readonly truncatedBeforeCursor: boolean;
}

type TreeKill = (pid: number, signal: string, callback?: (error?: Error) => void) => void;

interface OutputBufferBlock {
  data: Buffer;
  endChar: number;
  startChar: number;
}

interface SessionEntry {
  abortListener: (() => void) | undefined;
  bufferBlocks: OutputBufferBlock[];
  bufferHeadIndex: number;
  bufferLength: number;
  bufferStartCursor: number;
  exitPromise: Promise<void>;
  info: CommandSessionInfo;
  outputCursor: number;
  process: IPty;
  reaping?: Promise<void>;
  removed: boolean;
  resolveExit: () => void;
  subscriptions: { dispose: () => void }[];
}

export interface CommandSessionManagerOptions {
  /** Maximum retained exited sessions per workspace root. */
  readonly exitedRetention?: number;
  readonly idFactory?: () => string;
  /** Maximum retained UTF-16 code units per session. */
  readonly maxBufferChars?: number;
  /** Maximum wait for a PTY exit acknowledgement after reaping. */
  readonly processExitTimeoutMs?: number;
  readonly resolver: WorkspaceRootResolver;
  readonly spawn?: typeof pty.spawn;
  readonly treeKill?: TreeKill;
}

export interface CommandSessionManager {
  dispose: () => Promise<number>;
  disposeRoot: (rootId: string) => Promise<number>;
  get: (rootId: string, sessionId: string) => CommandSessionInfo;
  list: (rootId: string) => readonly CommandSessionInfo[];
  read: (rootId: string, sessionId: string, cursor?: number) => CommandSessionRead;
  remove: (rootId: string, sessionId: string) => Promise<void>;
  start: (input: StartCommandSessionInput) => Promise<RunningCommandSession>;
  stop: (rootId: string, sessionId: string) => Promise<void>;
  write: (rootId: string, sessionId: string, data: string) => void;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CommandSessionError('invalid-input', `${name} must be a positive safe integer.`);
  }
  return value;
}

function viewportDimension(value: number | undefined, fallback: number, name: string): number {
  const dimension = positiveInteger(value, fallback, name);
  if (dimension > MAX_DIMENSION) {
    throw new CommandSessionError('invalid-input', `${name} must not exceed ${MAX_DIMENSION}.`);
  }
  return dimension;
}

function assertRootId(rootId: unknown): asserts rootId is string {
  if (typeof rootId !== 'string' || rootId.trim().length === 0) {
    throw new CommandSessionError('invalid-input', 'Command sessions require a non-empty rootId.');
  }
}

async function resolveSessionCwd(
  resolver: WorkspaceRootResolver,
  rootId: string,
  requestedCwd: string | undefined
): Promise<string> {
  const root = await resolveRootCwd(resolver, rootId, 'command session', logger);
  if (!root.ok) {
    throw new CommandSessionError('root-unavailable', root.error);
  }
  if (requestedCwd === undefined || requestedCwd.trim().length === 0) {
    return root.value;
  }

  const absoluteCwd = path.isAbsolute(requestedCwd)
    ? requestedCwd
    : path.resolve(root.value, requestedCwd);
  let canonicalCwd: string;
  try {
    canonicalCwd = await fsPromises.realpath(absoluteCwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CommandSessionError('cwd-not-found', 'The command session cwd does not exist.');
    }
    throw error;
  }

  const relative = path.relative(root.value, canonicalCwd);
  const isWithinRoot =
    canonicalCwd === root.value ||
    (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative));
  if (!isWithinRoot) {
    throw new CommandSessionError(
      'cwd-outside-root',
      'The command session cwd resolves outside its workspace root.'
    );
  }
  return canonicalCwd;
}

function publicInfo(info: CommandSessionInfo): CommandSessionInfo {
  return { ...info };
}

function disposeSubscriptions(entry: SessionEntry): void {
  for (const subscription of entry.subscriptions.splice(0)) {
    subscription.dispose();
  }
}

function killCommandSessionProcessGroup(entry: SessionEntry): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    process.kill(-entry.info.pid, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') {
      return;
    }
    logger.warn('Command session process-group kill failed', {
      code,
      pid: entry.info.pid,
      sessionId: entry.info.id,
    });
  }
}

function killCommandSessionPty(entry: SessionEntry): void {
  try {
    entry.process.kill();
  } catch (error) {
    logger.debug('Command session pty kill raced with process exit', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      sessionId: entry.info.id,
    });
  }
}

export function createCommandSessionManager({
  exitedRetention: configuredExitedRetention,
  idFactory = () => `command-session-${randomUUID()}`,
  maxBufferChars: configuredMaxBufferChars,
  processExitTimeoutMs: configuredProcessExitTimeoutMs,
  resolver,
  spawn = pty.spawn,
  treeKill: killTree = treeKill,
}: CommandSessionManagerOptions): CommandSessionManager {
  const maxBufferChars = positiveInteger(
    configuredMaxBufferChars,
    DEFAULT_BUFFER_CHARS,
    'maxBufferChars'
  );
  const exitedRetention = positiveInteger(
    configuredExitedRetention,
    DEFAULT_EXITED_RETENTION,
    'exitedRetention'
  );
  const processExitTimeoutMs = positiveInteger(
    configuredProcessExitTimeoutMs,
    PROCESS_EXIT_TIMEOUT_MS,
    'processExitTimeoutMs'
  );
  const sessions = new Map<string, SessionEntry>();

  function resolveOwned(rootId: string, sessionId: string): SessionEntry {
    assertRootId(rootId);
    const entry = sessions.get(sessionId);
    if (!entry || entry.info.rootId !== rootId.trim()) {
      throw new CommandSessionError('session-not-found', `No command session "${sessionId}".`);
    }
    return entry;
  }

  function trimExitedSessions(rootId: string): void {
    const exited = Array.from(sessions.values()).filter(
      (entry): entry is SessionEntry & { info: ExitedCommandSession } =>
        entry.info.rootId === rootId && entry.info.status === 'exited'
    );
    const excess = exited.length - exitedRetention;
    if (excess <= 0) {
      return;
    }
    exited
      .sort((left, right) =>
        left.info.exitedAt === right.info.exitedAt
          ? left.info.createdAt - right.info.createdAt
          : left.info.exitedAt - right.info.exitedAt
      )
      .slice(0, excess)
      .forEach((entry) => {
        entry.removed = true;
        disposeSubscriptions(entry);
        sessions.delete(entry.info.id);
      });
  }

  function evictOutputBufferOverflow(entry: SessionEntry, initialOverflow: number): void {
    let overflow = initialOverflow;
    while (overflow > 0) {
      const head = entry.bufferBlocks[entry.bufferHeadIndex];
      if (head === undefined) {
        throw new TypeError('Command-session output buffer lost its retained head block.');
      }
      const retainedLength = head.endChar - head.startChar;
      if (retainedLength > overflow) {
        head.startChar += overflow;
        overflow = 0;
        break;
      }
      overflow -= retainedLength;
      head.data = EMPTY_BUFFER;
      head.startChar = 0;
      head.endChar = 0;
      entry.bufferHeadIndex += 1;
    }
    if (
      entry.bufferHeadIndex >= BUFFER_BLOCK_COMPACTION_THRESHOLD ||
      entry.bufferHeadIndex * 2 >= entry.bufferBlocks.length
    ) {
      entry.bufferBlocks = entry.bufferBlocks.slice(entry.bufferHeadIndex);
      entry.bufferHeadIndex = 0;
    }
  }

  function appendOutputBufferBlocks(entry: SessionEntry, chunk: string): void {
    const blockChars = Math.min(BUFFER_BLOCK_CHARS, maxBufferChars);
    let sourceOffset = 0;
    while (sourceOffset < chunk.length) {
      const tailIndex = entry.bufferBlocks.length - 1;
      let tail = tailIndex >= entry.bufferHeadIndex ? entry.bufferBlocks[tailIndex] : undefined;
      if (tail === undefined || tail.endChar === blockChars) {
        tail = {
          data: Buffer.allocUnsafe(blockChars * 2),
          endChar: 0,
          startChar: 0,
        };
        entry.bufferBlocks.push(tail);
      }
      const writeLength = Math.min(blockChars - tail.endChar, chunk.length - sourceOffset);
      const segment =
        sourceOffset === 0 && writeLength === chunk.length
          ? chunk
          : chunk.slice(sourceOffset, sourceOffset + writeLength);
      const bytesWritten = tail.data.write(segment, tail.endChar * 2, writeLength * 2, 'utf16le');
      if (bytesWritten !== writeLength * 2) {
        throw new TypeError(
          'Command-session output buffer did not copy a complete UTF-16 segment.'
        );
      }
      tail.endChar += writeLength;
      sourceOffset += writeLength;
    }
  }

  function copyUtf16Suffix(value: string, length: number): Buffer {
    const suffix = value.slice(value.length - length);
    return Buffer.from(suffix, 'utf16le');
  }

  function appendOutput(entry: SessionEntry, chunk: string): void {
    if (entry.removed || chunk.length === 0) {
      return;
    }
    entry.outputCursor += chunk.length;
    if (chunk.length >= maxBufferChars) {
      const retained =
        chunk.length === maxBufferChars
          ? Buffer.from(chunk, 'utf16le')
          : copyUtf16Suffix(chunk, maxBufferChars);
      entry.bufferBlocks = [
        {
          data: retained,
          endChar: maxBufferChars,
          startChar: 0,
        },
      ];
      entry.bufferHeadIndex = 0;
      entry.bufferLength = maxBufferChars;
      entry.bufferStartCursor = entry.outputCursor - maxBufferChars;
      return;
    }

    appendOutputBufferBlocks(entry, chunk);
    entry.bufferLength += chunk.length;
    const overflow = entry.bufferLength - maxBufferChars;
    if (overflow <= 0) {
      return;
    }
    entry.bufferLength -= overflow;
    entry.bufferStartCursor += overflow;
    evictOutputBufferOverflow(entry, overflow);
  }

  function collectBufferedOutputChunks(entry: SessionEntry, offset: number): string[] {
    let remainingOffset = offset;
    const outputChunks: string[] = [];
    for (let index = entry.bufferHeadIndex; index < entry.bufferBlocks.length; index += 1) {
      const block = entry.bufferBlocks[index];
      if (block === undefined) {
        throw new TypeError('Command-session output buffer contains a missing block.');
      }
      const retainedLength = block.endChar - block.startChar;
      if (remainingOffset >= retainedLength) {
        remainingOffset -= retainedLength;
        continue;
      }
      const readStartChar = block.startChar + remainingOffset;
      outputChunks.push(block.data.toString('utf16le', readStartChar * 2, block.endChar * 2));
      remainingOffset = 0;
    }
    if (remainingOffset !== 0) {
      throw new TypeError('Command-session output buffer is shorter than its retained length.');
    }
    return outputChunks;
  }

  function readBufferedOutput(entry: SessionEntry, offset: number): string {
    if (offset === entry.bufferLength) {
      return '';
    }
    if (offset < 0 || offset > entry.bufferLength) {
      throw new TypeError('Command-session read offset is outside the retained output buffer.');
    }

    const outputChunks = collectBufferedOutputChunks(entry, offset);
    if (outputChunks.length === 1) {
      return outputChunks[0] ?? '';
    }
    return outputChunks.join('');
  }

  function recordExit(entry: SessionEntry, exitCode: number, signal?: number): void {
    if (entry.info.status === 'exited') {
      return;
    }
    entry.info = {
      ...entry.info,
      exitCode,
      exitedAt: Date.now(),
      signal: typeof signal === 'number' ? signal : null,
      status: 'exited',
    };
    entry.resolveExit();
    entry.abortListener?.();
    entry.abortListener = undefined;
    disposeSubscriptions(entry);
    if (entry.removed) {
      return;
    }
    trimExitedSessions(entry.info.rootId);
    logger.info('Command session exited', {
      exitCode,
      rootId: entry.info.rootId,
      sessionId: entry.info.id,
      signal: signal ?? null,
    });
  }

  function reap(entry: SessionEntry): Promise<void> {
    if (entry.reaping) {
      return entry.reaping;
    }
    entry.reaping = new Promise((resolve) => {
      killTree(entry.info.pid, 'SIGKILL', (error) => {
        if (error && !/no such process/i.test(error.message)) {
          logger.warn('Command session tree-kill failed', {
            errorCode: (error as NodeJS.ErrnoException).code,
            pid: entry.info.pid,
            sessionId: entry.info.id,
          });
        }
        killCommandSessionProcessGroup(entry);
        killCommandSessionPty(entry);
        resolve();
      });
    });
    return entry.reaping;
  }

  async function waitForExit(entry: SessionEntry): Promise<void> {
    if (entry.info.status === 'exited') {
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        entry.exitPromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new CommandSessionError(
                'stop-failed',
                `Command session "${entry.info.id}" did not report exit within ${processExitTimeoutMs}ms.`
              )
            );
          }, processExitTimeoutMs);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async function start(input: StartCommandSessionInput): Promise<RunningCommandSession> {
    assertRootId(input?.rootId);
    if (typeof input.command !== 'string' || input.command.trim().length === 0) {
      throw new CommandSessionError('invalid-input', 'Command must be a non-empty string.');
    }
    if (input.signal?.aborted) {
      throw new CommandSessionError('aborted', 'Command session start was aborted.');
    }

    const rootId = input.rootId.trim();
    const cwd = await resolveSessionCwd(resolver, rootId, input.cwd);
    if (input.signal?.aborted) {
      throw new CommandSessionError('aborted', 'Command session start was aborted.');
    }
    const cols = viewportDimension(input.cols, DEFAULT_COLS, 'cols');
    const rows = viewportDimension(input.rows, DEFAULT_ROWS, 'rows');
    const id = idFactory();
    if (sessions.has(id)) {
      throw new CommandSessionError('session-id-collision', 'Command session id collision.');
    }
    const invocation = resolveShellInvocation(input.command);

    let processHandle: IPty;
    try {
      processHandle = spawn(invocation.shell, invocation.args, {
        cols,
        cwd,
        // biome-ignore lint/style/useNamingConvention: TERM is a standard environment variable.
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
        name: 'xterm-256color',
        rows,
      });
    } catch (error) {
      logger.error('Failed to start command session', { rootId, sessionId: id });
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandSessionError('start-failed', `Failed to start command session: ${message}`);
    }

    const info: RunningCommandSession = {
      createdAt: Date.now(),
      cwd,
      id,
      pid: processHandle.pid,
      rootId,
      status: 'running',
    };
    let resolveExit = () => {
      // Replaced synchronously by the promise constructor below.
    };
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const entry: SessionEntry = {
      abortListener: undefined,
      bufferBlocks: [],
      bufferHeadIndex: 0,
      bufferLength: 0,
      bufferStartCursor: 0,
      exitPromise,
      info,
      outputCursor: 0,
      process: processHandle,
      removed: false,
      resolveExit,
      subscriptions: [],
    };
    sessions.set(id, entry);
    entry.subscriptions.push(
      processHandle.onData((chunk) => appendOutput(entry, chunk)),
      processHandle.onExit(({ exitCode, signal }) => recordExit(entry, exitCode, signal))
    );

    if (input.signal) {
      const abort = () => {
        void stop(rootId, id).catch((error: unknown) => {
          if (error instanceof CommandSessionError && error.code === 'session-exited') {
            return;
          }
          logger.warn('Failed to stop aborted command session', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
            rootId,
            sessionId: id,
          });
        });
      };
      entry.abortListener = () => input.signal?.removeEventListener('abort', abort);
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) {
        await remove(rootId, id);
        throw new CommandSessionError('aborted', 'Command session start was aborted.');
      }
    }

    logger.info('Started command session', { rootId, sessionId: id });
    return publicInfo(info) as RunningCommandSession;
  }

  function list(rootId: string): readonly CommandSessionInfo[] {
    assertRootId(rootId);
    const trimmed = rootId.trim();
    return Array.from(sessions.values())
      .filter((entry) => entry.info.rootId === trimmed)
      .map((entry) => publicInfo(entry.info));
  }

  function get(rootId: string, sessionId: string): CommandSessionInfo {
    return publicInfo(resolveOwned(rootId, sessionId).info);
  }

  function read(rootId: string, sessionId: string, cursor?: number): CommandSessionRead {
    const entry = resolveOwned(rootId, sessionId);
    const requestedCursor = cursor ?? entry.bufferStartCursor;
    if (requestedCursor === -1) {
      return {
        bufferStartCursor: entry.bufferStartCursor,
        nextCursor: entry.outputCursor,
        output: '',
        requestedCursor,
        truncatedBeforeCursor: false,
      };
    }
    if (!Number.isSafeInteger(requestedCursor) || requestedCursor < 0) {
      throw new CommandSessionError(
        'cursor-out-of-range',
        'Command session cursor must be a non-negative safe integer.'
      );
    }
    if (requestedCursor > entry.outputCursor) {
      throw new CommandSessionError(
        'cursor-out-of-range',
        `Command session cursor ${requestedCursor} is beyond output cursor ${entry.outputCursor}.`
      );
    }
    const truncatedBeforeCursor = requestedCursor < entry.bufferStartCursor;
    const replayCursor = Math.max(requestedCursor, entry.bufferStartCursor);
    return {
      bufferStartCursor: entry.bufferStartCursor,
      nextCursor: entry.outputCursor,
      output: readBufferedOutput(entry, replayCursor - entry.bufferStartCursor),
      requestedCursor,
      truncatedBeforeCursor,
    };
  }

  function write(rootId: string, sessionId: string, data: string): void {
    const entry = resolveOwned(rootId, sessionId);
    if (entry.info.status === 'exited') {
      throw new CommandSessionError('session-exited', `Command session "${sessionId}" has exited.`);
    }
    if (typeof data !== 'string') {
      throw new CommandSessionError('invalid-input', 'Command session input must be a string.');
    }
    entry.process.write(data);
  }

  async function stop(rootId: string, sessionId: string): Promise<void> {
    const entry = resolveOwned(rootId, sessionId);
    if (entry.info.status === 'exited') {
      throw new CommandSessionError('session-exited', `Command session "${sessionId}" has exited.`);
    }
    await reap(entry);
    await waitForExit(entry);
  }

  async function remove(rootId: string, sessionId: string): Promise<void> {
    const entry = resolveOwned(rootId, sessionId);
    entry.removed = true;
    sessions.delete(sessionId);
    entry.abortListener?.();
    if (entry.info.status === 'running') {
      await reap(entry);
      await waitForExit(entry);
      return;
    }
    disposeSubscriptions(entry);
  }

  async function disposeRoot(rootId: string): Promise<number> {
    assertRootId(rootId);
    const trimmed = rootId.trim();
    const owned = Array.from(sessions.entries()).filter(
      ([, entry]) => entry.info.rootId === trimmed
    );
    const running = owned.filter(([, entry]) => entry.info.status === 'running');
    for (const [id, entry] of owned) {
      entry.removed = true;
      sessions.delete(id);
      entry.abortListener?.();
      if (entry.info.status === 'exited') {
        disposeSubscriptions(entry);
      }
    }
    const results = await Promise.allSettled(
      running.map(async ([, entry]) => {
        await reap(entry);
        await waitForExit(entry);
      })
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        return;
      }
      const entry = running[index]?.[1];
      if (entry) {
        disposeSubscriptions(entry);
      }
      logger.error('Command session did not finish disposal for workspace root', {
        errorName: result.reason instanceof Error ? result.reason.name : 'UnknownError',
        rootId: trimmed,
        sessionId: entry?.info.id,
      });
    });
    if (running.length > 0) {
      logger.info('Reaped command sessions for workspace root', {
        count: running.length,
        rootId: trimmed,
      });
    }
    return running.length;
  }

  async function dispose(): Promise<number> {
    const entries = Array.from(sessions.values());
    const running = entries.filter((entry) => entry.info.status === 'running');
    sessions.clear();
    for (const entry of entries) {
      entry.removed = true;
      entry.abortListener?.();
      if (entry.info.status === 'exited') {
        disposeSubscriptions(entry);
      }
    }
    const results = await Promise.allSettled(
      running.map(async (entry) => {
        await reap(entry);
        await waitForExit(entry);
      })
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        return;
      }
      const entry = running[index];
      if (entry) {
        disposeSubscriptions(entry);
      }
      logger.error('Command session did not finish disposal', {
        errorName: result.reason instanceof Error ? result.reason.name : 'UnknownError',
        sessionId: entry?.info.id,
      });
    });
    if (running.length > 0) {
      logger.info('Reaped command sessions on dispose', { count: running.length });
    }
    return running.length;
  }

  return { dispose, disposeRoot, get, list, read, remove, start, stop, write };
}

let desktopCommandSessionManager: CommandSessionManager | null = null;

/** Configure the process-wide manager once, before assistant requests are served. */
export function configureDesktopCommandSessionManager(
  options: CommandSessionManagerOptions
): CommandSessionManager {
  if (desktopCommandSessionManager) {
    throw new CommandSessionError(
      'invalid-input',
      'Desktop command session manager is already configured.'
    );
  }
  desktopCommandSessionManager = createCommandSessionManager(options);
  return desktopCommandSessionManager;
}

/** Application-layer access for the native-tool and inventory slices. */
export function getDesktopCommandSessionManager(): CommandSessionManager {
  if (!desktopCommandSessionManager) {
    throw new CommandSessionError(
      'invalid-input',
      'Desktop command session manager has not been configured.'
    );
  }
  return desktopCommandSessionManager;
}

/** Lifecycle-safe no-op before configuration; otherwise reap every running session. */
export async function disposeDesktopCommandSessions(): Promise<number> {
  if (!desktopCommandSessionManager) {
    return 0;
  }
  return await desktopCommandSessionManager.dispose();
}

/** Reap and forget sessions for a workspace root as it is disconnected. */
export async function disposeDesktopCommandSessionsForRoot(rootId: string): Promise<number> {
  if (!desktopCommandSessionManager) {
    return 0;
  }
  return await desktopCommandSessionManager.disposeRoot(rootId);
}
