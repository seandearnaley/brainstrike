/**
 * Main-process handlers for the desktop `notesVault` IPC domain — a Node-fs
 * backend for the markdown notes vault (no File System Access API in the
 * renderer; the OS grants access).
 *
 * Security model — APPROVED ROOTS. A module-level map holds the canonical
 * (realpath'd) directory paths the user has approved as vault roots:
 *   - `ensureDefaultVault` approves the app-chosen default vault directory,
 *   - `pickDirectory` approves what the user picked in the native dialog,
 *   - `registerRoot` re-approves a persisted root after restart (validated:
 *     must exist, be a directory, and pass the sensitive-path checks).
 * Every read (listDirectory/statEntry/readFile) resolves the renderer-supplied
 * absolute path lexically AND canonically (realpath) and requires containment
 * inside SOME approved root — a symlink whose target escapes every approved
 * root is refused. Every write goes through the SINGLE audited write path
 * (`secure-file-write.ts`: `resolveWorkspaceWritePath` +
 * `writeContainedFileBytes`), scoped to the owning approved root.
 *
 * Watching: `watch` starts a recursive, debounced watcher (the shared
 * chokidar-backed electron watcher from `@brainstrike/file-system/electron`,
 * injected by `ipc-notes-vault.ts`). Change pushes go one-way to the OWNING
 * renderer's WebContents on `notes-vault:changed` ({@link
 * DESKTOP_IPC_CHANNELS.notesVault.changed}) — never a broadcast. Watchers are
 * reaped when the owning WebContents is destroyed (ONE reaper per owner via a
 * WeakSet, mirroring terminal-ipc-handlers.ts) and wholesale by
 * {@link disposeAllNotesVaultWatchers} on shutdown.
 *
 * Result convention mirrors the git/terminal bridges: methods never throw
 * across IPC; failures come back as `{ ok: false, error }` (logged — NO SILENT
 * FALLBACKS) and the renderer adapter converts them to thrown errors.
 */

import { randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import { createLogger } from '@brainstrike/utils/logger';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { ipcMain } from 'electron';
import { isWithinRoot } from './assistant-server/workspace-path';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { resolveWorkspaceWritePath, writeContainedFileBytes } from './secure-file-write';

const logger = createLogger('NotesVaultIpc');

/** Directory name of the app-managed default vault (under the OS documents dir). */
export const DEFAULT_NOTES_VAULT_DIRECTORY_NAME = 'Brainstrike Notes';

/** Explicit read ceiling so a renderer cannot pull an arbitrarily large file over IPC. */
export const MAX_NOTES_VAULT_READ_BYTES = 10 * 1024 * 1024;

const WELCOME_NOTE_NAME = 'Welcome.md';
// The vault package's welcome constant is not exported from
// '@brainstrike/notes-vault/core', so the desktop backend seeds its own short
// welcome note (only on FIRST creation of the default vault directory).
const WELCOME_NOTE_CONTENT = `# Welcome to Notes

Your notes live here as plain markdown files — no import, no lock-in.

- Click **Edit** (or create a note with **New Note**) to start writing. Changes save automatically; **⌘S** saves immediately.
- Add any folder of markdown as another vault to browse it here.
- Link between notes with relative links like [Welcome](Welcome.md); headings, code fences, tasks, and math all render.

Delete this note whenever you like.
`;

/** Mirrors NotesVaultResult in packages/notes-vault/src/desktop/bridge-contract.ts. */
export type NotesVaultResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Mirrors NotesVaultBridgeEntry in the bridge contract. */
export interface NotesVaultEntry {
  readonly kind: 'file' | 'directory';
  readonly lastModified: number;
  readonly name: string;
  readonly size: number;
}

/** Mirrors NotesVaultBridgeRoot in the bridge contract. */
export interface NotesVaultRoot {
  /** Display name (directory basename). */
  readonly name: string;
  /** Canonical absolute path on disk. */
  readonly path: string;
}

/** One-way payload pushed to the owning renderer when a watched vault changes. */
export interface NotesVaultChangedEvent {
  readonly watchId: string;
}

/** A live watcher plus the WebContents that owns it (where its pushes go). */
interface LiveNotesVaultWatcher {
  readonly ownerId: number;
  readonly stop: () => void;
  readonly webContents: WebContents;
}

/**
 * GLOBAL registry of approved vault roots keyed by canonical path. Module-level
 * so it is shared across every concurrent IPC call, exactly like the terminal
 * domain's live-pty map.
 */
const approvedRoots = new Map<string, NotesVaultRoot>();

/** GLOBAL registry of live watchers keyed by watchId. */
const liveWatchers = new Map<string, LiveNotesVaultWatcher>();

/**
 * WebContents we have already attached a `'destroyed'` reaper to — ONE listener
 * per owner (not one per watcher), mirroring terminal-ipc-handlers.ts.
 */
const reaperAttachedOwners = new WeakSet<WebContents>();

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outsideRootsError(requestedPath: string): string {
  return `Path "${requestedPath}" is not inside an approved notes vault root.`;
}

function failure<T>(
  operation: string,
  error: unknown,
  context: Record<string, unknown> = {}
): NotesVaultResult<T> {
  const message = toErrorMessage(error);
  logger.warn('Notes vault operation failed', { ...context, error: message, operation });
  return { error: message, ok: false };
}

function registerApprovedRoot(canonicalPath: string): NotesVaultRoot {
  const existing = approvedRoots.get(canonicalPath);
  if (existing) {
    return existing;
  }
  const root: NotesVaultRoot = {
    name: path.basename(canonicalPath) || canonicalPath,
    path: canonicalPath,
  };
  approvedRoots.set(canonicalPath, root);
  logger.info('Approved notes vault root', { path: canonicalPath });
  return root;
}

/** Canonical containment: which approved root (if any) contains `canonicalPath`? */
function findApprovedRootFor(candidatePath: string): string | null {
  for (const rootPath of approvedRoots.keys()) {
    if (isWithinRoot(rootPath, candidatePath)) {
      return rootPath;
    }
  }
  return null;
}

function validateRawVaultPath(requestedPath: unknown): { error: string } | { lexicalPath: string } {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    return { error: 'Notes vault path must be a non-empty string.' };
  }
  if (requestedPath.includes('\0')) {
    return { error: 'Notes vault path must not contain null bytes.' };
  }
  if (!path.isAbsolute(requestedPath)) {
    return { error: `Notes vault path "${requestedPath}" must be an absolute path.` };
  }
  return { lexicalPath: path.resolve(requestedPath) };
}

