/**
 * Main-process handlers for the desktop `terminal` IPC domain — a PTY backend.
 *
 * A future TerminalPanel runs a REAL interactive shell inside an opened
 * workspace root via a pseudo-terminal (node-pty). This module owns the
 * security-critical seam and the process lifecycle:
 *
 * 1. cwd is PINNED + VALIDATED. `terminal:create` takes a renderer-supplied
 *    `rootId` that is resolved + containment-checked against the DB-backed
 *    workspace roots (the SAME source the git / read / search tools use), then
 *    canonicalized via `realpath`. An unknown/escaping/web (FSA, non-absolute)
 *    root is REJECTED before any pty is spawned. The SPAWN itself is fixed
 *    (shell with NO args + a fixed `xterm-256color` term), so there is no
 *    shell-string injection in spawning — the bytes a user later WRITES to the
 *    pty are raw terminal input (that is the whole point of a terminal), but the
 *    process can never start outside an open folder.
 *
 * 2. LIFECYCLE / no orphans. Every live pty is tracked in a module-level map.
 *    `terminal:destroy` and {@link disposeAllTerminals} (wired into graceful
 *    shutdown AND factory reset, mirroring the shell tool's
 *    `disposeLiveChildProcesses`) kill every pty so no shell survives the app /
 *    a workspace reset. `tree-kill` reaps the whole process tree as a backstop.
 *
 * 3. EVENT STREAM. pty stdout/stderr is pushed to the OWNING renderer via a
 *    one-way `terminal:data` event ({@link DESKTOP_IPC_CHANNELS.terminal.data});
 *    pty exit is pushed via `terminal:exit`. Events target only the WebContents
 *    that created the terminal (never a broadcast), so a hidden host renderer
 *    can never receive another window's terminal output.
 *
 * No-silent-fallbacks: a spawn failure, an unknown root, or a write/resize to a
 * dead terminal returns a structured `{ ok: false, error }` (logged), never a
 * throw across IPC and never a silent success.
 */

import { createLogger } from '@brainstrike/utils/logger';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { ipcMain } from 'electron';
import type { IPty } from 'node-pty';
import * as pty from 'node-pty';
import treeKill from 'tree-kill';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { resolveRootCwd, type WorkspaceRootResolver } from './workspace-root-cwd';

const logger = createLogger('TerminalIpc');

/** Default PTY viewport when the renderer does not supply one. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Hard ceiling on viewport dimensions so a bad value cannot allocate absurd buffers. */
const MAX_DIMENSION = 5000;
/**
 * Max bytes of pty output buffered for a SINGLE event push. node-pty already
 * chunks output; this only bounds a pathological single chunk so one runaway
 * line cannot blow the IPC message. Larger chunks are split across events.
 */
const MAX_EVENT_CHUNK_BYTES = 256 * 1024;

/** A successful result carries a value; a failure carries a human-readable error. */
export type TerminalResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true; value: T })
  | { ok: false; error: string };

export interface TerminalCreateParams {
  readonly cols?: number;
  readonly rootId: string;
  readonly rows?: number;
}

export interface TerminalCreateResult {
  /** The canonical, containment-checked absolute cwd the shell started in. */
  readonly cwd: string;
  /** Opaque id the renderer uses for write/resize/destroy + event correlation. */
  readonly terminalId: string;
}

export interface TerminalWriteParams {
  readonly data: string;
  readonly terminalId: string;
}

export interface TerminalResizeParams {
  readonly cols: number;
  readonly rows: number;
  readonly terminalId: string;
}

export interface TerminalDestroyParams {
  readonly terminalId: string;
}

/** One-way payload pushed to the owning renderer when the pty emits output. */
export interface TerminalDataEvent {
  readonly data: string;
  readonly terminalId: string;
}

/** One-way payload pushed to the owning renderer when the pty process exits. */
export interface TerminalExitEvent {
  readonly exitCode: number;
  /** Terminating signal number when killed by a signal (else null). */
  readonly signal: number | null;
  readonly terminalId: string;
}

/** A live pty plus the WebContents that owns it (where its events are pushed). */
interface LiveTerminal {
  readonly ownerId: number;
  /** Cached pid (node-pty's `.pid` is stable post-spawn); used for tree-kill. */
  readonly pid: number;
  readonly process: IPty;
  readonly webContents: WebContents;
}

/**
 * GLOBAL registry of live ptys keyed by terminalId. Module-level so it is shared
 * across every concurrent IPC call and reaped wholesale by
 * {@link disposeAllTerminals} on shutdown / factory reset.
 */
const liveTerminals = new Map<string, LiveTerminal>();

let terminalSequence = 0;

