/**
 * One workspace grep hit. The search service produces it and the grep tool's
 * result contract carries it, so neither owner re-declares the other's shape.
 */
export interface GrepMatch {
  after: string[];
  before: string[];
  /** 1-based last line of the containing chunk within its file. */
  chunkEndLine?: number;
  /** Owning chunk id (file_chunks.id). */
  chunkId?: string;
  /** 1-based first line of the containing chunk within its file. */
  chunkStartLine?: number;
  line: number;
  lineText: string;
  path: string;
  /** Owning workspace root id; null for legacy/unrooted files. */
  rootId?: string | null;
  /** Owning workspace root display name; null when unrooted. */
  rootName?: string | null;
}
