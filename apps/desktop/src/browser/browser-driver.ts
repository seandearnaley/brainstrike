/**
 * Driver-agnostic contract for agent-driving one browser page (BST-1176). The tool layer speaks ONLY this interface; the concrete backend
 * is {@link DebuggerBrowserDriver} over Electron's in-process
 * `webContents.debugger` (raw CDP) — chosen over playwright-core + an
 * app-level remote-debugging-port so nothing exposes an unauthenticated CDP
 * port for the whole app. A future backend swap (or the raw→typed migration)
 * stays behind this seam; tools never change.
 *
 * Navigation stays on `BrowserViewManager` (already CDP-free and tested);
 * this driver owns the CDP-only capabilities: a11y snapshot, screenshot, page
 * text, and acting on a snapshot's refs (BST-2324).
 */
import type { AccessibilitySnapshot, SnapshotOptions } from './accessibility-snapshot';
import type { ActionTargetFacts } from './browser-action-guard';

/**
 * A screenshot clip in DOCUMENT coordinates — CSS pixels from the document
 * origin, matching CDP `Page.captureScreenshot`'s `clip`. NOT viewport-relative:
 * on a scrolled page, `y` is measured from the top of the document, not the top
 * of what is currently visible. The driver captures beyond the viewport so a
 * region below the fold still renders.
 */
export interface PaneRegion {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface DriverScreenshot {
  /** `data:image/png;base64,…` — ready to hand to a vision model or the UI. */
  readonly dataUrl: string;
}

export interface DriverPageText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * A minimal CDP transport: the exact surface {@link DebuggerBrowserDriver}
 * needs, so it is unit-testable with a fake and backend-swappable. Backed in
 * production by `webContents.debugger` (attach → sendCommand → events).
 */
export interface CdpSession {
  detach(): void;
  on(event: string, handler: (params: unknown) => void): void;
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** Resolves an attached CDP session for the driver's page. */
export type CdpSessionResolver = () => Promise<CdpSession>;

/**
 * An act-by-ref the page could not take, with a message the model can act on.
 * `stale_ref`: the node is gone (the page changed since the read).
 * `element_not_actionable`: it exists but cannot take this action (disabled,
 * covered, not visible, the wrong kind of field, no matching option).
 */
export class BrowserActionError extends Error {
  readonly code: 'element_not_actionable' | 'stale_ref';

  constructor(code: BrowserActionError['code'], message: string) {
    super(message);
    this.name = 'BrowserActionError';
    this.code = code;
  }
}

export interface BrowserDriver {
  /** Trusted mouse press and release at the centre of the node, after scrolling it into view. */
  click(backendNodeId: number): Promise<void>;
  /**
   * The main frame's current document (its CDP `loaderId`). A snapshot's
   * refs belong to one document; a new one invalidates them.
   */
  documentId(): Promise<string>;
  /** Visible text of the page body, truncated to `maxChars`. */
  getPageText(maxChars: number): Promise<DriverPageText>;
  /** Secondary seeing: a PNG of the viewport (or a region). */
  screenshot(options?: { readonly region?: PaneRegion }): Promise<DriverScreenshot>;
  /** Select a `<select>`'s options by value or label; returns the selected values. */
  selectOptions(backendNodeId: number, values: readonly string[]): Promise<readonly string[]>;
  /** The agent's primary "seeing" call: a ref-annotated a11y tree. */
  snapshot(options: SnapshotOptions): Promise<AccessibilitySnapshot>;
  /** Attribute facts for the hard blocks; reads only. */
  targetFacts(backendNodeId: number): Promise<ActionTargetFacts>;
  /** Replace a field's value with `text` (Playwright's fill), then Enter when `submit`. */
  type(backendNodeId: number, text: string, submit: boolean): Promise<void>;
}
