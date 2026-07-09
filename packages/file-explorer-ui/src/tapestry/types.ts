export interface LineData {
  indent: number;
  isEmpty: boolean;
  width: number;
}

export interface TapestryRange {
  color: string;
  // End line is exclusive: range covers [startLine, endLine).
  endLine: number;
  id: string;
  isActive: boolean;
  // Provenance marker set by the workspace-search selection bridge on ranges it
  // creates (including split remainders). Such ranges are NEVER auto-stretched
  // on content load and are NEVER treated as the auto-created full-file default:
  // only the bridge mutates them, and the sync heuristics leave them verbatim.
  origin?: 'search';
  startLine: number;
  // True after a user drag/resize/keyboard move. Prevents auto-stretching on content load.
  userModified?: boolean;
}

export interface FileTapestry {
  compositeKey: string;
  content: string[]; // Actual text content for preview
  contentStatus: 'ready' | 'loading' | 'idle';
  id: string;
  language: string;
  name: string;
  path: string;
  /** Human-readable root label (storage v5 descriptor displayName). */
  rootDisplayName?: string;
  /** Durable RootId UUID (storage v5) — identity, never display. */
  rootFolderId: string;
  selections: TapestryRange[];
  size?: number;
  structure: LineData[]; // Visual representation only
  tokens?: number;
  totalLines: number;
  type: string;
}

export type InteractionMode = 'IDLE' | 'CREATING' | 'RESIZING_TOP' | 'RESIZING_BOTTOM' | 'MOVING';

export interface DragState {
  // Anchor line for bidirectional range creation. Set to the clicked line when
  // creating a new range so dragging upward can grow the range above the click point.
  anchorLine?: number | undefined;
  fileId: string | null;
  initialRange: TapestryRange | null;
  // Snapshot of file.totalLines at drag start. If it changes mid-drag
  // (e.g. content loads), the drag is aborted to prevent erratic behavior.
  initialTotalLines: number;
  mode: InteractionMode;
  rangeId: string | null;
  startY: number;
}
