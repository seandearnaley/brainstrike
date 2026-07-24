import { describe, expect, it } from 'vitest';
import { getContentSecurityPolicy } from '../content-security-policy';

/**
 * Golden contract for the unified CSP builder (BST-745). The four literals below
 * are the reviewed, exact output for each (environment × target) combination —
 * byte-for-byte identical to the two app copies this module replaced. The
 * `intentional web-vs-electron deltas` block then pins every remaining
 * difference as a deliberate decision rather than accidental drift.
 */
const WEB_DEV_CSP =
  "base-uri 'self'; " +
  "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* wss://localhost:* https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net; " +
  "default-src 'self' http://localhost:* ws://localhost:*; " +
  "font-src 'self' data: http://localhost:*; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  "img-src 'self' data: blob: http://localhost:*; " +
  "object-src 'none'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* https://cdn.jsdelivr.net blob:; " +
  "style-src 'self' 'unsafe-inline' http://localhost:*; " +
  "worker-src 'self' blob:";

const WEB_PROD_CSP =
  "base-uri 'self'; " +
  "connect-src 'self' https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net; " +
  "default-src 'self'; " +
  "font-src 'self' data:; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  "img-src 'self' data: blob:; " +
  "object-src 'none'; " +
  "script-src 'self' blob: 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "worker-src 'self' blob:";

const ELECTRON_DEV_CSP =
  "base-uri 'self'; " +
  "connect-src 'self' ws://localhost:* http://localhost:* http://127.0.0.1:* ws://127.0.0.1:* wss://localhost:* https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net https://api.openai.com https://generativelanguage.googleapis.com https://api.cohere.com https://api.voyageai.com; " +
  "default-src 'self' http://localhost:* ws://localhost:*; " +
  "font-src 'self' data: http://localhost:*; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  "img-src 'self' data: blob: brainstrike-asset: http://localhost:*; " +
  "object-src 'none'; " +
  "script-src 'self' blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' http://localhost:*; " +
  "style-src 'self' 'unsafe-inline' http://localhost:*; " +
  "worker-src 'self' blob:";

const ELECTRON_PROD_CSP =
  "base-uri 'self'; " +
  "connect-src 'self' http://127.0.0.1:* http://localhost:* https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net https://api.openai.com https://generativelanguage.googleapis.com https://api.cohere.com https://api.voyageai.com; " +
  "default-src 'self'; " +
  "font-src 'self' data:; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
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

    it('only Electron reaches the local assistant-server (127.0.0.1) in production', () => {
      expect(directiveOf(electronProd, 'connect-src')).toContain('http://127.0.0.1:*');
      expect(directiveOf(electronProd, 'connect-src')).toContain('http://localhost:*');
      expect(webProd).not.toContain('127.0.0.1');
      expect(webProd).not.toContain('localhost');
    });

    it('keeps jsdelivr out of every production script-src while preserving development HMR', () => {
      // A CDN compromise must never mean code execution in either production
      // target. jsdelivr stays a fetch origin (connect-src) only.
      expect(directiveOf(electronDev, 'script-src')).not.toContain('jsdelivr');
      expect(directiveOf(electronProd, 'script-src')).not.toContain('jsdelivr');
      expect(directiveOf(webDev, 'script-src')).toContain('https://cdn.jsdelivr.net');
      expect(directiveOf(webProd, 'script-src')).not.toContain('https://cdn.jsdelivr.net');
      // jsdelivr remains a fetch origin on both.
      expect(directiveOf(electronProd, 'connect-src')).toContain('https://cdn.jsdelivr.net');
      expect(directiveOf(webProd, 'connect-src')).toContain('https://cdn.jsdelivr.net');
    });

    it('uses wasm-unsafe-eval without full unsafe-eval in every production target', () => {
      expect(directiveOf(electronProd, 'script-src')).toContain("'wasm-unsafe-eval'");
      expect(directiveOf(electronProd, 'script-src')).not.toContain("'unsafe-eval' ");
      expect(directiveOf(webProd, 'script-src')).toContain("'wasm-unsafe-eval'");
      expect(directiveOf(webProd, 'script-src')).not.toContain("'unsafe-eval' ");
    });
  });
});
