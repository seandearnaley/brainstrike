/**
 * Main-process handlers for the desktop `notesVault` IPC domain — a Node-fs
 * backend for the markdown notes vault (no File System Access API in the
 * renderer; the OS grants access).
 *
 * Security model — APPROVED ROOTS, OWNED BY MAIN. A module-level map holds the
 * canonical (realpath'd) directory paths the user has approved as vault roots,
 * and main ALSO persists that list durably (storage key
 * {@link NOTES_VAULT_ROOTS_STORAGE_KEY}, mirroring the files domain's
 * `rootsList`) so approval survives restart without trusting the renderer:
 *   - `ensureDefaultVault` approves the app-chosen default vault directory
 *     (in-memory + persisted),
 *   - `pickDirectory` approves what the user picked in the native dialog
 *     (in-memory + persisted),
 *   - `registerRoot` only RE-approves a path that is already in main's
 *     persisted list (after validation: must exist, be a directory, and pass
 *     the sensitive-path checks). A renderer can therefore never self-approve
 *     an arbitrary path — new roots enter the list solely via the native
 *     picker or the default vault.
 * Every read (listDirectory/statEntry/readFile) resolves the renderer-supplied
 * absolute path lexically AND canonically (realpath) and requires containment
 * inside SOME approved root — a symlink whose target escapes every approved
 * root is refused. Every write goes through the SINGLE audited write path
 * (`secure-file-write.ts`: `resolveWorkspaceWritePath` +
 * `writeContainedFileBytes`), scoped to the owning approved root.
 *
 * Watching: `watch` starts a recursive, debounced watcher (the shared
 * @parcel/watcher-backed electron watcher from `@brainstrike/file-system/electron`,
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
import { createLogger } from '@brainstrike/logging';
import { WELCOME_NOTE_CONTENT, WELCOME_NOTE_NAME } from '@brainstrike/notes-vault/core';
import type {
  NotesVaultBridgeEntry,
  NotesVaultBridgeRoot,
  NotesVaultResult,
} from '@brainstrike/notes-vault/desktop-contract';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { ipcMain } from 'electron';
import { isWithinRoot } from './assistant-server/workspace-path';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import {
  ensureContainedDirectory,
  resolveWorkspaceWritePath,
  writeContainedFileBytes,
} from './secure-file-write';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

const logger = createLogger('NotesVaultIpc');

/** Directory name of the app-managed default vault (under the OS documents dir). */
export const DEFAULT_NOTES_VAULT_DIRECTORY_NAME = 'Brainstrike Notes';

/** Explicit read ceiling so a renderer cannot pull an arbitrarily large file over IPC. */
export const MAX_NOTES_VAULT_READ_BYTES = 10 * 1024 * 1024;

/**
 * Durable storage key for main's approved-roots list: a JSON array of
 * canonical absolute paths. The single source of truth for which roots
 * `registerRoot` may re-approve after a restart.
 */
export const NOTES_VAULT_ROOTS_STORAGE_KEY = 'notesVaultRoots';

/** Local aliases for the shared bridge-contract types (single source of truth). */
export type { NotesVaultResult } from '@brainstrike/notes-vault/desktop-contract';
export type NotesVaultEntry = NotesVaultBridgeEntry;
export type NotesVaultRoot = NotesVaultBridgeRoot;

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

/**
 * A logged policy refusal (containment breach, missing entry, no-overwrite,
 * …) — same `{ ok: false }` shape as {@link failure}, but for deliberate
 * rejections rather than thrown errors. Every mutation refusal goes through
 * here so nothing fails silently.
 */
function refusal<T>(
  operation: string,
  message: string,
  context: Record<string, unknown> = {}
): NotesVaultResult<T> {
  logger.warn('Notes vault operation refused', { ...context, operation, reason: message });
  return { error: message, ok: false };
}

/**
 * Minimal durable-storage surface the registrar needs for the approved-roots
 * list. Production injects the shared `ElectronStorageAdapter` (same DI style
 * as the files domain); tests inject an in-memory fake.
 */
