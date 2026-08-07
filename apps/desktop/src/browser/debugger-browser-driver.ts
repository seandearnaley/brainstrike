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
  CdpSession,
  CdpSessionResolver,
  DriverPageText,
  DriverScreenshot,
  PaneRegion,
} from './browser-driver';

interface AxTreeResult {
  readonly nodes?: readonly AxSnapshotNode[];
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
    // must surface as a capability failure, never a plausible "empty page".
    if (!Array.isArray(tree?.nodes)) {
      throw new Error('CDP Accessibility.getFullAXTree returned no nodes array');
    }
    return formatAccessibilitySnapshot(tree.nodes, options);
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

// Re-exported so callers building the production session don't reach past this
// module for the transport type.
export type { CdpSession };
