import { describe, expect, it } from 'vitest';
import { getContentSecurityPolicy } from '../content-security-policy.js';

/**
 * Golden contract for the unified CSP builder (BST-745). The four literals below
 * are the reviewed, exact output for each (environment × target) combination —
 * byte-for-byte identical to the two app copies this module replaced. The
 * `intentional web-vs-electron deltas` block then pins every remaining
 * difference as a deliberate decision rather than accidental drift.
 */
const WEB_DEV_CSP =
  "base-uri 'self'; " +
  "connect-src 'self' ws://localhost:* http://localhost:* http://127.0.0.1:* ws://127.0.0.1:* wss://localhost:* https://huggingface.co https://*.hf.co; " +
  "default-src 'self' http://localhost:* ws://localhost:*; " +
  "font-src 'self' data: http://localhost:*; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  "frame-src 'self'; " +
  "img-src 'self' data: blob: http://localhost:*; " +
  "object-src 'none'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* blob:; " +
  "style-src 'self' 'unsafe-inline' http://localhost:*; " +
  "worker-src 'self' blob:";

const WEB_PROD_CSP =
  "base-uri 'self'; " +
  "connect-src 'self' https://huggingface.co https://*.hf.co; " +
  "default-src 'self'; " +
  "font-src 'self' data:; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  "frame-src 'self'; " +
  "img-src 'self' data: blob:; " +
  "object-src 'none'; " +
  "script-src 'self' blob: 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "worker-src 'self' blob:";

const ELECTRON_DEV_CSP =
  "base-uri 'self'; " +
  "connect-src 'self' ws://localhost:* http://localhost:* http://127.0.0.1:* ws://127.0.0.1:* wss://localhost:* https://huggingface.co https://*.hf.co https://api.openai.com https://generativelanguage.googleapis.com https://api.cohere.com https://api.voyageai.com; " +
  "default-src 'self' http://localhost:* ws://localhost:*; " +
  "font-src 'self' data: http://localhost:*; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  'frame-src brainstrike-canvas: brainstrike-mcp-app:; ' +
  "img-src 'self' data: blob: brainstrike-asset: http://localhost:*; " +
  "object-src 'none'; " +
  "script-src 'self' blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' http://localhost:*; " +
  "style-src 'self' 'unsafe-inline' http://localhost:*; " +
  "worker-src 'self' blob:";

const ELECTRON_PROD_CSP =
  "base-uri 'self'; " +
  "connect-src 'self' http://127.0.0.1:* http://localhost:* https://huggingface.co https://*.hf.co https://api.openai.com https://generativelanguage.googleapis.com https://api.cohere.com https://api.voyageai.com; " +
  "default-src 'self'; " +
  "font-src 'self' data:; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  'frame-src brainstrike-canvas: brainstrike-mcp-app:; ' +
  "img-src 'self' data: blob: brainstrike-asset:; " +
  "object-src 'none'; " +
  "script-src 'self' blob: 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "worker-src 'self' blob:";

/** Extract a single directive's source list from a full CSP string. */
function directiveOf(csp: string, name: string): string {
  return csp.split('; ').find((directive) => directive.startsWith(`${name} `)) ?? '';
}

