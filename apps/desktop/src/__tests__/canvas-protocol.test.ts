import {
  getCanvasSandboxContentSecurityPolicy,
  renderCanvasFrameShellHtml,
} from '@brainstrike/platform-utils';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

import {
  CANVAS_PROTOCOL_SCHEME,
  CANVAS_SHELL_URL,
  createCanvasProtocolHandler,
} from '../canvas-protocol';

/**
 * The brainstrike-canvas:// protocol serves EXACTLY ONE document: the static
 * Canvas sandbox shell (BST-1173). Its response must carry the canvas sandbox
 * CSP as a real header (the shell's inner srcdoc inherits it) and must NOT
 * carry the app-wide frame-ancestors/X-Frame-Options lockdown — the whole
 * point of the scheme is to be framed by the renderer. setup-security exempts
 * this scheme from the global header stamp; see setup-security.test.ts.
 */
describe('canvas protocol', () => {
  const handler = createCanvasProtocolHandler();

  it('serves the shell with the canvas sandbox CSP header and hardened metadata', async () => {
    const response = await handler(new Request(CANVAS_SHELL_URL));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      getCanvasSandboxContentSecurityPolicy()
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.text()).resolves.toBe(renderCanvasFrameShellHtml());
  });

  it('stays frameable: no X-Frame-Options, no frame-ancestors in its CSP', async () => {
    const response = await handler(new Request(CANVAS_SHELL_URL));
    expect(response.headers.get('X-Frame-Options')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).not.toContain('frame-ancestors');
  });

  it('ignores fragments on the shell URL (the host appends a per-mount #nonce)', async () => {
    const response = await handler(new Request(`${CANVAS_SHELL_URL}#nonce=abc`));
    expect(response.status).toBe(200);
  });

  it('returns a uniform 404 for every other host or path on the scheme', async () => {
    for (const url of [
      `${CANVAS_PROTOCOL_SCHEME}://other/`,
      `${CANVAS_PROTOCOL_SCHEME}://shell/extra`,
      `${CANVAS_PROTOCOL_SCHEME}://shell/../escape`,
    ]) {
      const response = await handler(new Request(url));
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe('Not found');
    }
  });
});
