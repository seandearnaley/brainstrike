/** One matching line, 1-based. */
export interface WorkspaceSearchMatch {
  line: number;
  lineText: string;
}

/** One matching line as the host streams it: its file's root and root-relative path. */
export interface WorkspaceSearchHit extends WorkspaceSearchMatch {
  path: string;
  rootId: string;
}

export interface WorkspaceSearchFileResult {
  matches: readonly WorkspaceSearchMatch[];
  /** Root-relative POSIX path. */
  path: string;
  /** The live root the file is in: the Explorer's root id. */
  rootId: string;
}

/** What a finished search could not cover; every cap it hit is named. */
export interface WorkspaceSearchSummary {
  /** The file cap or ripgrep's output cap stopped the search early. */
  candidatesTruncated: boolean;
  /** The search stopped at its match cap. */
  matchLimitReached: boolean;
  /** A regex with no literal text stopped at the file cap. */
  scanLimited: boolean;
  /** ripgrep reached its time limit. */
  timedOut: boolean;
  /** Open folders that could not be read, so they were not searched. */
  unreadableRootIds: readonly string[];
}

export interface WorkspaceSearchRequest {
  caseSensitive: boolean;
  isRegex: boolean;
  query: string;
  wholeWord: boolean;
}
