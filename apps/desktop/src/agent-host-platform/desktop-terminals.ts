/**
 * ADR-0029 stage 3: the Terminal panel's backend in the agent host — a PTY per
 * terminal (node-pty) and the inventory of the command sessions this host's
 * runs start. This module owns the security-critical seam and the process
 * lifecycle:
 *
 * 1. cwd is PINNED + VALIDATED.
 *    `terminal/create` takes a client-supplied `rootId` that is resolved +
 *    containment-checked against the host's workspace roots (the SAME source
 *    the git / read / search tools use), then canonicalized via `realpath`. An
 *    optional `cwd` narrows the spawn to a SUBDIRECTORY of that root — also
 *    realpath'd, also containment-checked (separator-anchored, so a
 *    sibling-prefix path cannot pass), and required to be an existing directory.
 *    An unknown/escaping/web (FSA, non-absolute) root — or a cwd outside it — is
 *    REJECTED before any pty is spawned. The SPAWN itself is fixed
 *    (shell with NO args + a fixed `xterm-256color` term), so there is no
 *    shell-string injection in spawning — the bytes a user later WRITES to the
 *    pty are raw terminal input (that is the whole point of a terminal), but the
 *    process can never start outside an open folder.
 *
 * 2. LIFECYCLE / no orphans. Each client connection opens one session that
 *    tracks its live ptys. `terminal/destroy`, the connection's close (a closed
 *    window) and {@link DesktopTerminals.close} (host close, which quit and
 *    factory reset join) kill them, so no shell survives its window, the host or
 *    a workspace reset. Reaping is order-critical: {@link killTerminalTree}
 *    ends the whole tree with `terminateTree` (while the leader is still alive) and
 *    a POSIX process-group kill, so a child the shell backgrounded in the same
 *    session — including a `disown`'d / `nohup`'d job in its OWN process group —
 *    is reaped. A deliberately daemonized (`setsid`, own session) child escapes
 *    by ancestry, as it does in ANY terminal emulator (iTerm/VSCode included).
 *
 * 3. EVENT STREAM. pty output and exit go only to the session that created the
 *    terminal (never a broadcast), so one client can never receive, drive or
 *    kill another's terminal: a terminal id is looked up in its own session only.
 *
 * No-silent-fallbacks: a spawn failure, an unknown root, or a write/resize to a
 * dead terminal returns a structured `{ ok: false, error }` (logged), never a
 * throw across the wire and never a silent success.
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  HostCommandSessionMethods,
  HostTerminalSession,
  HostTerminals,
} from '@brainstrike/agent-host';
import type { TerminalEvent } from '@brainstrike/agent-host/protocol';
import { createLogger } from '@brainstrike/logging';
import { terminateTree, trackNativeChild } from '@brainstrike/state-store/native-children';
import type { IPty } from 'node-pty';
import * as pty from 'node-pty';
import type { CommandSessionManager } from '../assistant-server/command-session-manager';
import {
  resolveContainedCwd,
  resolveRootCwd,
  type WorkspaceRootResolver,
} from '../workspace-root-cwd';
import { createCommandSessionHandlers } from './command-session-handlers';

const logger = createLogger('HostTerminals');

/** Non-reversible fingerprint for a resolved root cwd, for warn+/error logs:
 * every warn+ log is durable — mirrored into a plaintext NDJSON file on disk
 * (`error-log-sink.ts`) — so the raw path must not appear here
 * (`docs/agents/platform-contracts.md`: "Never log or persist command text,
 * cwd, environment, or retained output"). Segment depth + a short sha256
 * prefix is still enough to correlate repeated spawn failures against "the
 * same root" without reconstructing the actual path. */
function fingerprintCwd(cwd: string): { cwdDepth: number; cwdSha256Prefix: string } {
  const segments = path
    .normalize(cwd)
    .split(path.sep)
    .filter((segment) => segment.length > 0);
  return {
    cwdDepth: segments.length,
    cwdSha256Prefix: createHash('sha256').update(cwd).digest('hex').slice(0, 12),
  };
}

