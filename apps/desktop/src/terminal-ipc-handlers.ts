/**
 * Main-process handlers for the desktop `terminal` IPC domain — a PTY backend.
 *
 * A future TerminalPanel runs a REAL interactive shell inside an opened
 * workspace root via a pseudo-terminal (node-pty). This module owns the
 * security-critical seam and the process lifecycle:
 *
 * 1. cwd is PINNED + VALIDATED.
 *    `terminal:create` takes a renderer-supplied `rootId` that is resolved +
 *    containment-checked against the DB-backed workspace roots (the SAME source
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
 * 2. LIFECYCLE / no orphans. Every live pty is tracked in a module-level map.
 *    `terminal:destroy` and {@link disposeAllTerminals} (wired into graceful
 *    shutdown AND factory reset, mirroring the shell tool's
 *    `disposeLiveChildProcesses`) kill every pty so no shell survives the app /
 *    a workspace reset. Reaping is order-critical: {@link killTerminalTree}
 *    runs the `tree-kill` descendant walk (while the leader is still alive) and
 *    a POSIX process-group kill, so a child the shell backgrounded in the same
 *    session — including a `disown`'d / `nohup`'d job in its OWN process group —
 *    is reaped. A deliberately daemonized (`setsid`, own session) child escapes
 *    by ancestry, as it does in ANY terminal emulator (iTerm/VSCode included).
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

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { ipcMain } from 'electron';
import type { IPty } from 'node-pty';
import * as pty from 'node-pty';
import treeKill from 'tree-kill';
import { terminalContract } from './ipc-domains/terminal.contract';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import {
  resolveContainedCwd,
  resolveRootCwd,
  type WorkspaceRootResolver,
} from './workspace-root-cwd';

const logger = createLogger('TerminalIpc');

/** Non-reversible fingerprint for a resolved root cwd, for warn+/error logs:
 * this branch (Flight Recorder P2a) makes every warn+ log durable — mirrored
 * into a plaintext NDJSON file on disk (`error-log-sink.ts`) — so the raw
 * path can no longer appear here (`docs/agents/platform-contracts.md`:
 * "Never log or persist command text, cwd, environment, or retained
 * output"). Segment depth + a short sha256 prefix is still enough to
 * correlate repeated spawn failures against "the same root" without
 * reconstructing the actual path. */
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

/** Default PTY viewport when the renderer does not supply one. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Hard ceiling on viewport dimensions so a bad value cannot allocate absurd buffers. */
const MAX_DIMENSION = 5000;
/**
 * Max UTF-16 code units in a SINGLE `terminal:data` event push. node-pty already
 * chunks output; this only bounds a pathological single chunk so one runaway
 * line cannot blow the IPC message. Larger chunks are split across events; the
 * renderer reassembles by plain concatenation, which is LOSSLESS (a surrogate
 * pair split across two events is restored on join). A per-chunk xterm.write()
 * consumer could momentarily render a replacement char on a >256k-unit split,
 * but the buffered text is always correct — flagged for the xterm PR.
 */
const MAX_EVENT_CHUNK_CHARS = 256 * 1024;

/** A successful result carries a value; a failure carries a human-readable error. */
export type TerminalResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true; value: T })
  | { ok: false; error: string };

