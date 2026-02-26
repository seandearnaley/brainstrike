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
  startLine: number;
}

export interface FileTapestry {
  compositeKey: string;
  content: string[]; // Actual text content for preview
  contentStatus: 'ready' | 'loading' | 'idle';
  id: string;
  language: string;
  name: string;
  path: string;
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
  fileId: string | null;
  initialRange: TapestryRange | null;
  mode: InteractionMode;
  rangeId: string | null;
  startY: number;
}