/** Generate a process-unique, non-guessable terminal id. */
function nextTerminalId(): string {
  terminalSequence += 1;
  return `pty-${Date.now().toString(36)}-${terminalSequence}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve the platform shell. Mirrors the shell tool's per-platform split:
 * POSIX uses `$SHELL` (falling back to `/bin/sh`); win32 uses `%ComSpec%`
 * (falling back to `cmd.exe`) — `$SHELL` is normally unset on Windows so the
 * POSIX fallback would ENOENT. The shell is spawned with NO args (an
 * interactive terminal, not a one-shot `-c` command).
 */
export function resolveTerminalShell(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return process.env['ComSpec'] || 'cmd.exe';
  }
  return process.env['SHELL'] || '/bin/sh';
}

/** Clamp a renderer-supplied dimension into [1, MAX_DIMENSION] with a default. */
function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.min(Math.floor(value), MAX_DIMENSION);
}

/**
 * Forcefully reap a pty's process tree. node-pty's `kill()` signals the shell;
 * `tree-kill` is the cross-platform backstop that walks + signals the whole
 * descendant tree so a child the shell forked cannot be orphaned. A kill failure
 * is logged, never swallowed (no-silent-fallbacks). An "already dead" race after
 * the shell exited is expected and not logged.
 */
function killTerminalTree(entry: LiveTerminal): void {
  try {
    entry.process.kill();
  } catch (error) {
    // ESRCH-equivalent: the process already exited. node-pty throws a generic
    // Error here, so we cannot discriminate; tree-kill below is the real reaper.
    logger.debug('pty.kill threw (process may already be gone)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  treeKill(entry.pid, 'SIGKILL', (error) => {
    if (error && !/no such process/i.test(error.message)) {
      logger.warn('tree-kill failed for terminal', { pid: entry.pid, error: error.message });
    }
  });
}

/**
 * Build the dependency-injected terminal handlers. `resolver` validates rootIds
 * (defaults to the DB-backed resolver wired in `ipc-terminal.ts`); `spawn` is
 * injectable for tests (defaults to the real node-pty spawn).
 */
export interface TerminalIpcHandlersOptions {
  readonly resolver: WorkspaceRootResolver;
  /** Injectable for tests; defaults to the real node-pty spawn. */
  readonly spawn?: typeof pty.spawn;
}

export interface TerminalIpcHandlers {
  create(
    owner: WebContents,
    params: TerminalCreateParams
  ): Promise<TerminalResult<TerminalCreateResult>>;
  destroy(params: TerminalDestroyParams): TerminalResult;
  resize(params: TerminalResizeParams): TerminalResult;
  write(params: TerminalWriteParams): TerminalResult;
}

export function createTerminalIpcHandlers({
  resolver,
  spawn = pty.spawn,
}: TerminalIpcHandlersOptions): TerminalIpcHandlers {
  function sendData(entry: LiveTerminal, terminalId: string, data: string): void {
    if (entry.webContents.isDestroyed()) {
      return;
    }
    const payload: TerminalDataEvent = { terminalId, data };
    entry.webContents.send(DESKTOP_IPC_CHANNELS.terminal.data, payload);
  }

  function sendExit(entry: LiveTerminal, event: TerminalExitEvent): void {
    if (entry.webContents.isDestroyed()) {
      return;
    }
    entry.webContents.send(DESKTOP_IPC_CHANNELS.terminal.exit, event);
  }

  async function create(
    owner: WebContents,
    params: TerminalCreateParams
  ): Promise<TerminalResult<TerminalCreateResult>> {
    const cwd = await resolveRootCwd(resolver, params?.rootId, 'terminal', logger);
    if (!cwd.ok) {
      return cwd;
    }
    const cols = clampDimension(params?.cols, DEFAULT_COLS);
    const rows = clampDimension(params?.rows, DEFAULT_ROWS);
    const shell = resolveTerminalShell();

    let ptyProcess: IPty;
    try {
      ptyProcess = spawn(shell, [], {
        name: 'xterm-256color',
        cwd: cwd.value,
        cols,
        rows,
        // biome-ignore lint/style/useNamingConvention: TERM is a standard env var name (must be uppercase).
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to spawn pty', { shell, cwd: cwd.value, error: message });
      return { ok: false, error: `Failed to start terminal: ${message}` };
    }

    const terminalId = nextTerminalId();
    const entry: LiveTerminal = {
      ownerId: owner.id,
      process: ptyProcess,
      pid: ptyProcess.pid,
      webContents: owner,
    };
    liveTerminals.set(terminalId, entry);

    // If the owning renderer is destroyed (window closed / navigated away mid
    // root-switch), reap every pty it owns so no shell is orphaned. `once` so
    // the listener self-removes; idempotent with destroy()/onExit() (the map
    // delete makes the second teardown a no-op).
    owner.once('destroyed', () => {
      disposeTerminalsForWebContents(owner.id);
    });

    ptyProcess.onData((chunk: string) => {
      // Split a pathological single chunk so one runaway line cannot blow the
      // IPC message; normal chunks pass through whole.
      if (chunk.length <= MAX_EVENT_CHUNK_BYTES) {
        sendData(entry, terminalId, chunk);
        return;
      }
      for (let offset = 0; offset < chunk.length; offset += MAX_EVENT_CHUNK_BYTES) {
        sendData(entry, terminalId, chunk.slice(offset, offset + MAX_EVENT_CHUNK_BYTES));
      }
    });

    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      // Delete BEFORE emitting so a renderer that re-creates on exit cannot
      // collide with the dying entry.
      liveTerminals.delete(terminalId);
      sendExit(entry, {
        terminalId,
        exitCode,
        signal: typeof signal === 'number' ? signal : null,
      });
      logger.debug('pty exited', { terminalId, exitCode, signal: signal ?? null });
    });

    logger.info('Spawned terminal', { terminalId, shell, cwd: cwd.value, cols, rows });
    return { ok: true, value: { terminalId, cwd: cwd.value } };
  }

  function write(params: TerminalWriteParams): TerminalResult {
    const entry = liveTerminals.get(params?.terminalId);
    if (!entry) {
      return { ok: false, error: `No live terminal "${params?.terminalId}".` };
    }
    if (typeof params.data !== 'string') {
      return { ok: false, error: 'terminal:write requires a string data payload.' };
    }
    try {
      entry.process.write(params.data);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Write to terminal failed', { terminalId: params.terminalId, error: message });
      return { ok: false, error: `Write failed: ${message}` };
    }
  }

  function resize(params: TerminalResizeParams): TerminalResult {
    const entry = liveTerminals.get(params?.terminalId);
    if (!entry) {
      return { ok: false, error: `No live terminal "${params?.terminalId}".` };
    }
    const cols = clampDimension(params?.cols, DEFAULT_COLS);
    const rows = clampDimension(params?.rows, DEFAULT_ROWS);
    try {
      entry.process.resize(cols, rows);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Resize of terminal failed', { terminalId: params.terminalId, error: message });
      return { ok: false, error: `Resize failed: ${message}` };
    }
  }

  function destroy(params: TerminalDestroyParams): TerminalResult {
    const entry = liveTerminals.get(params?.terminalId);
    if (!entry) {
      return { ok: false, error: `No live terminal "${params?.terminalId}".` };
    }
    // Remove from the registry FIRST so the onExit handler (which also deletes)
    // is a no-op and cannot double-fire teardown.
    liveTerminals.delete(params.terminalId);
    killTerminalTree(entry);
    logger.info('Destroyed terminal', { terminalId: params.terminalId });
    return { ok: true };
  }

  return { create, write, resize, destroy };
}

/**
 * Reap every still-live pty. Wired into graceful shutdown AND factory reset so
 * no shell survives the app exit or a workspace wipe. Returns the count reaped
 * (for logging/observability). Mirrors `disposeLiveChildProcesses`.
 */
export function disposeAllTerminals(): number {
  const entries = Array.from(liveTerminals.entries());
  for (const [, entry] of entries) {
    killTerminalTree(entry);
  }
  liveTerminals.clear();
  if (entries.length > 0) {
    logger.info('Reaped live terminals on dispose', { count: entries.length });
  }
  return entries.length;
}

/** Kill + drop every terminal owned by a destroyed/navigated-away renderer. */
export function disposeTerminalsForWebContents(ownerId: number): number {
  let reaped = 0;
  for (const [terminalId, entry] of Array.from(liveTerminals.entries())) {
    if (entry.ownerId !== ownerId) {
      continue;
    }
    liveTerminals.delete(terminalId);
    killTerminalTree(entry);
    reaped += 1;
  }
  if (reaped > 0) {
    logger.info('Reaped terminals for destroyed renderer', { ownerId, count: reaped });
  }
  return reaped;
}

/** Test-only: current count of live terminals. */
export function liveTerminalCountForTest(): number {
  return liveTerminals.size;
}

/**
 * Register the desktop `terminal` IPC domain. Returns a disposer that
 * unregisters the channels AND reaps every live pty (so a host re-init never
 * leaks a shell). The `terminal:data` / `terminal:exit` event channels are NOT
 * `ipcMain.on` registrations — they are main→renderer pushes, so they are not
 * registered here; the registry only owns the four invoke channels.
 */
export function registerTerminalIpcHandlers(handlers: TerminalIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'terminal',
    DESKTOP_IPC_CHANNELS.terminal.create,
    (event: IpcMainInvokeEvent, params: TerminalCreateParams) =>
      handlers.create(event.sender, params)
  );
  registry.registerInvoke(
    'terminal',
    DESKTOP_IPC_CHANNELS.terminal.write,
    (_event, params: TerminalWriteParams) => handlers.write(params)
  );
  registry.registerInvoke(
    'terminal',
    DESKTOP_IPC_CHANNELS.terminal.resize,
    (_event, params: TerminalResizeParams) => handlers.resize(params)
  );
  registry.registerInvoke(
    'terminal',
    DESKTOP_IPC_CHANNELS.terminal.destroy,
    (_event, params: TerminalDestroyParams) => handlers.destroy(params)
  );

  return () => {
    registry.unregisterAll();
    disposeAllTerminals();
  };
}