type ApprovedReadResolution =
  | { canonicalPath: string; missing: false; rootPath: string }
  | { missing: true }
  | { error: string };

/**
 * Resolve a renderer-supplied absolute path for a READ. Containment is checked
 * TWICE: lexically (before any filesystem access) and canonically after
 * `realpath` (so a symlink whose target escapes every approved root is
 * refused). `allowMissing` is for statEntry, where ENOENT means "no entry"
 * rather than an error — but ONLY after the lexical containment check passed.
 */
async function resolveApprovedReadPath(
  requestedPath: unknown,
  allowMissing: boolean
): Promise<ApprovedReadResolution> {
  const raw = validateRawVaultPath(requestedPath);
  if ('error' in raw) {
    return raw;
  }
  if (findApprovedRootFor(raw.lexicalPath) === null) {
    return { error: outsideRootsError(raw.lexicalPath) };
  }
  let canonicalPath: string;
  try {
    canonicalPath = await fsPromises.realpath(raw.lexicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) {
      return { missing: true };
    }
    return { error: toErrorMessage(error) };
  }
  const rootPath = findApprovedRootFor(canonicalPath);
  if (rootPath === null) {
    return { error: outsideRootsError(raw.lexicalPath) };
  }
  return { canonicalPath, missing: false, rootPath };
}

/**
 * lstat a directory child for listing. Returns null for entries that must be
 * SKIPPED: symlinks (live OR dangling — a link child could point outside every
 * approved root, and the bridge contract has no symlink kind), entries that are
 * neither a file nor a directory (sockets/FIFOs), and children deleted between
 * readdir and lstat (a benign race, not a failure).
 */
