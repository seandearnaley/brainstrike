export interface SecureDirEntry {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly name: string;
}

export interface SecureListResult {
  readonly entries: readonly SecureDirEntry[];
  readonly inspected: number;
  readonly truncated: boolean;
}

export type SecureReadResult =
  | { readonly status: 'ok'; readonly content: Buffer }
  | { readonly status: 'oversized' | 'unreadable' };

export class SecureRoot {
  constructor(canonicalAbsoluteRoot: string);
  close(): void;
  listDir(relativePath: string, maxEntries: number): SecureListResult | null;
  readFile(relativePath: string, maxBytes: number): SecureReadResult;
}
