export interface SecureDirEntry {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly name: string;
}

export type SecureReadResult =
  | { readonly status: 'ok'; readonly content: Buffer }
  | { readonly status: 'oversized' | 'unreadable' };

export class SecureRoot {
  constructor(canonicalAbsoluteRoot: string);
  close(): void;
  listDir(relativePath: string): readonly SecureDirEntry[] | null;
  readFile(relativePath: string, maxBytes: number): SecureReadResult;
}
