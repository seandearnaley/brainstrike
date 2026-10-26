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

/**
 * flock(2) `LOCK_EX | LOCK_NB` on a descriptor the caller owns. Returns true
 * when its open file description now holds the exclusive lock and false when
 * another description holds it; any other failure throws. Every process that
 * inherited the descriptor shares the lock until the last copy closes or its
 * process exits, so never unlock a shared descriptor: close it instead.
 * POSIX only; throws `ENOTSUP` on Windows.
 */
export function tryExclusiveFlock(fd: number): boolean;

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