export interface TerminalCreateParams {
  readonly cols?: number;
  /**
   * Absolute path INSIDE the resolved root to pin the shell to. Omitted ⇒ the
   * root itself (the original, unchanged behavior). Supplied by the Worktree
   * Map / workspace-bar "Open in Terminal" surfaces so a worktree NESTED under
   * an open root gets a shell at its OWN path rather than the parent repo's.
   */
  readonly cwd?: string;
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

/**
 * WebContents we have already attached a `'destroyed'` reaper to. Tracked so a
 * renderer that opens MANY terminals registers ONE listener (not one per
 * terminal) — otherwise >10 terminals in a window trips Node's default
 * MaxListenersExceededWarning and fires N redundant reaps on destroy. A WeakSet
 * lets the entry vanish when the WebContents is GC'd.
 */
const reaperAttachedOwners = new WeakSet<WebContents>();

/** Generate a process-unique, non-guessable terminal id. */
function nextTerminalId(): string {
  return `pty-${randomUUID()}`;
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
 * The mechanism that DOES reap it: run `tree-kill` (the ps-tree descendant
 * walk) FIRST, while the shell is still alive — at that moment the background
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
 * `dispose` is fire-and-forget (the public callers stay synchronous); ordering
 * is preserved INSIDE the tree-kill callback. Failures are logged, never
 * swallowed (no-silent-fallbacks); an "already dead" race is expected and quiet.
 */
function killTerminalTree(entry: LiveTerminal): void {
  // 1) Descendant walk FIRST, while the leader is still alive, so a
  //    separate-process-group background job is still a descendant by ppid.
  treeKill(entry.pid, 'SIGKILL', (error) => {
    if (error && !/no such process/i.test(error.message)) {
      logger.warn('tree-kill failed for terminal', { error: error.message, pid: entry.pid });
    }
    // 2) POSIX process-group backstop for same-group children (covers anything
    //    that DID stay in the shell's group). Windows has no process groups and
    //    relies entirely on the tree-kill walk above.
    if (process.platform !== 'win32') {
      try {
        process.kill(-entry.pid, 'SIGKILL');
      } catch (groupError) {
        const code = (groupError as NodeJS.ErrnoException).code;
        // Both are EXPECTED here because the tree-kill walk above usually
        // already reaped the group:
        //  - ESRCH: the group is gone.
        //  - EPERM: the leader is a just-SIGKILLed zombie, so the kernel rejects
        //    a group signal through it. The leader is always our own child, so a
        //    genuine permission failure is impossible — this is the post-reap
        //    race, not a real denial. Any OTHER code is unexpected → warn (no
        //    silent fallback).
        if (code !== 'ESRCH' && code !== 'EPERM') {
          logger.warn('Process-group kill failed for terminal', { code, pid: entry.pid });
        }
      }
    }
    // 3) Finally the node-pty leader itself (SIGHUP). A throw here means the
    //    shell already exited — expected, logged at debug only.
    try {
      entry.process.kill();
    } catch (killError) {
      logger.debug('pty.kill threw (process may already be gone)', {
        error: killError instanceof Error ? killError.message : String(killError),
      });
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
  create: (
    owner: WebContents,
    params: TerminalCreateParams
  ) => Promise<TerminalResult<TerminalCreateResult>>;
  /**
   * `requesterId` is the calling renderer's `WebContents.id` (from
   * `event.sender`). write/resize/destroy reject when it does not match the
   * terminal's owner, so one renderer cannot drive (or kill) another's shell by
   * guessing its id — the hidden host renderers also hold the bridge.
   */
  destroy: (params: TerminalDestroyParams, requesterId: number) => TerminalResult;
  resize: (params: TerminalResizeParams, requesterId: number) => TerminalResult;
  write: (params: TerminalWriteParams, requesterId: number) => TerminalResult;
}

export function createTerminalIpcHandlers({
  resolver,
  spawn = pty.spawn,
}: TerminalIpcHandlersOptions): TerminalIpcHandlers {
  function sendData(entry: LiveTerminal, terminalId: string, data: string): void {
    if (entry.webContents.isDestroyed()) {
      return;
    }
    const payload: TerminalDataEvent = { data, terminalId };
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
    const root = await resolveRootCwd(resolver, params?.rootId, 'terminal', logger);
    if (!root.ok) {
      return root;
    }
    const cwd = await resolveContainedCwd(root.value, params?.cwd, 'terminal');
    if (!cwd.ok) {
      return cwd;
    }
    const cols = clampDimension(params?.cols, DEFAULT_COLS);
    const rows = clampDimension(params?.rows, DEFAULT_ROWS);
    const shell = resolveTerminalShell();

    let ptyProcess: IPty;
    try {
      ptyProcess = spawn(shell, [], {
        cols,
        cwd: cwd.value,
        // biome-ignore lint/style/useNamingConvention: TERM is a standard env var name (must be uppercase).
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
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

    const terminalId = nextTerminalId();
    const entry: LiveTerminal = {
      ownerId: owner.id,
      pid: ptyProcess.pid,
      process: ptyProcess,
      webContents: owner,
    };
    liveTerminals.set(terminalId, entry);

    // If the owning renderer is destroyed (window closed / navigated away mid
    // root-switch), reap every pty it owns so no shell is orphaned. Attach the
    // reaper ONCE per WebContents (not once per terminal — see
    // reaperAttachedOwners) so opening many terminals can't trip the listener
    // cap or fire N redundant reaps. Idempotent with destroy()/onExit() (the
    // map delete makes a later teardown a no-op).
    if (!reaperAttachedOwners.has(owner)) {
      reaperAttachedOwners.add(owner);
      owner.once('destroyed', () => {
        reaperAttachedOwners.delete(owner);
        disposeTerminalsForWebContents(owner.id);
      });
    }

    ptyProcess.onData((chunk: string) => {
      // Split a pathological single chunk so one runaway line cannot blow the
      // IPC message; normal chunks pass through whole.
      if (chunk.length <= MAX_EVENT_CHUNK_CHARS) {
        sendData(entry, terminalId, chunk);
        return;
      }
      for (let offset = 0; offset < chunk.length; offset += MAX_EVENT_CHUNK_CHARS) {
        sendData(entry, terminalId, chunk.slice(offset, offset + MAX_EVENT_CHUNK_CHARS));
      }
    });

    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      // Delete BEFORE emitting so a renderer that re-creates on exit cannot
      // collide with the dying entry.
      liveTerminals.delete(terminalId);
      sendExit(entry, {
        exitCode,
        signal: typeof signal === 'number' ? signal : null,
        terminalId,
      });
      logger.debug('pty exited', { exitCode, signal: signal ?? null, terminalId });
    });

    logger.info('Spawned terminal', { cols, cwd: cwd.value, rows, shell, terminalId });
    return { ok: true, value: { cwd: cwd.value, terminalId } };
  }

  /**
   * Look up a live terminal AND enforce that `requesterId` (the calling
   * renderer) owns it. A non-owner — or an unknown id — gets the SAME
   * "No live terminal" error (no ownership-leak oracle that confirms an id
   * exists for another renderer). The owner mismatch is logged.
   */
  function resolveOwnedTerminal(
    terminalId: string | undefined,
    requesterId: number
  ): LiveTerminal | { error: string } {
    const entry = liveTerminals.get(terminalId ?? '');
    if (!entry) {
      return { error: `No live terminal "${terminalId}".` };
    }
    if (entry.ownerId !== requesterId) {
      logger.warn('Rejected terminal op from non-owner renderer', {
        ownerId: entry.ownerId,
        requesterId,
        terminalId,
      });
      return { error: `No live terminal "${terminalId}".` };
    }
    return entry;
  }

  function write(params: TerminalWriteParams, requesterId: number): TerminalResult {
    const entry = resolveOwnedTerminal(params?.terminalId, requesterId);
    if ('error' in entry) {
      return { error: entry.error, ok: false };
    }
    if (typeof params.data !== 'string') {
      return { error: 'terminal:write requires a string data payload.', ok: false };
    }
    try {
      entry.process.write(params.data);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Write to terminal failed', { error: message, terminalId: params.terminalId });
      return { error: `Write failed: ${message}`, ok: false };
    }
  }

  function resize(params: TerminalResizeParams, requesterId: number): TerminalResult {
    const entry = resolveOwnedTerminal(params?.terminalId, requesterId);
    if ('error' in entry) {
      return { error: entry.error, ok: false };
    }
    const cols = clampDimension(params?.cols, DEFAULT_COLS);
    const rows = clampDimension(params?.rows, DEFAULT_ROWS);
    try {
      entry.process.resize(cols, rows);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Resize of terminal failed', { error: message, terminalId: params.terminalId });
      return { error: `Resize failed: ${message}`, ok: false };
    }
  }

  function destroy(params: TerminalDestroyParams, requesterId: number): TerminalResult {
    const entry = resolveOwnedTerminal(params?.terminalId, requesterId);
    if ('error' in entry) {
      return { error: entry.error, ok: false };
    }
    // Remove from the registry FIRST so the onExit handler (which also deletes)
    // is a no-op and cannot double-fire teardown.
    liveTerminals.delete(params.terminalId);
    killTerminalTree(entry);
    logger.info('Destroyed terminal', { terminalId: params.terminalId });
    return { ok: true };
  }

  return { create, destroy, resize, write };
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
    logger.info('Reaped terminals for destroyed renderer', { count: reaped, ownerId });
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

  registry.registerAuthorizedInvoke(
    'terminal',
    terminalContract.create.channel,
    { roles: terminalContract.create.roles },
    (event: IpcMainInvokeEvent, ...raw: readonly unknown[]) =>
      handlers.create(event.sender, ...terminalContract.create.parseArgs(raw))
  );
  registry.registerAuthorizedInvoke(
    'terminal',
    terminalContract.write.channel,
    { roles: terminalContract.write.roles },
    (event: IpcMainInvokeEvent, ...raw: readonly unknown[]) =>
      handlers.write(...terminalContract.write.parseArgs(raw), event.sender.id)
  );
  registry.registerAuthorizedInvoke(
    'terminal',
    terminalContract.resize.channel,
    { roles: terminalContract.resize.roles },
    (event: IpcMainInvokeEvent, ...raw: readonly unknown[]) =>
      handlers.resize(...terminalContract.resize.parseArgs(raw), event.sender.id)
  );
  registry.registerAuthorizedInvoke(
    'terminal',
    terminalContract.destroy.channel,
    { roles: terminalContract.destroy.roles },
    (event: IpcMainInvokeEvent, ...raw: readonly unknown[]) =>
      handlers.destroy(...terminalContract.destroy.parseArgs(raw), event.sender.id)
  );

  return () => {
    registry.unregisterAll();
    disposeAllTerminals();
  };
}