export interface NotesVaultRootsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * Read main's persisted approved-roots list. Malformed storage is logged and
 * treated as empty (mirrors the files domain's `readRootsList` — loud, never
 * silent), so one corrupt value cannot brick every vault restore.
 */
async function readPersistedRoots(storage: NotesVaultRootsStorage): Promise<string[]> {
  const raw = await storage.getItem(NOTES_VAULT_ROOTS_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn('Failed to parse persisted notes vault roots — treating as empty', {
      error: toErrorMessage(error),
      key: NOTES_VAULT_ROOTS_STORAGE_KEY,
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warn('Persisted notes vault roots value is not an array — treating as empty', {
      key: NOTES_VAULT_ROOTS_STORAGE_KEY,
    });
    return [];
  }
  const valid = parsed.filter((entry): entry is string => typeof entry === 'string');
  if (valid.length !== parsed.length) {
    logger.warn('Persisted notes vault roots contained malformed entries — discarding them', {
      total: parsed.length,
      valid: valid.length,
    });
  }
  return valid;
}

/**
 * Add a canonical path to the persisted approved-roots list (idempotent).
 * No mutex: approvals are user-gesture-driven (one native dialog at a time),
 * same reasoning as the files domain's `addRoot`.
 */
async function persistApprovedRoot(
  storage: NotesVaultRootsStorage,
  canonicalPath: string
): Promise<void> {
  const existing = await readPersistedRoots(storage);
  if (existing.includes(canonicalPath)) {
    return;
  }
  await storage.setItem(
    NOTES_VAULT_ROOTS_STORAGE_KEY,
    JSON.stringify([...existing, canonicalPath])
  );
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
 * Lexical policy checks for a rename request: both paths must be valid
 * absolute vault paths under the SAME approved root, the source must not be a
 * root itself, and the parent directories must match — the bridge contract is
 * SAME-DIRECTORY rename only (a cross-directory move is a different operation
 * with different containment obligations).
 */
function validateRenameRequest(
  fromRequested: unknown,
  toRequested: unknown
): { error: string } | { fromPath: string; toPath: string } {
  const rawFrom = validateRawVaultPath(fromRequested);
  if ('error' in rawFrom) {
    return rawFrom;
  }
  const rawTo = validateRawVaultPath(toRequested);
  if ('error' in rawTo) {
    return rawTo;
  }
  const fromRoot = findApprovedRootFor(rawFrom.lexicalPath);
  if (fromRoot === null) {
    return { error: outsideRootsError(rawFrom.lexicalPath) };
  }
  const toRoot = findApprovedRootFor(rawTo.lexicalPath);
  if (toRoot === null) {
    return { error: outsideRootsError(rawTo.lexicalPath) };
  }
  if (fromRoot !== toRoot) {
    return {
      error: `Rename must stay inside one approved root: "${rawFrom.lexicalPath}" and "${rawTo.lexicalPath}" resolve to different roots.`,
    };
  }
  if (rawFrom.lexicalPath === fromRoot) {
    return { error: `Path "${rawFrom.lexicalPath}" is a vault root and cannot be renamed.` };
  }
  if (path.dirname(rawFrom.lexicalPath) !== path.dirname(rawTo.lexicalPath)) {
    return {
      error: `Rename is same-directory only: "${rawFrom.lexicalPath}" -> "${rawTo.lexicalPath}" cross directories.`,
    };
  }
  return { fromPath: rawFrom.lexicalPath, toPath: rawTo.lexicalPath };
}

/**
 * Filesystem-level resolution for a validated rename: canonicalize the SHARED
 * parent once (the dirnames are equal per {@link validateRenameRequest}) and
 * re-check containment, so a symlinked intermediate directory cannot redirect
 * the rename outside every approved root; require an existing, NON-symlink
 * source leaf (the vault contract has no symlink kind — renaming a link
 * relocates an escape hatch rather than a note); and refuse an existing
 * destination of ANY kind — lstat, so even a dangling symlink blocks (NO
 * OVERWRITE). Throws on unexpected fs errors; the caller maps them.
 */
async function resolveRenameLeaves(
  fromPath: string,
  toPath: string
): Promise<{ error: string } | { fromLeaf: string; toLeaf: string }> {
  const canonicalParent = await fsPromises.realpath(path.dirname(fromPath));
  if (findApprovedRootFor(canonicalParent) === null) {
    return { error: outsideRootsError(fromPath) };
  }
  const fromLeaf = path.join(canonicalParent, path.basename(fromPath));
  const toLeaf = path.join(canonicalParent, path.basename(toPath));
  let fromStats: import('node:fs').Stats;
  try {
    fromStats = await fsPromises.lstat(fromLeaf);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { error: `Path "${fromPath}" does not exist.` };
    }
    throw error;
  }
  if (fromStats.isSymbolicLink()) {
    return { error: `Path "${fromPath}" is a symlink and cannot be renamed.` };
  }
  let toStats: import('node:fs').Stats;
  try {
    toStats = await fsPromises.lstat(toLeaf);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return { fromLeaf, toLeaf };
  }
  // Case-only rename on a case-insensitive/case-preserving filesystem
  // (default macOS): the "existing destination" lstat resolves to the SOURCE
  // itself. Same inode + names differing only by case is the source, not a
  // collision — refusing it would make letter-casing fixes impossible.
  const isSameEntry = toStats.dev === fromStats.dev && toStats.ino === fromStats.ino;
  const isCaseOnly = fromLeaf !== toLeaf && fromLeaf.toLowerCase() === toLeaf.toLowerCase();
  if (isSameEntry && isCaseOnly) {
    return { fromLeaf, toLeaf };
  }
  return { error: `Destination "${toPath}" already exists.` };
}

/**
 * Leaf-preserving resolution for deleteEntry (mirrors
 * {@link resolveRenameLeaves}): canonicalize only the PARENT, then lstat the
 * leaf itself. A realpath of the full path would dereference a symlink leaf
 * and hand the symlink's TARGET to the trash — deleting a file the user never
 * pointed at. The vault contract has no symlink kind, so a symlink leaf is
 * refused outright. Throws on unexpected fs errors; the caller maps them.
 */
async function resolveDeleteLeaf(
  lexicalPath: string
): Promise<{ error: string } | { leaf: string }> {
  const canonicalParent = await fsPromises.realpath(path.dirname(lexicalPath));
  if (findApprovedRootFor(canonicalParent) === null) {
    return { error: outsideRootsError(lexicalPath) };
  }
  const leaf = path.join(canonicalParent, path.basename(lexicalPath));
  let leafStats: import('node:fs').Stats;
  try {
    leafStats = await fsPromises.lstat(leaf);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { error: `Path "${lexicalPath}" does not exist.` };
    }
    throw error;
  }
  if (leafStats.isSymbolicLink()) {
    return { error: `Path "${lexicalPath}" is a symlink and cannot be deleted.` };
  }
  if (approvedRoots.has(leaf)) {
    return { error: `Path "${leaf}" is an approved notes vault root and cannot be deleted.` };
  }
  return { leaf };
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
 * dialog, `app.getPath`, the shared parcel-backed watcher) lives in
 * `ipc-notes-vault.ts`; tests inject fakes.
 */
export interface NotesVaultIpcHandlersOptions {
  /** Directory that CONTAINS the default vault (documents dir, or userData fallback). */
  readonly getDefaultVaultParentPath: () => string;
  /** Native directory picker; resolves null when the user cancels. */
  readonly pickDirectoryPath: () => Promise<string | null>;
  /**
   * Recursive watcher factory: `onChange` fires (already debounced/batched) on
   * any change under `directoryPath`; resolves with a disposer only after the
   * native subscription reports healthy.
   */
  readonly startWatch: (directoryPath: string, onChange: () => void) => Promise<() => void>;
  /**
   * Durable storage for main's approved-roots list ({@link
   * NOTES_VAULT_ROOTS_STORAGE_KEY}). Production: the shared
   * `ElectronStorageAdapter`; tests: an in-memory fake.
   */
  readonly storage: NotesVaultRootsStorage;
  /**
   * Moves an on-disk entry to the OS trash (recoverable). Production:
   * Electron's `shell.trashItem`; tests inject a fake so no real trashing
   * happens. Rejects on failure (e.g. no trash available for the volume).
   */
  readonly trashItem: (absolutePath: string) => Promise<void>;
}

export interface NotesVaultIpcHandlers {
  /** Contained mkdir under an approved root; refuses an existing entry. */
  createDirectory: (requestedPath: unknown) => Promise<NotesVaultResult<null>>;
  /**
   * Moves a contained entry to the OS TRASH (never `fs.rm`). `recursive` is
   * advisory (FSA-contract parity); trashing a directory is inherently
   * recursive. Refuses approved roots themselves, paths outside every
   * approved root, and missing entries.
   */
  deleteEntry: (requestedPath: unknown, rawOptions: unknown) => Promise<NotesVaultResult<null>>;
  ensureDefaultVault: () => Promise<NotesVaultResult<NotesVaultRoot>>;
  listDirectory: (requestedPath: unknown) => Promise<NotesVaultResult<NotesVaultEntry[]>>;
  pickDirectory: () => Promise<NotesVaultResult<NotesVaultRoot | null>>;
  readFile: (requestedPath: unknown) => Promise<NotesVaultResult<string>>;
  registerRoot: (requestedPath: unknown) => Promise<NotesVaultResult<NotesVaultRoot>>;
  /**
   * SAME-DIRECTORY rename (the bridge contract's only move shape): both paths
   * must live under the same approved root and share a parent directory;
   * refuses a symlink source leaf and never overwrites an existing
   * destination.
   */
  rename: (fromRequested: unknown, toRequested: unknown) => Promise<NotesVaultResult<null>>;
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
   * sensitive-path checks, realpath'd). Returns the CANONICAL path — approval
   * and persistence are the caller's decision.
   */
  async function validateRootDirectory(
    requestedPath: unknown
  ): Promise<{ canonicalPath: string } | { error: string }> {
    const raw = validateRawVaultPath(requestedPath);
    if ('error' in raw) {
      return { error: raw.error };
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
      return { error: validated.error.message };
    }
    try {
      const stats = await fsPromises.stat(validated.path);
      if (!stats.isDirectory()) {
        return { error: `Path "${raw.lexicalPath}" is not a directory.` };
      }
    } catch (error) {
      const message = toErrorMessage(error);
      logger.warn('Notes vault operation failed', {
        error: message,
        operation: 'validateRootDirectory',
        path: raw.lexicalPath,
      });
      return { error: message };
    }
    return { canonicalPath: validated.path };
  }

  /**
   * Approve a validated canonical path in-memory AND persist it into main's
   * durable approved-roots list, so `registerRoot` can re-approve it after a
   * restart. A failed persist write is loud but non-fatal (the root still
   * works this session; the next restart's `registerRoot` fails visibly) —
   * same posture as the files domain's `addRoot`.
   */
  async function approveAndPersistRoot(canonicalPath: string): Promise<NotesVaultRoot> {
    const root = registerApprovedRoot(canonicalPath);
    try {
      await persistApprovedRoot(options.storage, canonicalPath);
    } catch (error) {
      logger.warn('Failed to persist notes vault root approval', {
        error: toErrorMessage(error),
        path: canonicalPath,
      });
    }
    return root;
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
      return { ok: true, value: await approveAndPersistRoot(canonicalPath) };
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
    const validated = await validateRootDirectory(picked);
    if ('error' in validated) {
      return { error: validated.error, ok: false };
    }
    return { ok: true, value: await approveAndPersistRoot(validated.canonicalPath) };
  }

  /**
   * Re-approve a root after restart. The renderer supplies the path it
   * persisted, but MAIN's durable list is the authority: only paths that were
   * previously approved via the picker or the default vault are accepted —
   * a renderer can never self-approve an arbitrary directory.
   */
  async function registerRoot(requestedPath: unknown): Promise<NotesVaultResult<NotesVaultRoot>> {
    const validated = await validateRootDirectory(requestedPath);
    if ('error' in validated) {
      return { error: validated.error, ok: false };
    }
    let persistedRoots: string[];
    try {
      persistedRoots = await readPersistedRoots(options.storage);
    } catch (error) {
      return failure('registerRoot', error, { path: validated.canonicalPath });
    }
    if (!persistedRoots.includes(validated.canonicalPath)) {
      logger.warn('Rejected notes vault root not in the persisted approved list', {
        path: validated.canonicalPath,
      });
      return {
        error: `Path "${validated.canonicalPath}" is not an approved notes vault root. Add it via the vault directory picker.`,
        ok: false,
      };
    }
    return { ok: true, value: registerApprovedRoot(validated.canonicalPath) };
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
        // A vanished parent means the folder was renamed/deleted while an
        // editor still held the old path — fail loudly rather than silently
        // recreating the directory with stale content.
        requireParentDirectory: true,
        resolved,
      });
      const stats = await fsPromises.stat(resolved.absolutePath);
      return { ok: true, value: { lastModified: stats.mtimeMs } };
    } catch (error) {
      return failure('writeFile', error, { path: raw.lexicalPath });
    }
  }

  async function createDirectory(requestedPath: unknown): Promise<NotesVaultResult<null>> {
    const raw = validateRawVaultPath(requestedPath);
    if ('error' in raw) {
      return refusal('createDirectory', raw.error);
    }
    const rootPath = findApprovedRootFor(raw.lexicalPath);
    if (rootPath === null) {
      return refusal('createDirectory', outsideRootsError(raw.lexicalPath));
    }
    if (raw.lexicalPath === rootPath) {
      return refusal(
        'createDirectory',
        `Path "${raw.lexicalPath}" is a vault root and already exists.`
      );
    }
    try {
      // Refuse when ANY entry — file, directory, or symlink (live OR
      // dangling, hence lstat) — already occupies the path.
      let existing: import('node:fs').Stats | undefined;
      try {
        existing = await fsPromises.lstat(raw.lexicalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      if (existing) {
        return refusal('createDirectory', `Path "${raw.lexicalPath}" already exists.`);
      }
      // The audited contained mkdir (secure-file-write.ts): creates missing
      // components one at a time, refusing symlinked intermediates — a plain
      // `mkdir -p` could traverse a symlink out of the root. Approved roots
      // are stored canonical, satisfying its canonical-root precondition.
      await ensureContainedDirectory(rootPath, raw.lexicalPath);
      return { ok: true, value: null };
    } catch (error) {
      return failure('createDirectory', error, { path: raw.lexicalPath });
    }
  }

  async function deleteEntry(
    requestedPath: unknown,
    rawOptions: unknown
  ): Promise<NotesVaultResult<null>> {
    const recursive =
      rawOptions !== null && typeof rawOptions === 'object'
        ? (rawOptions as { recursive?: unknown }).recursive
        : undefined;
    if (typeof recursive !== 'boolean') {
      return refusal('deleteEntry', 'Notes vault deleteEntry requires a boolean recursive option.');
    }
    const raw = validateRawVaultPath(requestedPath);
    if ('error' in raw) {
      return refusal('deleteEntry', raw.error);
    }
    const rootPath = findApprovedRootFor(raw.lexicalPath);
    if (rootPath === null) {
      return refusal('deleteEntry', outsideRootsError(raw.lexicalPath));
    }
    if (raw.lexicalPath === rootPath) {
      return refusal(
        'deleteEntry',
        `Path "${raw.lexicalPath}" is an approved notes vault root and cannot be deleted.`
      );
    }
    try {
      const resolved = await resolveDeleteLeaf(raw.lexicalPath);
      if ('error' in resolved) {
        return refusal('deleteEntry', resolved.error);
      }
      // RECOVERABLE deletion: the OS trash, never fs.rm. Trashing a directory
      // is inherently recursive, so the validated `recursive` flag is advisory
      // (kept for parity with the renderer's FSA-shaped contract).
      await options.trashItem(resolved.leaf);
      logger.info('Moved notes vault entry to trash', { path: resolved.leaf });
      return { ok: true, value: null };
    } catch (error) {
      return failure('deleteEntry', error, { path: raw.lexicalPath, recursive });
    }
  }

  async function rename(
    fromRequested: unknown,
    toRequested: unknown
  ): Promise<NotesVaultResult<null>> {
    const validated = validateRenameRequest(fromRequested, toRequested);
    if ('error' in validated) {
      return refusal('rename', validated.error);
    }
    const { fromPath, toPath } = validated;
    try {
      const leaves = await resolveRenameLeaves(fromPath, toPath);
      if ('error' in leaves) {
        return refusal('rename', leaves.error);
      }
      await fsPromises.rename(leaves.fromLeaf, leaves.toLeaf);
      return { ok: true, value: null };
    } catch (error) {
      return failure('rename', error, { fromPath, toPath });
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
      const stop = await options.startWatch(resolved.canonicalPath, () => {
        // Push to the OWNING renderer only (never a broadcast).
        if (owner.isDestroyed()) {
          return;
        }
        const payload: NotesVaultChangedEvent = { watchId };
        owner.send(DESKTOP_IPC_CHANNELS.notesVault.changed, payload);
      });
      if (owner.isDestroyed()) {
        stop();
        return {
          error: 'Notes vault watcher owner was destroyed during setup.',
          ok: false,
        };
      }
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
    createDirectory,
    deleteEntry,
    ensureDefaultVault,
    listDirectory,
    pickDirectory,
    readFile,
    registerRoot,
    rename,
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
 * unregisters the channels, reaps every live watcher, AND forgets the
 * IN-MEMORY approved roots (a host re-init must re-approve; the persisted
 * list survives so `registerRoot` can do so). The `notes-vault:changed` event
 * channel is NOT an `ipcMain.handle` registration — it is a one-way
 * main→renderer push, so it is never registered here; the registry owns only
 * the twelve invoke channels.
 */
export function registerNotesVaultIpcHandlers(handlers: NotesVaultIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.ensureDefaultVault,
    UNAUTHENTICATED_SENDER_POLICY,
    () => handlers.ensureDefaultVault()
  );
  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.pickDirectory,
    UNAUTHENTICATED_SENDER_POLICY,
    () => handlers.pickDirectory()
  );
  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.registerRoot,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, requestedPath: unknown) => handlers.registerRoot(requestedPath)
  );
  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.listDirectory,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, requestedPath: unknown) => handlers.listDirectory(requestedPath)
  );
  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.statEntry,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, requestedPath: unknown) => handlers.statEntry(requestedPath)
  );
  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.readFile,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, requestedPath: unknown) => handlers.readFile(requestedPath)
  );
  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.writeFile,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, requestedPath: unknown, content: unknown) => handlers.writeFile(requestedPath, content)
  );
  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.createDirectory,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, requestedPath: unknown) => handlers.createDirectory(requestedPath)
  );
  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.deleteEntry,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, requestedPath: unknown, rawOptions: unknown) =>
      handlers.deleteEntry(requestedPath, rawOptions)
  );
  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.rename,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, fromRequested: unknown, toRequested: unknown) =>
      handlers.rename(fromRequested, toRequested)
  );
  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.watch,
    UNAUTHENTICATED_SENDER_POLICY,
    (event: IpcMainInvokeEvent, requestedPath: unknown) =>
      handlers.watch(event.sender, requestedPath)
  );
  registry.registerUnauthenticatedInvoke(
    'notesVault',
    DESKTOP_IPC_CHANNELS.notesVault.unwatch,
    UNAUTHENTICATED_SENDER_POLICY,
    (event: IpcMainInvokeEvent, rawWatchId: unknown) =>
      handlers.unwatch(rawWatchId, event.sender.id)
  );

  return () => {
    registry.unregisterAll();
    disposeAllNotesVaultWatchers();
    approvedRoots.clear();
  };
}
