/**
 * {@link BrowserDriver} over a CDP {@link CdpSession} — in production the
 * session wraps the active tab's `webContents.debugger` (BST-1176). A fresh
 * session is resolved PER CALL so the driver always targets whichever tab is
 * active now, never a stale handle from a previous active tab.
 */
import {
  type AccessibilitySnapshot,
  type AxSnapshotNode,
  formatAccessibilitySnapshot,
  type SnapshotOptions,
} from './accessibility-snapshot';
import type {
  BrowserDriver,
  CdpSessionResolver,
  DriverPageText,
  DriverScreenshot,
  PaneRegion,
} from './browser-driver';

interface AxTreeResult {
  readonly nodes?: readonly unknown[];
}

/** An `AXValue` the formatter reads: an object whose `value` (if present) is a primitive. */
function isAxValue(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const { value } = candidate as { value?: unknown };
  return (
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isStringArray(candidate: unknown): boolean {
  return Array.isArray(candidate) && candidate.every((item) => typeof item === 'string');
}

/**
 * A well-formed AX node: a string `nodeId` AND every OTHER field the formatter
 * consumes must, when present, have the right type — a `backendDOMNodeId` that
 * is a string would otherwise become a string-valued ref, and a malformed
 * `role` would silently drop content. NO SILENT FALLBACKS: any mismatch means a
 * broken transport, so the caller rejects rather than degrading.
 */
function isAxNode(node: unknown): node is AxSnapshotNode {
  if (typeof node !== 'object' || node === null) {
    return false;
  }
  const n = node as Record<string, unknown>;
  if (typeof n['nodeId'] !== 'string') {
    return false;
  }
  const backendId = n['backendDOMNodeId'];
  if (backendId !== undefined && typeof backendId !== 'number') {
    return false;
  }
  const ignored = n['ignored'];
  if (ignored !== undefined && typeof ignored !== 'boolean') {
    return false;
  }
  const childIds = n['childIds'];
  if (childIds !== undefined && !isStringArray(childIds)) {
    return false;
  }
  const role = n['role'];
  const name = n['name'];
  return (role === undefined || isAxValue(role)) && (name === undefined || isAxValue(name));
}

interface CaptureScreenshotResult {
  readonly data?: string;
}

interface EvaluateResult {
  readonly result?: { readonly value?: unknown };
}

export class DebuggerBrowserDriver implements BrowserDriver {
  constructor(private readonly resolveSession: CdpSessionResolver) {}

  async snapshot(options: SnapshotOptions): Promise<AccessibilitySnapshot> {
    const session = await this.resolveSession();
    // getFullAXTree requires the Accessibility domain enabled; it is idempotent.
    await session.send('Accessibility.enable');
    const tree = await session.send<AxTreeResult>('Accessibility.getFullAXTree');
    // NO SILENT FALLBACKS: a malformed reply (protocol skew, broken transport)
    // must surface as a capability failure, never a plausible "empty page" —
    // validate the array AND every element's shape (a `[{}]` would otherwise
    // format as a valid empty snapshot).
    const nodes = tree?.nodes;
    if (!Array.isArray(nodes)) {
      throw new Error('CDP Accessibility.getFullAXTree returned no nodes array');
    }
    if (!nodes.every(isAxNode)) {
      throw new Error('CDP Accessibility.getFullAXTree returned a malformed node');
    }
    return formatAccessibilitySnapshot(nodes, options);
  }

  async screenshot(options?: { readonly region?: PaneRegion }): Promise<DriverScreenshot> {
    const session = await this.resolveSession();
    // A region clip is in DOCUMENT coordinates (see PaneRegion); capture beyond
    // the viewport so a region below the fold still renders.
    const params = options?.region
      ? { captureBeyondViewport: true, clip: toClip(options.region) }
      : undefined;
    const shot = await session.send<CaptureScreenshotResult>('Page.captureScreenshot', params);
    if (typeof shot?.data !== 'string' || shot.data.length === 0) {
      throw new Error('CDP Page.captureScreenshot returned no image data');
    }
    return { dataUrl: `data:image/png;base64,${shot.data}` };
  }

  async getPageText(maxChars: number): Promise<DriverPageText> {
    const session = await this.resolveSession();
    const evaluated = await session.send<EvaluateResult>('Runtime.evaluate', {
      // Always resolves to a string (empty when body is absent) — so a
      // non-string here means the CALL failed, not that the page is empty.
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
    const value = evaluated?.result?.value;
    if (typeof value !== 'string') {
      throw new Error('CDP Runtime.evaluate did not return page text');
    }
    const truncated = value.length > maxChars;
    return { text: truncated ? value.slice(0, maxChars) : value, truncated };
  }
}

function toClip(region: PaneRegion): Record<string, number> {
  return {
    height: region.height,
    scale: 1,
    width: region.width,
    x: region.x,
    y: region.y,
  };
}
