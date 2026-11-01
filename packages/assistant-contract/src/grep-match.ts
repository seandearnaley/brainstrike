/**
 * One workspace grep hit. The search service produces it and the grep tool's
 * result contract carries it, so neither owner re-declares the other's shape.
 */
export interface GrepMatch {
  after: string[];
  before: string[];
  line: number;
  lineText: string;
  path: string;
  /** Owning workspace root id; null for legacy/unrooted files. */
  rootId?: string | null;
  /** Owning workspace root display name; null when unrooted. */
  rootName?: string | null;
}