/** Default PTY viewport when the client does not supply one. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Hard ceiling on viewport dimensions so a bad value cannot allocate absurd buffers. */
const MAX_DIMENSION = 5000;
/**
 * Max UTF-16 code units in a SINGLE `terminal/event` data push. node-pty already
 * chunks output; this only bounds a pathological single chunk so one runaway
 * line cannot blow the message. Larger chunks are split across events; the
 * renderer reassembles by plain concatenation, which is LOSSLESS (a surrogate
 * pair split across two events is restored on join).
 */
const MAX_EVENT_CHUNK_CHARS = 256 * 1024;

type TerminalResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true; value: T })
  | { ok: false; error: string };

/** A live pty in one client's session. */
interface LiveTerminal {
  readonly exited: Promise<void>;
  /** Cached pid (node-pty's `.pid` is stable post-spawn); used for tree-kill. */
  readonly pid: number;
  readonly process: IPty;
  reap: Promise<void> | null;
}

/**
 * Resolve the platform shell. Mirrors the shell tool's per-platform split:
 * POSIX uses `$SHELL` (falling back to `/bin/sh`); win32 uses `%ComSpec%`
 * (falling back to `cmd.exe`) — `$SHELL` is normally unset on Windows so the
 * POSIX fallback would ENOENT. The shell is spawned with NO args (an
 * interactive terminal, not a one-shot `-c` command).
 */
function resolveTerminalShell(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return process.env['ComSpec'] || 'cmd.exe';
  }
  return process.env['SHELL'] || '/bin/sh';
}

/** Clamp a client-supplied dimension into [1, MAX_DIMENSION] with a default. */
function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.min(Math.floor(value), MAX_DIMENSION);
}

function killTerminalProcessGroup(pid: number): Error | null {
  if (process.platform === 'win32') {
    return null;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: gone; EPERM: a just-killed leader is a zombie. Preserve the
    // existing POSIX backstop's expected post-tree-walk races.
    if (code === 'ESRCH' || code === 'EPERM') {
      return null;
    }
    logger.warn('Process-group kill failed for terminal', { code, pid });
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Forcefully reap a pty's process tree, ORDER-CRITICAL to close the
 * disowned/nohup'd background-child gap.
 *
 * Why the order matters: a pty shell has a controlling tty, so JOB CONTROL is
 * on and every background job (`sleep 600 & disown`, `nohup … &`) runs in its
 * OWN process group — NOT the shell's. So `process.kill(-shellPid, …)` (the
 * shell tool's mechanism) does NOT reach them, and once the shell exits the
 * child re-parents to PID 1, so `tree-kill`'s parent-pid walk also misses it.
 * The probe is deterministic: such a child orphans destroy()/dispose() if we
 * kill the leader first.
 *
 * The mechanism that DOES reap it: run `terminateTree` (the ps-tree descendant
 * walk; `taskkill /T` on Windows) FIRST, while the shell is still alive — at that moment the background
 * job is still parented to the shell, so the walk finds and SIGKILLs it. ONLY
 * AFTER that walk completes do we (1) `process.kill(-pid)` as a POSIX
 * process-group backstop for any same-group straggler (the shell tool's
 * recipe) and (2) `entry.process.kill()` the node-pty leader. Killing the
 * leader before the walk would re-parent the child and re-open the gap.
 *
 * Out of scope (POSIX, escapes EVERY terminal emulator incl. iTerm/VSCode): a
 * deliberately daemonized child that calls `setsid` to start its OWN session
 * detaches from the shell's tree AND session and cannot be reaped by ancestry.
 *
 * `terminal/destroy` and a closed client start cleanup without waiting. Host
 * close joins the retained reap, including node-pty's exit callback. An
 * already-dead race is expected; other tree-walk failures remain visible to
 * the drain.
 */
function killTerminalTree(entry: LiveTerminal): Promise<void> {
  if (entry.reap) {
    return entry.reap;
  }
  const treeReaped = (async () => {
    const failures: unknown[] = [];
    try {
      await terminateTree(entry.pid);
    } catch (error) {
      logger.warn('Could not end the terminal process tree', { error, pid: entry.pid });
      failures.push(error);
    }
    // Descendants first; retain the POSIX group backstop before the leader.
    const groupFailure = killTerminalProcessGroup(entry.pid);
    if (groupFailure) {
      failures.push(groupFailure);
    }
    try {
      entry.process.kill();
    } catch (killError) {
      logger.debug('pty.kill threw (process may already be gone)', {
        error: killError instanceof Error ? killError.message : String(killError),
      });
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Terminal tree cleanup failed');
    }
  })();
  entry.reap = Promise.allSettled([treeReaped, entry.exited]).then((results) => {
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Terminal shutdown cleanup failed');
    }
  });
  // Callers that start cleanup without waiting must not leave the rejection
  // unhandled; the drain that joins it still sees the failure.
  void entry.reap.catch((error: unknown) => {
    logger.warn('Terminal cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
      pid: entry.pid,
    });
  });
  return entry.reap;
}

