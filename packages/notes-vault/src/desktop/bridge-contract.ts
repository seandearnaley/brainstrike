/**
 * Contract for the desktop-native notes vault bridge (window.notesVault).
 *
 * The desktop preload exposes this shape; main implements it over Node fs +
 * a native watcher (no File System Access API, no permission ceremony — the OS
 * grants access). The renderer adapts it to VaultDirectoryHandleLike in
 * node-vault-handles.ts so the entire vault core/store/UI pipeline is shared
 * verbatim with the web backend.
 *
 * Result convention mirrors the git/terminal bridges: methods never reject
 * across IPC; failures come back as { ok: false, error } and the renderer
 * adapter converts them to thrown errors (NO SILENT FALLBACKS).
 */

export type NotesVaultResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface NotesVaultBridgeEntry {
  readonly kind: 'file' | 'directory';
  readonly lastModified: number;
  readonly name: string;
  readonly size: number;
}

export interface NotesVaultBridgeRoot {
  /** Display name (directory basename). */
  readonly name: string;
  /** Absolute path on disk. */
  readonly path: string;
}

export interface NotesVaultChangeEvent {
  readonly watchId: string;
}

export interface NotesVaultBridge {
  /** Contained mkdir under an approved root. */
  createDirectory(path: string): Promise<NotesVaultResult<null>>;
  /** Moves the entry to the OS trash (recoverable) — never a hard unlink. */
  deleteEntry(path: string, options: { recursive: boolean }): Promise<NotesVaultResult<null>>;
  /** Creates ~/Documents/Brainstrike Notes (seeding Welcome.md once) and
   * registers it as an approved vault root. */
  ensureDefaultVault(): Promise<NotesVaultResult<NotesVaultBridgeRoot>>;
  /** Immediate children of a directory (symlinks and hidden entries are the
   * renderer's concern to filter; symlinks are skipped in main). */
  listDirectory(path: string): Promise<NotesVaultResult<NotesVaultBridgeEntry[]>>;
  /** Subscribe to change pushes; returns unsubscribe. */
  onChanged(callback: (event: NotesVaultChangeEvent) => void): () => void;
  /** Native directory picker; value null = user cancelled. Picked paths are
   * registered as approved vault roots. */
  pickDirectory(): Promise<NotesVaultResult<NotesVaultBridgeRoot | null>>;
  readFile(path: string): Promise<NotesVaultResult<string>>;
  /** Re-approves a persisted root path after restart (validated in main:
   * must exist, be a directory, and pass sensitive-path checks). */
  registerRoot(path: string): Promise<NotesVaultResult<NotesVaultBridgeRoot>>;
  /** Same-directory rename; refuses to overwrite an existing entry. */
  rename(fromPath: string, toPath: string): Promise<NotesVaultResult<null>>;
  /** null = entry does not exist. */
  statEntry(path: string): Promise<NotesVaultResult<NotesVaultBridgeEntry | null>>;
  unwatch(watchId: string): Promise<NotesVaultResult<null>>;
  /** Recursive native watch (@parcel/watcher); events arrive via onChanged with this id. */
  watch(path: string): Promise<NotesVaultResult<{ watchId: string }>>;
  /** Atomic contained write (O_NOFOLLOW; temp+rename semantics in main).
   * Only paths under an approved vault root are writable. */
  writeFile(path: string, content: string): Promise<NotesVaultResult<{ lastModified: number }>>;
}

// Compile-time exact-set proof: `satisfies Record<keyof NotesVaultBridge,
// true>` fails the build if any interface method is missing here, and excess
// keys are rejected — so the pin can never silently become a subset (or
// superset) of the interface. The runtime pin only checks preload ↔ constant;
// this closes interface ↔ constant.
const NOTES_VAULT_BRIDGE_REQUIRED_METHOD_SET = {
  createDirectory: true,
  deleteEntry: true,
  ensureDefaultVault: true,
  listDirectory: true,
  onChanged: true,
  pickDirectory: true,
  readFile: true,
  registerRoot: true,
  rename: true,
  statEntry: true,
  unwatch: true,
  watch: true,
  writeFile: true,
} as const satisfies Record<keyof NotesVaultBridge, true>;

/**
 * Every method name the bridge must expose to be considered fully formed.
 * Exported so the desktop preload-runtime contract test can pin the
 * `window.notesVault` `exposeInMainWorld` key set to this exact list.
 *
 * NOTE: the pin is EXACT set equality, not a subset check — every method the
 * preload exposes must be listed here. There is no such thing as an optional
 * bridge method: a preload method missing from this list (or vice versa)
 * disables the entire surface via the resolver below.
 */
export const NOTES_VAULT_BRIDGE_REQUIRED_METHODS = Object.keys(
  NOTES_VAULT_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof NotesVaultBridge)[];

/**
 * Resolves window.notesVault if present AND fully formed. A present-but-
 * malformed bridge returns null after logging is the caller's concern —
 * this probe is dependency-light for the nav gate.
 */
export function resolveNotesVaultBridge(): NotesVaultBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = (window as { notesVault?: unknown }).notesVault;
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  for (const method of NOTES_VAULT_BRIDGE_REQUIRED_METHODS) {
    if (typeof (candidate as Record<string, unknown>)[method] !== 'function') {
      return null;
    }
  }
  return candidate as NotesVaultBridge;
}