describe('getContentSecurityPolicy', () => {
  describe('golden output', () => {
    it('matches the reviewed web development policy', () => {
      expect(getContentSecurityPolicy('development', 'web')).toBe(WEB_DEV_CSP);
    });

    it('matches the reviewed web production policy', () => {
      expect(getContentSecurityPolicy('production', 'web')).toBe(WEB_PROD_CSP);
    });

    it('matches the reviewed electron development policy', () => {
      expect(getContentSecurityPolicy('development', 'electron')).toBe(ELECTRON_DEV_CSP);
    });

    it('matches the reviewed electron production policy', () => {
      expect(getContentSecurityPolicy('production', 'electron')).toBe(ELECTRON_PROD_CSP);
    });
  });

  describe('shared invariants (both targets, both environments)', () => {
    const policies = [
      getContentSecurityPolicy('development', 'web'),
      getContentSecurityPolicy('production', 'web'),
      getContentSecurityPolicy('development', 'electron'),
      getContentSecurityPolicy('production', 'electron'),
    ];

    it('locks down base-uri, object-src, form-action, and frame-ancestors identically', () => {
      for (const csp of policies) {
        expect(directiveOf(csp, 'base-uri')).toBe("base-uri 'self'");
        expect(directiveOf(csp, 'object-src')).toBe("object-src 'none'");
        expect(directiveOf(csp, 'form-action')).toBe("form-action 'self'");
        expect(directiveOf(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
        expect(directiveOf(csp, 'worker-src')).toBe("worker-src 'self' blob:");
      }
    });

    it('never allows unsafe-inline script-src in production', () => {
      for (const csp of [
        getContentSecurityPolicy('production', 'web'),
        getContentSecurityPolicy('production', 'electron'),
      ]) {
        expect(directiveOf(csp, 'script-src')).not.toContain("'unsafe-inline'");
      }
    });

    it('excludes dev-only localhost/websocket origins from every production policy', () => {
      for (const csp of [
        getContentSecurityPolicy('production', 'web'),
        getContentSecurityPolicy('production', 'electron'),
      ]) {
        expect(csp).not.toContain('ws://');
        expect(csp).not.toContain('wss://');
      }
    });
  });

  describe('intentional web-vs-electron deltas', () => {
    const webDev = getContentSecurityPolicy('development', 'web');
    const webProd = getContentSecurityPolicy('production', 'web');
    const electronDev = getContentSecurityPolicy('development', 'electron');
    const electronProd = getContentSecurityPolicy('production', 'electron');

    it('frames only host-served sandbox shells: the Canvas and MCP App schemes on Electron, same-origin on web (BST-1173, BST-1572)', () => {
      // Electron frames exactly two host-authored shells, each served by its
      // own privileged scheme with a header-delivered CSP (exempt from the
      // global stamp): the Canvas shell (brainstrike-canvas:) and the MCP App
      // sandbox shell (brainstrike-mcp-app:). Web serves the canvas shell
      // same-origin at /canvas-frame.html and has no MCP App host. Neither
      // target may frame the other's mechanism, frame-src must never fall
      // back to default-src, and blob: must NEVER be a frame source: a blob
      // shell would run on the host origin with no header CSP at all.
      expect(directiveOf(electronDev, 'frame-src')).toBe(
        'frame-src brainstrike-canvas: brainstrike-mcp-app:'
      );
      expect(directiveOf(electronProd, 'frame-src')).toBe(
        'frame-src brainstrike-canvas: brainstrike-mcp-app:'
      );
      expect(directiveOf(webDev, 'frame-src')).toBe("frame-src 'self'");
      expect(directiveOf(webProd, 'frame-src')).toBe("frame-src 'self'");
      for (const csp of [electronDev, electronProd, webDev, webProd]) {
        expect(directiveOf(csp, 'frame-src')).not.toContain('blob:');
      }
    });

    it('only Electron registers the custom brainstrike-asset: image protocol', () => {
      expect(directiveOf(electronDev, 'img-src')).toContain('brainstrike-asset:');
      expect(directiveOf(electronProd, 'img-src')).toContain('brainstrike-asset:');
      expect(directiveOf(webDev, 'img-src')).not.toContain('brainstrike-asset:');
      expect(directiveOf(webProd, 'img-src')).not.toContain('brainstrike-asset:');
    });

    it('only Electron whitelists direct embedding-provider origins in connect-src', () => {
      const providerOrigins = [
        'https://api.openai.com',
        'https://generativelanguage.googleapis.com',
        'https://api.cohere.com',
        'https://api.voyageai.com',
      ];
      for (const origin of providerOrigins) {
        expect(directiveOf(electronDev, 'connect-src')).toContain(origin);
        expect(directiveOf(electronProd, 'connect-src')).toContain(origin);
        expect(directiveOf(webDev, 'connect-src')).not.toContain(origin);
        expect(directiveOf(webProd, 'connect-src')).not.toContain(origin);
      }
    });

    it('development reaches local runtimes on 127.0.0.1 on both targets', () => {
      expect(directiveOf(webDev, 'connect-src')).toContain('http://127.0.0.1:*');
      expect(directiveOf(electronDev, 'connect-src')).toContain('http://127.0.0.1:*');
    });

    it('only Electron reaches the local assistant-server (127.0.0.1) in production', () => {
      expect(directiveOf(electronProd, 'connect-src')).toContain('http://127.0.0.1:*');
      expect(directiveOf(electronProd, 'connect-src')).toContain('http://localhost:*');
      expect(webProd).not.toContain('127.0.0.1');
      expect(webProd).not.toContain('localhost');
    });

    it('allows jsdelivr in no directive of any target (BST-2003)', () => {
      // A CDN compromise must never mean code execution (BST-573), and ONNX
      // Runtime's WASM is the app's own same-origin file, so no fetch needs a CDN.
      for (const policy of [electronDev, electronProd, webDev, webProd]) {
        expect(policy).not.toContain('jsdelivr');
      }
    });

    it('uses wasm-unsafe-eval without full unsafe-eval in every production target', () => {
      expect(directiveOf(electronProd, 'script-src')).toContain("'wasm-unsafe-eval'");
      expect(directiveOf(electronProd, 'script-src')).not.toContain("'unsafe-eval' ");
      expect(directiveOf(webProd, 'script-src')).toContain("'wasm-unsafe-eval'");
      expect(directiveOf(webProd, 'script-src')).not.toContain("'unsafe-eval' ");
    });
  });
});