export interface DesktopTerminalsOptions {
  /** This host's command sessions, which the panel's inventory lists. */
  readonly commandSessions: CommandSessionManager;
  readonly resolver: WorkspaceRootResolver;
  /** Injectable for tests; defaults to the real node-pty spawn. */
  readonly spawn?: typeof pty.spawn;
}

export interface DesktopTerminals {
  /** Ends every terminal of every client and joins their exits. */
  close(): Promise<void>;
  readonly service: HostTerminals;
}

export function createDesktopTerminals({
  commandSessions,
  resolver,
  spawn = pty.spawn,
}: DesktopTerminalsOptions): DesktopTerminals {
  // Every pty not yet joined, across sessions: host close drains them all,
  // including ones a destroy or a closed client already started reaping.
  const owned = new Set<LiveTerminal>();

  function open(send: (event: TerminalEvent) => void): HostTerminalSession {
    const live = new Map<string, LiveTerminal>();
    let closed = false;

    function sendData(terminalId: string, data: string): void {
      if (!closed) {
        send({ data, terminalId, type: 'data' });
      }
    }

    async function create(params: {
      readonly cols?: number;
      readonly cwd?: string;
      readonly rootId: string;
      readonly rows?: number;
    }): Promise<TerminalResult<{ cwd: string; terminalId: string }>> {
      const root = await resolveRootCwd(resolver, params.rootId, 'terminal', logger);
      if (!root.ok) {
        return root;
      }
      const cwd = await resolveContainedCwd(root.value, params.cwd, 'terminal');
      if (!cwd.ok) {
        return cwd;
      }
      if (closed) {
        return { error: 'The terminal client has closed.', ok: false };
      }
      const cols = clampDimension(params.cols, DEFAULT_COLS);
      const rows = clampDimension(params.rows, DEFAULT_ROWS);
      const shell = resolveTerminalShell();

      let ptyProcess: IPty;
      try {
        ptyProcess = spawn(shell, [], {
          cols,
          cwd: cwd.value,
          // biome-ignore lint/style/useNamingConvention: TERM is a standard env var name (must be uppercase).
          env: { ...process.env, TERM: 'xterm-256color' },
          name: 'xterm-256color',
          rows,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to spawn pty', {
          ...fingerprintCwd(cwd.value),
          error: message,
          shell,
        });
        return { error: `Failed to start terminal: ${message}`, ok: false };
      }
      // ADR-0017: node-pty cannot hand the shell the Root's descriptor, so the
      // supervisor tracks it instead. The pty leads its own session and group.
      const supervised = trackNativeChild(ptyProcess.pid, { group: true });

      const terminalId = `pty-${randomUUID()}`;
      const { promise: exited, resolve: resolveExited } = Promise.withResolvers<void>();
      const entry: LiveTerminal = {
        exited,
        pid: ptyProcess.pid,
        process: ptyProcess,
        reap: null,
      };
      live.set(terminalId, entry);
      owned.add(entry);
      void exited.then(() => {
        supervised();
        if (entry.reap) {
          void entry.reap.then(
            () => owned.delete(entry),
            () => undefined
          );
        } else {
          owned.delete(entry);
        }
      });

      ptyProcess.onData((chunk: string) => {
        // Split a pathological single chunk so one runaway line cannot blow the
        // message; normal chunks pass through whole.
        if (chunk.length <= MAX_EVENT_CHUNK_CHARS) {
          sendData(terminalId, chunk);
          return;
        }
        for (let offset = 0; offset < chunk.length; offset += MAX_EVENT_CHUNK_CHARS) {
          sendData(terminalId, chunk.slice(offset, offset + MAX_EVENT_CHUNK_CHARS));
        }
      });

      ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        // Delete BEFORE emitting so a client that re-creates on exit cannot
        // collide with the dying entry.
        live.delete(terminalId);
        try {
          if (!closed) {
            send({
              exitCode,
              signal: typeof signal === 'number' ? signal : null,
              terminalId,
              type: 'exit',
            });
          }
          logger.debug('pty exited', { exitCode, signal: signal ?? null, terminalId });
        } finally {
          resolveExited();
        }
      });

      logger.info('Spawned terminal', { cols, rows, shell, terminalId });
      return { ok: true, value: { cwd: cwd.value, terminalId } };
    }

    /** An id another client created is as unknown here as one never created. */
    function find(terminalId: string): LiveTerminal | { error: string } {
      return live.get(terminalId) ?? { error: `No live terminal "${terminalId}".` };
    }

    return {
      close: async () => {
        closed = true;
        const entries = [...live.values()];
        live.clear();
        const outcomes = await Promise.allSettled(entries.map(killTerminalTree));
        const failures = outcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? [outcome.reason] : []
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Terminal shutdown cleanup failed');
        }
        if (entries.length > 0) {
          logger.info('Reaped the terminals of a closed client', { count: entries.length });
        }
      },
      'terminal/create': create,
      'terminal/destroy': async ({ terminalId }) => {
        const entry = find(terminalId);
        if ('error' in entry) {
          return { error: entry.error, ok: false };
        }
        // Remove from the session FIRST so the onExit handler (which also
        // deletes) is a no-op and cannot double-fire teardown.
        live.delete(terminalId);
        void killTerminalTree(entry);
        logger.info('Destroyed terminal', { terminalId });
        return { ok: true };
      },
      'terminal/resize': async (params) => {
        const entry = find(params.terminalId);
        if ('error' in entry) {
          return { error: entry.error, ok: false };
        }
        const cols = clampDimension(params.cols, DEFAULT_COLS);
        const rows = clampDimension(params.rows, DEFAULT_ROWS);
        try {
          entry.process.resize(cols, rows);
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn('Resize of terminal failed', {
            error: message,
            terminalId: params.terminalId,
          });
          return { error: `Resize failed: ${message}`, ok: false };
        }
      },
      'terminal/write': async ({ data, terminalId }) => {
        const entry = find(terminalId);
        if ('error' in entry) {
          return { error: entry.error, ok: false };
        }
        try {
          entry.process.write(data);
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn('Write to terminal failed', { error: message, terminalId });
          return { error: `Write failed: ${message}`, ok: false };
        }
      },
    };
  }

  const sessions = createCommandSessionHandlers(commandSessions);
  const inventory: HostCommandSessionMethods = {
    'command-sessions/list': async (params) => sessions.list(params),
    'command-sessions/read': async (params) => sessions.read(params),
    'command-sessions/remove': (params) => sessions.remove(params),
    'command-sessions/stop': (params) => sessions.stop(params),
    'command-sessions/write': async (params) => sessions.write(params),
  };

  return {
    close: async () => {
      const outcomes = await Promise.allSettled([...owned].map(killTerminalTree));
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Terminal shutdown cleanup failed');
      }
    },
    service: { ...inventory, open },
  };
}
