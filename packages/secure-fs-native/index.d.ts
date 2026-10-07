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
