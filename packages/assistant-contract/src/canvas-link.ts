/**
 * `canvas://<canvasId>` — the in-app link the manageCanvas tool card renders
 * so the user clicks straight into the document the assistant wrote.
 *
 * Browser-safe and dependency-free on purpose: the chip (`assistant-ui`)
 * formats it and the host link seam (`app-shell`) parses it, and neither may
 * import the other. The host owns protocol POLICY (which links open where);
 * this module only owns the spelling.
 *
 * Canvas ids are app-side uuidv7 values, so the linkable charset is
 * `[A-Za-z0-9-]`. Parsing is a regex, not `new URL()`: WHATWG parsing of a
 * non-special scheme puts the id in `host` (lower-cased) or `pathname`
 * depending on the slashes, which is exactly the ambiguity a stable link must
 * not have.
 */
export const CANVAS_LINK_PROTOCOL = 'canvas:';

const LINKABLE_CANVAS_ID = /^[A-Za-z0-9-]+$/;
const CANVAS_LINK = /^canvas:\/\/([A-Za-z0-9-]+)$/i;

export type CanvasLinkParse =
  | { readonly canvasId: string; readonly kind: 'canvas' }
  | { readonly error: string; readonly kind: 'malformed' }
  | { readonly kind: 'not-canvas' };

export function isLinkableCanvasId(canvasId: string): boolean {
  return LINKABLE_CANVAS_ID.test(canvasId);
}

export function formatCanvasLink(canvasId: string): string {
  if (!isLinkableCanvasId(canvasId)) {
    throw new Error(`canvas id "${canvasId}" cannot be linked`);
  }
  return `canvas://${canvasId}`;
}

export function parseCanvasLink(url: string): CanvasLinkParse {
  if (!url.toLowerCase().startsWith(CANVAS_LINK_PROTOCOL)) {
    return { kind: 'not-canvas' };
  }
  const canvasId = CANVAS_LINK.exec(url)?.[1];
  return canvasId
    ? { canvasId, kind: 'canvas' }
    : { error: 'Canvas link has no usable canvas id', kind: 'malformed' };
}
