export type WorkspaceSearchMode = 'text' | 'semantic';
export type ResultProvenance = 'index'; // 'live' reserved for the dual-pass fast-follow

export interface WorkspaceSearchTextMatch {
  after: readonly string[];
  before: readonly string[];
  chunkEndLine: number;
  chunkId: string;
  /** Containing chunk bounds, 1-based INCLUSIVE (FileChunk convention). */
  chunkStartLine: number;
  kind: 'match';
  line: number;
  lineText: string;
  provenance: ResultProvenance;
}

export interface WorkspaceSearchChunkHit {
  chunkId: string;
  content: string;
  endLine: number; // inclusive
  headline: string | null;
  kind: 'chunk';
  provenance: ResultProvenance;
  /** Normalized 0–1 relevance (RRF-normalized). */
  score: number;
  startLine: number; // inclusive
  tokenCount: number;
}

export type WorkspaceSearchChild = WorkspaceSearchTextMatch | WorkspaceSearchChunkHit;

export interface WorkspaceSearchFileResult {
  children: readonly WorkspaceSearchChild[];
  /** DB roots.id — translate to adapter rootId at the app-shell seam. */
  dbRootId: string | null;
  /** Present in semantic mode (from chunk.fileRecordId); absent in text mode. */
  fileRecordId?: string;
  path: string;
  rootDisplayName: string | null;
}

export interface WorkspaceSearchNotices {
  candidatesTruncated: boolean;
  scanLimited: boolean;
  skippedMissingLineMetadata: number;
  truncated: boolean;
}

export interface WorkspaceSearchResults {
  files: readonly WorkspaceSearchFileResult[];
  mode: WorkspaceSearchMode;
  notices: WorkspaceSearchNotices;
  totalMatches: number;
}
