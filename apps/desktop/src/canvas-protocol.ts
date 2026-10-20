/**
 * `brainstrike-canvas://` Electron protocol (BST-1173).
 *
 * Serves exactly ONE document: the static Canvas sandbox shell from
 * `@brainstrike/platform-utils`. The renderer frames it with
 * `sandbox="allow-scripts"` and streams untrusted assistant-generated HTML
 * into it over postMessage — see the canvas-sandbox module for the full
 * two-layer isolation model.
 *
 * Header contract (pinned by canvas-protocol.test.ts):
 * - `Content-Security-Policy` = the canvas sandbox policy. This MUST be a real
 *   header (not only the shell's meta tag): the nested srcdoc document
 *   inherits the shell's header policy, which is what lets canvas inline
 *   scripts run while all network stays blocked.
 * - NO `X-Frame-Options` / NO `frame-ancestors`: the scheme exists to be
 *   framed. setup-security exempts this scheme from the global header stamp
 *   for the same reason.
 * - Anything but the shell URL → uniform 404.
 */

import { createLogger } from '@brainstrike/logging';
import {
  getCanvasSandboxContentSecurityPolicy,
  renderCanvasFrameShellHtml,
} from '@brainstrike/platform-utils';
import { protocol } from 'electron';

const logger = createLogger('CanvasProtocol');

export const CANVAS_PROTOCOL_SCHEME = 'brainstrike-canvas';

/** The only URL this protocol serves; the renderer appends a `#nonce=` fragment.
 * @internal Canvas protocol regressions pin the sandbox shell URL.
 */
export const CANVAS_SHELL_URL = `${CANVAS_PROTOCOL_SCHEME}://shell/`;

/**
 * Privilege descriptor for the scheme. Registered via the SINGLE
 * `protocol.registerSchemesAsPrivileged` call in `privileged-schemes.ts` —
 * Electron only honors ONE such call per launch, so no module may call it
 * directly. `bypassCSP` stays false: the scheme participates in CSP like any
 * origin — the renderer's `frame-src brainstrike-canvas:` allowlist is what
 * admits it.
 */
export const CANVAS_PROTOCOL_PRIVILEGE = {
  privileges: {
    bypassCSP: false,
    corsEnabled: false,
    secure: true,
    standard: false,
    stream: false,
    supportFetchAPI: false,
  },
  scheme: CANVAS_PROTOCOL_SCHEME,
} as const;

/** Exported separately so tests can exercise routing without Electron. */
export function createCanvasProtocolHandler(): (request: Request) => Response {
  return (request) => {
    let requested: URL;
    try {
      requested = new URL(request.url);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const isShell =
      requested.host === 'shell' && (requested.pathname === '/' || requested.pathname === '');
    if (!isShell) {
      logger.warn('Blocked canvas protocol request for non-shell URL', { url: request.url });
      return new Response('Not found', { status: 404 });
    }
    return new Response(renderCanvasFrameShellHtml(), {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': getCanvasSandboxContentSecurityPolicy(),
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
      status: 200,
    });
  };
}

/** Register the `brainstrike-canvas://` handler. Call after `app.whenReady()`. */
export function registerCanvasProtocol(): void {
  protocol.handle(CANVAS_PROTOCOL_SCHEME, createCanvasProtocolHandler());
  logger.info('brainstrike-canvas protocol registered');
}
