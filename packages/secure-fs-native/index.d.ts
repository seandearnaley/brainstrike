export interface SecureDirEntry {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly lastModified?: number;
  readonly name: string;
  readonly size?: number;
}

export interface SecureListResult {
  readonly entries: readonly SecureDirEntry[];
  readonly inspected: number;
  readonly truncated: boolean;
}

export type SecureReadResult =
  | { readonly status: 'ok'; readonly content: Buffer }
  | { readonly status: 'not-found' | 'oversized' | 'unreadable' };

export type PrivateReadResult =
  | { readonly status: 'ok'; readonly content: Buffer }
  | { readonly status: 'not-found' | 'unreadable' };

export class SecureRoot {
  constructor(canonicalAbsoluteRoot: string);
  /**
   * Canonical identity derived from the opened root handle (F_GETPATH /
   * /proc/self/fd / GetFinalPathNameByHandle) — never from a pre-open
   * path lookup. Fixed at construction.
   */
  readonly canonicalPath: string;
  close(): void;
  listDir(relativePath: string, maxEntries: number): SecureListResult | null;
  listDirAsync(relativePath: string, maxEntries: number): Promise<SecureListResult | null>;
  readFile(relativePath: string, maxBytes: number): SecureReadResult;
  readFileAsync(relativePath: string, maxBytes: number): Promise<SecureReadResult>;
  readPrivateFileAsync(relativePath: string): Promise<PrivateReadResult>;
  writePrivateFileAsync(relativePath: string, content: Buffer): Promise<void>;
}

/** An exclusive lock this process holds through one native handle. */
export interface ExclusiveLock {
  /** Closes the handle, which releases the lock. Idempotent. */
  release(): void;
}

/**
 * Takes the exclusive lock on the file at `lockPath`, creating it, or returns
 * null while another handle holds it, in this process or any other. POSIX uses
 * flock(2) on an `O_CLOEXEC` descriptor and Windows `LockFileEx` on a
 * non-inheritable handle, so no child process ever holds the lock, and the OS
 * releases it when its process dies, however it dies. Any other failure throws.
 */
export function tryExclusiveLock(lockPath: string): ExclusiveLock | null;

/**
 * Takes the same exclusive lock as `tryExclusiveLock` once no other handle holds
 * it. The wait is the OS's own blocking `flock(2)` or `LockFileEx` on a libuv
 * worker thread, woken when the holder's handle closes, which its process's
 * death does however it dies: no polling, no timer. It never settles while the
 * holder lives. Rejects when the file cannot be opened or locked.
 */
export function waitForExclusiveLock(lockPath: string): Promise<ExclusiveLock>;

/**
 * Marks every descriptor above stderr close-on-exec, so a process this one spawns
 * inherits only the stdio it is given (`close_range(CLOSE_RANGE_CLOEXEC)` where Linux
 * has it, otherwise each listed descriptor). Electron's Main calls it before it spawns
 * the agent host: Chromium's descriptors lack the flag. A no-op on Windows, where Node
 * and Chromium create handles non-inheritable.
 */
export function markDescriptorsCloseOnExec(): void;

/**
 * A Windows directory's owner and DACL against the private grant. `private`:
 * the current user owns it, and its DACL is protected and holds exactly one ACE,
 * an explicit Allow of FILE_ALL_ACCESS to that user, inherited by containers and
 * objects. `foreign-owner`: another principal owns it. `acl-mismatch`: the user
 * owns it, but its DACL is anything else.
 */
export interface PrivateDirectoryVerdict {
  readonly status: 'private' | 'foreign-owner' | 'acl-mismatch';
}

/**
 * Codes the private-directory calls throw with, beside a `TypeError` for an
 * argument that is not one absolute path. Win32 failures carry `win32Code`.
 * - `ENOENT`, `EACCES`, `EBUSY`, `ENOTSUP`, `EIO`: the open, read or write failed.
 * - `ENOTDIR`: the path names something other than a directory.
 * - `ERR_PRIVATE_DIRECTORY`: the current user's identity is unavailable.
 * - `ERR_PRIVATE_DIRECTORY_VERDICT` (apply only): the directory is not private
 *   afterwards; `verdict` says why. Apply wrote nothing when it is `foreign-owner`.
 * - `ENOTSUP` on POSIX, where neither call is available.
 */
export interface PrivateDirectoryError extends Error {
  readonly code:
    | 'EACCES'
    | 'EBUSY'
    | 'EIO'
    | 'ENOENT'
    | 'ENOTDIR'
    | 'ENOTSUP'
    | 'ERR_PRIVATE_DIRECTORY'
    | 'ERR_PRIVATE_DIRECTORY_VERDICT';
  readonly verdict?: Exclude<PrivateDirectoryVerdict['status'], 'private'>;
  readonly win32Code?: number;
}

/**
 * Windows only. Opens the directory once (following reparse points, with
 * FILE_FLAG_BACKUP_SEMANTICS) and reads its owner and DACL from that handle.
 * Starts no process. Throws a `PrivateDirectoryError`; on POSIX, `ENOTSUP`.
 */
export function verifyPrivateDirectorySync(absolutePath: string): PrivateDirectoryVerdict;

/**
 * Windows only. Makes a directory the current user owns private: on one handle,
 * writes the user as owner and the protected one-ACE DACL the verdict describes,
 * then reads it back, and throws `ERR_PRIVATE_DIRECTORY_VERDICT` unless it is
 * `private`. Refuses a directory another principal owns without writing to it,
 * and never takes ownership. Starts no process; on POSIX, throws `ENOTSUP`.
 */
export function applyPrivateDirectorySync(absolutePath: string): void;

/**
 * Windows: sets this process token's default owner (TOKEN_OWNER) to the token's
 * own user SID and reads it back. Every object the process creates afterwards,
 * and every child it starts afterwards (a child gets a copy of this token), is
 * owned by the user, even in an elevated session whose token defaults to
 * BUILTIN\Administrators. It never changes the owner of an existing object.
 * Throws `ERR_DEFAULT_OWNER` with `win32Code` when the token cannot be opened,
 * changed or read back. POSIX: does nothing. Process entries import
 * `@brainstrike/secure-fs-native/default-owner` first instead of calling this.
 */
export function setDefaultOwnerToCurrentUserSync(): void;
