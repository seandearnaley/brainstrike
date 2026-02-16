export interface LineData {
  indent: number;
  width: number;
  isEmpty: boolean;
}

export interface TapestryRange {
  id: string;
  startLine: number;
  // End line is exclusive: range covers [startLine, endLine).
  endLine: number;
  isActive: boolean;
  color: string;
}

export interface FileTapestry {
  id: string;
  compositeKey: string;
  rootFolderId: string;
  path: string;
  name: string;
  language: string;
  type: string;
  size?: number;
  tokens?: number;
  totalLines: number;
  structure: LineData[]; // Visual representation only
  content: string[]; // Actual text content for preview
  contentStatus: 'ready' | 'loading' | 'idle';
  selections: TapestryRange[];
}

export type InteractionMode = 'IDLE' | 'CREATING' | 'RESIZING_TOP' | 'RESIZING_BOTTOM' | 'MOVING';

export interface DragState {
  mode: InteractionMode;
  fileId: string | null;
  rangeId: string | null;
  startY: number;
  initialRange: TapestryRange | null;
}