async function lstatListableChild(childPath: string): Promise<import('node:fs').Stats | null> {
  let childStats: import('node:fs').Stats;
  try {
    childStats = await fsPromises.lstat(childPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (childStats.isSymbolicLink()) {
    return null;
  }
  if (!(childStats.isFile() || childStats.isDirectory())) {
    return null;
  }
  return childStats;
}

function toEntry(name: string, stats: { isDirectory(): boolean; mtimeMs: number; size: number }) {
  const entry: NotesVaultEntry = {
    kind: stats.isDirectory() ? 'directory' : 'file',
    lastModified: stats.mtimeMs,
    name,
    size: Number(stats.size),
  };
  return entry;
}

/**
 * Build the dependency-injected notes-vault handlers. Production wiring (native
 * dialog, `app.getPath`, the shared chokidar-backed watcher) lives in
 * `ipc-notes-vault.ts`; tests inject fakes.
 */
export interface NotesVaultIpcHandlersOptions {
  /** Directory that CONTAINS the default vault (documents dir, or userData fallback). */
  readonly getDefaultVaultParentPath: () => string;
  /** Native directory picker; resolves null when the user cancels. */
  readonly pickDirectoryPath: () => Promise<string | null>;
  /**
   * Recursive watcher factory: `onChange` fires (already debounced/batched) on
   * any change under `directoryPath`; the return value stops the watcher.
   */
  readonly startWatch: (directoryPath: string, onChange: () => void) => () => void;
}

export interface NotesVaultIpcHandlers {
  ensureDefaultVault: () => Promise<NotesVaultResult<NotesVaultRoot>>;
  listDirectory: (requestedPath: unknown) => Promise<NotesVaultResult<NotesVaultEntry[]>>;
  pickDirectory: () => Promise<NotesVaultResult<NotesVaultRoot | null>>;
  readFile: (requestedPath: unknown) => Promise<NotesVaultResult<string>>;
  registerRoot: (requestedPath: unknown) => Promise<NotesVaultResult<NotesVaultRoot>>;
  statEntry: (requestedPath: unknown) => Promise<NotesVaultResult<NotesVaultEntry | null>>;
  /**
   * `requesterId` is the calling renderer's `WebContents.id`. unwatch rejects
   * when it does not match the watcher's owner (same "no live watcher" error as
   * an unknown id — no ownership-leak oracle), mirroring the terminal domain.
   */
  unwatch: (rawWatchId: unknown, requesterId: number) => NotesVaultResult<null>;
  watch: (
    owner: WebContents,
    requestedPath: unknown
  ) => Promise<NotesVaultResult<{ watchId: string }>>;
  writeFile: (
    requestedPath: unknown,
    content: unknown
  ) => Promise<NotesVaultResult<{ lastModified: number }>>;
}

export function createNotesVaultIpcHandlers(
  options: NotesVaultIpcHandlersOptions
): NotesVaultIpcHandlers {
  /**
   * Validate an on-disk directory (exists, is a directory, passes the
   * sensitive-path checks, realpath'd) and register it as an approved root.
   */
  async function validateAndRegisterRoot(
    requestedPath: unknown
  ): Promise<NotesVaultResult<NotesVaultRoot>> {
    const raw = validateRawVaultPath(requestedPath);
    if ('error' in raw) {
      return { error: raw.error, ok: false };
    }
    // blockSensitiveDirectories + allowMissing:false → the path must exist and
    // the returned path is canonical (realpath'd), with the sensitive check
    // re-run AFTER symlink resolution.
    const validated = await resolveValidatedPath({
      allowMissing: false,
      blockSensitiveDirectories: true,
      requestedPath: raw.lexicalPath,
    });
    if (!validated.ok) {
      logger.warn('Rejected notes vault root', {
        code: validated.error.code,
        error: validated.error.message,
        path: raw.lexicalPath,
      });
      return { error: validated.error.message, ok: false };
    }
    try {
      const stats = await fsPromises.stat(validated.path);
      if (!stats.isDirectory()) {
        return { error: `Path "${raw.lexicalPath}" is not a directory.`, ok: false };
      }
    } catch (error) {
      return failure('registerRoot', error, { path: raw.lexicalPath });
    }
    return { ok: true, value: registerApprovedRoot(validated.path) };
  }

  async function ensureDefaultVault(): Promise<NotesVaultResult<NotesVaultRoot>> {
    try {
      const parentPath = options.getDefaultVaultParentPath();
      const vaultPath = path.join(parentPath, DEFAULT_NOTES_VAULT_DIRECTORY_NAME);
      let created = false;
      let stats: import('node:fs').Stats | undefined;
      try {
        stats = await fsPromises.lstat(vaultPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      if (stats) {
        // An existing symlink at the default vault path could redirect every
        // vault operation elsewhere — refuse it rather than follow it.
        if (stats.isSymbolicLink()) {
          return { error: `Default vault path "${vaultPath}" is a symlink.`, ok: false };
        }
        if (!stats.isDirectory()) {
          return { error: `Default vault path "${vaultPath}" is not a directory.`, ok: false };
        }
      } else {
        await fsPromises.mkdir(vaultPath, { recursive: true });
        created = true;
      }
      const canonicalPath = await fsPromises.realpath(vaultPath);
      if (created) {
        // Seed the welcome note ONLY on first creation — a user who deletes it
        // never sees it again. Contained write (symlink-safe, O_NOFOLLOW).
        await writeContainedFileBytes({
          buffer: Buffer.from(WELCOME_NOTE_CONTENT, 'utf8'),
          requestedPath: WELCOME_NOTE_NAME,
          resolved: {
            absolutePath: path.join(canonicalPath, WELCOME_NOTE_NAME),
            canonicalRootPath: canonicalPath,
          },
        });
        logger.info('Seeded default notes vault', { path: canonicalPath });
      }
      return { ok: true, value: registerApprovedRoot(canonicalPath) };
    } catch (error) {
      return failure('ensureDefaultVault', error);
    }
  }

  async function pickDirectory(): Promise<NotesVaultResult<NotesVaultRoot | null>> {
    let picked: string | null;
    try {
      picked = await options.pickDirectoryPath();
    } catch (error) {
      return failure('pickDirectory', error);
    }
    if (picked === null) {
      // User cancelled — a normal outcome, not an error.
      return { ok: true, value: null };
    }
    return await validateAndRegisterRoot(picked);
  }

  function registerRoot(requestedPath: unknown): Promise<NotesVaultResult<NotesVaultRoot>> {
    return validateAndRegisterRoot(requestedPath);
  }

  async function listDirectory(
    requestedPath: unknown
  ): Promise<NotesVaultResult<NotesVaultEntry[]>> {
    const resolved = await resolveApprovedReadPath(requestedPath, false);
    if ('error' in resolved) {
      return { error: resolved.error, ok: false };
    }
    if (resolved.missing) {
      return { error: `Path "${String(requestedPath)}" does not exist.`, ok: false };
    }
    try {
      const dirents = await fsPromises.readdir(resolved.canonicalPath, { withFileTypes: true });
      const entries: NotesVaultEntry[] = [];
      for (const dirent of dirents) {
        const childStats = await lstatListableChild(path.join(resolved.canonicalPath, dirent.name));
        if (childStats) {
          entries.push(toEntry(dirent.name, childStats));
        }
      }
      return { ok: true, value: entries };
    } catch (error) {
      return failure('listDirectory', error, { path: resolved.canonicalPath });
    }
  }

  async function statEntry(
    requestedPath: unknown
  ): Promise<NotesVaultResult<NotesVaultEntry | null>> {
    const resolved = await resolveApprovedReadPath(requestedPath, true);
    if ('error' in resolved) {
      return { error: resolved.error, ok: false };
    }
    if (resolved.missing) {
      return { ok: true, value: null };
    }
    try {
      const stats = await fsPromises.stat(resolved.canonicalPath);
      if (!(stats.isFile() || stats.isDirectory())) {
        return {
          error: `Path "${resolved.canonicalPath}" is neither a file nor a directory.`,
          ok: false,
        };
      }
      return { ok: true, value: toEntry(path.basename(resolved.canonicalPath), stats) };
    } catch (error) {
      return failure('statEntry', error, { path: resolved.canonicalPath });
    }
  }

  async function readFile(requestedPath: unknown): Promise<NotesVaultResult<string>> {
    const resolved = await resolveApprovedReadPath(requestedPath, false);
    if ('error' in resolved) {
      return { error: resolved.error, ok: false };
    }
    if (resolved.missing) {
      return { error: `Path "${String(requestedPath)}" does not exist.`, ok: false };
    }
    try {
      const stats = await fsPromises.stat(resolved.canonicalPath);
      if (!stats.isFile()) {
        return { error: `Path "${resolved.canonicalPath}" is not a file.`, ok: false };
      }
      if (stats.size > MAX_NOTES_VAULT_READ_BYTES) {
        return {
          error: `Path "${resolved.canonicalPath}" exceeds ${MAX_NOTES_VAULT_READ_BYTES} bytes and cannot be read as a note.`,
          ok: false,
        };
      }
      const content = await fsPromises.readFile(resolved.canonicalPath, 'utf8');
      return { ok: true, value: content };
    } catch (error) {
      return failure('readFile', error, { path: resolved.canonicalPath });
    }
  }

  async function writeFile(
    requestedPath: unknown,
    content: unknown
  ): Promise<NotesVaultResult<{ lastModified: number }>> {
    if (typeof content !== 'string') {
      return { error: 'Notes vault writeFile requires a string content payload.', ok: false };
    }
    const raw = validateRawVaultPath(requestedPath);
    if ('error' in raw) {
      return { error: raw.error, ok: false };
    }
    const rootPath = findApprovedRootFor(raw.lexicalPath);
    if (rootPath === null) {
      return { error: outsideRootsError(raw.lexicalPath), ok: false };
    }
    const relativePath = path.relative(rootPath, raw.lexicalPath);
    if (relativePath.length === 0) {
      return {
        error: `Path "${raw.lexicalPath}" is a vault root, not a writable file.`,
        ok: false,
      };
    }
    try {
      // The audited write path: canonical-ancestor containment, symlink-leaf
      // rejection, component-wise parent creation, O_NOFOLLOW open.
      const resolved = await resolveWorkspaceWritePath(rootPath, relativePath);
      await writeContainedFileBytes({
        buffer: Buffer.from(content, 'utf8'),
        requestedPath: raw.lexicalPath,
        resolved,
      });
      const stats = await fsPromises.stat(resolved.absolutePath);
      return { ok: true, value: { lastModified: stats.mtimeMs } };
    } catch (error) {
      return failure('writeFile', error, { path: raw.lexicalPath });
    }
  }

  async function watch(
    owner: WebContents,
    requestedPath: unknown
  ): Promise<NotesVaultResult<{ watchId: string }>> {
    const resolved = await resolveApprovedReadPath(requestedPath, false);
    if ('error' in resolved) {
      return { error: resolved.error, ok: false };
    }
    if (resolved.missing) {
      return { error: `Path "${String(requestedPath)}" does not exist.`, ok: false };
    }
    try {
      const stats = await fsPromises.stat(resolved.canonicalPath);
      if (!stats.isDirectory()) {
        return { error: `Path "${resolved.canonicalPath}" is not a directory.`, ok: false };
      }
      const watchId = `notes-watch-${randomUUID()}`;
      const stop = options.startWatch(resolved.canonicalPath, () => {
        // Push to the OWNING renderer only (never a broadcast).
        if (owner.isDestroyed()) {
          return;
        }
        const payload: NotesVaultChangedEvent = { watchId };
        owner.send(DESKTOP_IPC_CHANNELS.notesVault.changed, payload);
      });
      liveWatchers.set(watchId, { ownerId: owner.id, stop, webContents: owner });

      // Reap every watcher this renderer owns when it is destroyed (window
      // closed / navigated away). ONE reaper per WebContents — see
      // reaperAttachedOwners.
      if (!reaperAttachedOwners.has(owner)) {
        reaperAttachedOwners.add(owner);
        owner.once('destroyed', () => {
          reaperAttachedOwners.delete(owner);
          disposeNotesVaultWatchersForWebContents(owner.id);
        });
      }

      logger.debug('Started notes vault watcher', { path: resolved.canonicalPath, watchId });
      return { ok: true, value: { watchId } };
    } catch (error) {
      return failure('watch', error, { path: resolved.canonicalPath });
    }
  }

  function unwatch(rawWatchId: unknown, requesterId: number): NotesVaultResult<null> {
    const watchId = typeof rawWatchId === 'string' ? rawWatchId : '';
    const entry = liveWatchers.get(watchId);
    const notFound = `No live notes vault watcher "${String(rawWatchId)}".`;
    if (!entry) {
      return { error: notFound, ok: false };
    }
    if (entry.ownerId !== requesterId) {
      logger.warn('Rejected notes vault unwatch from non-owner renderer', {
        ownerId: entry.ownerId,
        requesterId,
        watchId,
      });
      // Same error as an unknown id — no ownership-leak oracle.
      return { error: notFound, ok: false };
    }
    liveWatchers.delete(watchId);
    stopWatcher(watchId, entry);
    return { ok: true, value: null };
  }

  return {
    ensureDefaultVault,
    listDirectory,
    pickDirectory,
    readFile,
    registerRoot,
    statEntry,
    unwatch,
    watch,
    writeFile,
  };
}

function stopWatcher(watchId: string, entry: LiveNotesVaultWatcher): void {
  try {
    entry.stop();
  } catch (error) {
    // Logged, never swallowed silently (no-silent-fallbacks); the map entry is
    // already removed, so a failed close cannot leak a live id.
    logger.warn('Failed to stop notes vault watcher', {
      error: toErrorMessage(error),
      watchId,
    });
  }
}

/**
 * Stop every still-live watcher. Wired into the domain disposer (and thus the
 * shutdown path). Returns the count reaped, mirroring disposeAllTerminals.
 */
export function disposeAllNotesVaultWatchers(): number {
  const entries = Array.from(liveWatchers.entries());
  liveWatchers.clear();
  for (const [watchId, entry] of entries) {
    stopWatcher(watchId, entry);
  }
  if (entries.length > 0) {
    logger.info('Reaped live notes vault watchers on dispose', { count: entries.length });
  }
  return entries.length;
}

/** Stop + drop every watcher owned by a destroyed/navigated-away renderer. */
export function disposeNotesVaultWatchersForWebContents(ownerId: number): number {
  let reaped = 0;
  for (const [watchId, entry] of Array.from(liveWatchers.entries())) {
    if (entry.ownerId !== ownerId) {
      continue;
    }
    liveWatchers.delete(watchId);
    stopWatcher(watchId, entry);
    reaped += 1;
  }
  if (reaped > 0) {
    logger.info('Reaped notes vault watchers for destroyed renderer', { count: reaped, ownerId });
  }
  return reaped;
}

/** Test-only: current count of live watchers. */
export function liveNotesVaultWatcherCountForTest(): number {
  return liveWatchers.size;
}

/** Test-only: current count of approved roots. */
export function approvedNotesVaultRootCountForTest(): number {
  return approvedRoots.size;
}

/** Test-only: reap watchers AND forget every approved root (module state reset). */
export function resetNotesVaultIpcStateForTest(): void {
  disposeAllNotesVaultWatchers();
  approvedRoots.clear();
}

/**
 * Register the desktop `notesVault` IPC domain. Returns a disposer that
 * unregisters the channels, reaps every live watcher, AND forgets the approved
 * roots (a host re-init must re-approve). The `notes-vault:changed` event
 * channel is NOT an `ipcMain.handle` registration — it is a one-way
 * main→renderer push, so it is never registered here; the registry owns only
 * the nine invoke channels.
 */
export function registerNotesVaultIpcHandlers(handlers: NotesVaultIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('notesVault', DESKTOP_IPC_CHANNELS.notesVault.ensureDefaultVault, () =>
    handlers.ensureDefaultVault()
  );
  registry.registerInvoke('notesVault', DESKTOP_IPC_CHANNELS.notesVault.pickDirectory, () =>
    handlers.pickDirectory()
  );
  registry.registerInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.registerRoot,
    (_event, requestedPath: unknown) => handlers.registerRoot(requestedPath)
  );
  registry.registerInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.listDirectory,
    (_event, requestedPath: unknown) => handlers.listDirectory(requestedPath)
  );
  registry.registerInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.statEntry,
    (_event, requestedPath: unknown) => handlers.statEntry(requestedPath)
  );
  registry.registerInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.readFile,
    (_event, requestedPath: unknown) => handlers.readFile(requestedPath)
  );
  registry.registerInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.writeFile,
    (_event, requestedPath: unknown, content: unknown) => handlers.writeFile(requestedPath, content)
  );
  registry.registerInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.watch,
    (event: IpcMainInvokeEvent, requestedPath: unknown) =>
      handlers.watch(event.sender, requestedPath)
  );
  registry.registerInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.unwatch,
    (event: IpcMainInvokeEvent, rawWatchId: unknown) =>
      handlers.unwatch(rawWatchId, event.sender.id)
  );

  return () => {
    registry.unregisterAll();
    disposeAllNotesVaultWatchers();
    approvedRoots.clear();
  };
}
