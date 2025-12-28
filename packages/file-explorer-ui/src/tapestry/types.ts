export type LineData = {
  indent: number;
  width: number;
  isEmpty: boolean;
};

export type TapestryRange = {
  id: string;
  startLine: number;
  endLine: number;
  isActive: boolean;
  color: string;
};

export type FileTapestry = {
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
  selections: TapestryRange[];
};

export type InteractionMode = 'IDLE' | 'CREATING' | 'RESIZING_TOP' | 'RESIZING_BOTTOM' | 'MOVING';

export type DragState = {
  mode: InteractionMode;
  fileId: string | null;
  rangeId: string | null;
  startY: number;
  initialRange: TapestryRange | null;
};
