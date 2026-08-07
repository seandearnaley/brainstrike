/**
 * Vite plugin serving the Canvas sandbox shell on web (BST-1173).
 *
 * The shell (`@brainstrike/platform-utils` canvas-sandbox) must be served at
 * {@link CANVAS_FRAME_SHELL_PATH} with ITS OWN headers, distinct from the
 * app-wide policy in `getDevCSP()`/vercel.json:
 * - the app policy's `frame-ancestors 'none'` would make the shell
 *   unframeable, and
 * - the app policy's prod `script-src` (no `unsafe-inline`) would be inherited
 *   by the shell's nested srcdoc — silently breaking inline canvas scripts in
 *   production only.
 *
 * Dev/preview: middleware answers the exact path before Vite's static/SPA
 * handling. Production: `generateBundle` emits the shell into dist, and
 * vercel.json carries the matching per-path header rule (later matching rule
 * wins for the same key — guarded by vercel-config.test.ts).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CANVAS_FRAME_SHELL_PATH,
  getCanvasSandboxContentSecurityPolicy,
  renderCanvasFrameShellHtml,
} from '@brainstrike/platform-utils';
import type { Plugin } from 'vite';

/**
 * Full header set for the shell response. COEP/CORP are required in dev: the
 * web app is cross-origin isolated (`Cross-Origin-Embedder-Policy:
 * require-corp` on the dev server), and an embedded document that does not
 * itself assert COEP would be refused by the browser.
 */
export function getCanvasFrameShellHeaders(): Readonly<Record<string, string>> {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': getCanvasSandboxContentSecurityPolicy(),
    'Content-Type': 'text/html; charset=utf-8',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

function isShellRequest(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  const [pathname] = url.split('?', 1);
  return pathname === CANVAS_FRAME_SHELL_PATH;
}

function serveShell(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (!isShellRequest(req.url)) {
    next();
    return;
  }
  for (const [key, value] of Object.entries(getCanvasFrameShellHeaders())) {
    res.setHeader(key, value);
  }
  res.statusCode = 200;
  res.end(renderCanvasFrameShellHtml());
}

export function canvasFrameShellPlugin(): Plugin {
  return {
    configurePreviewServer(server) {
      server.middlewares.use(serveShell);
    },
    configureServer(server) {
      server.middlewares.use(serveShell);
    },
    generateBundle() {
      this.emitFile({
        fileName: CANVAS_FRAME_SHELL_PATH.slice(1),
        source: renderCanvasFrameShellHtml(),
        type: 'asset',
      });
    },
    name: 'brainstrike:canvas-frame-shell',
  };
}
