/**
 * The workspace tab address of one canvas: each canvas opens in a tab of its
 * own, so a thread can show several side by side. The address names the
 * thread whose run log holds the canvas, so it reads the right canvases while
 * a thread switch is still hydrating, and for a child conversation's canvas.
 */
export interface CanvasWorkspaceTab {
  readonly canvasId: string;
  readonly threadId: string;
}

const PREFIX = 'canvas-document:';

function requireTab(value: unknown): CanvasWorkspaceTab {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('Invalid canvas tab address.');
  }
  const [threadId, canvasId]: unknown[] = value;
  if (
    typeof threadId !== 'string' ||
    !threadId.trim() ||
    typeof canvasId !== 'string' ||
    !canvasId.trim()
  ) {
    throw new Error('Invalid canvas tab identity.');
  }
  return { canvasId, threadId };
}

export function canvasWorkspaceTabId(tab: CanvasWorkspaceTab): string {
  const tuple = [tab.threadId, tab.canvasId];
  requireTab(tuple);
  return PREFIX + encodeURIComponent(JSON.stringify(tuple));
}

export function isCanvasWorkspaceTabId(id: string): boolean {
  return id.startsWith(PREFIX);
}

/** Ordinary app ids pass through; a corrupted canvas id is a visible error. */
export function readCanvasWorkspaceTab(id: string): CanvasWorkspaceTab | undefined {
  if (!id.startsWith(PREFIX)) {
    return;
  }
  return requireTab(JSON.parse(decodeURIComponent(id.slice(PREFIX.length))));
}
