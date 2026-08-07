/**
 * Driver-agnostic contract for agent-driving the active browser-pane tab
 * (BST-1176). The tool layer speaks ONLY this interface; the concrete backend
 * is {@link DebuggerBrowserDriver} over Electron's in-process
 * `webContents.debugger` (raw CDP) — chosen over playwright-core + an
 * app-level remote-debugging-port so nothing exposes an unauthenticated CDP
 * port for the whole app. A future backend swap (or the raw→typed migration)
 * stays behind this seam; tools never change.
 *
 * Navigation stays on `BrowserViewManager` (already CDP-free and tested);
 * this driver owns the CDP-only capabilities: a11y snapshot, screenshot, page
 * text, and — later PRs — input/console/network.
 */
import type { AccessibilitySnapshot, SnapshotOptions } from './accessibility-snapshot';

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

/** Resolves an attached CDP session for the CURRENTLY active pane tab. */
export type CdpSessionResolver = () => Promise<CdpSession>;

export interface BrowserDriver {
  /** Visible text of the page body, truncated to `maxChars`. */
  getPageText(maxChars: number): Promise<DriverPageText>;
  /** Secondary seeing: a PNG of the viewport (or a region). */
  screenshot(options?: { readonly region?: PaneRegion }): Promise<DriverScreenshot>;
  /** The agent's primary "seeing" call: a ref-annotated a11y tree. */
  snapshot(options: SnapshotOptions): Promise<AccessibilitySnapshot>;
}
