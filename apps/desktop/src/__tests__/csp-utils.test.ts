import { describe, expect, it } from 'vitest';
import { getCSP, getDevCSP } from '../csp-utils';

describe('Desktop CSP Utils', () => {
  describe('getCSP', () => {
    it('generates development CSP with localhost and unsafe policies', () => {
      const devCSP = getCSP('development');

      expect(devCSP).toContain("default-src 'self' http://localhost:* ws://localhost:*");
      expect(devCSP).toContain(
        "script-src 'self' blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' http://localhost:*"
      );
      expect(devCSP).toContain("worker-src 'self' blob:");
      expect(devCSP).toContain("style-src 'self' 'unsafe-inline' http://localhost:*");
      expect(devCSP).toContain("img-src 'self' data: blob: brainstrike-asset: http://localhost:*");
      expect(devCSP).toContain("font-src 'self' data: http://localhost:*");
      // Allowances for development connectivity
      expect(devCSP).toContain("connect-src 'self'");
      expect(devCSP).toContain('ws://localhost:*');
      expect(devCSP).toContain('http://localhost:*');
      expect(devCSP).toContain('http://127.0.0.1:*');
      expect(devCSP).toContain('ws://127.0.0.1:*');
      expect(devCSP).toContain('wss://localhost:*');
      expect(devCSP).toContain('https://huggingface.co');
      expect(devCSP).toContain('https://*.hf.co');
      expect(devCSP).not.toContain('jsdelivr');
      expect(devCSP).toContain("object-src 'none'");
      expect(devCSP).toContain("base-uri 'self'");
      expect(devCSP).toContain("form-action 'self'");
      expect(devCSP).toContain("frame-ancestors 'none'");
    });

    it('generates production CSP with restricted policies', () => {
      const prodCSP = getCSP('production');

      expect(prodCSP).toContain("default-src 'self'");
      expect(prodCSP).toContain("script-src 'self' blob: 'wasm-unsafe-eval'");
      expect(prodCSP).toContain("worker-src 'self' blob:");
      expect(prodCSP).toContain("style-src 'self' 'unsafe-inline'");
      expect(prodCSP).toContain("img-src 'self' data: blob: brainstrike-asset:");
      expect(prodCSP).toContain("font-src 'self' data:");
      // Production connect-src allows the local assistant runtime and model hosts
      expect(prodCSP).toContain("connect-src 'self'");
      expect(prodCSP).toContain('http://127.0.0.1:*');
      expect(prodCSP).toContain('http://localhost:*');
      expect(prodCSP).toContain('https://huggingface.co');
      expect(prodCSP).toContain('https://*.hf.co');
      expect(prodCSP).not.toContain('jsdelivr');
      expect(prodCSP).toContain("object-src 'none'");
      expect(prodCSP).toContain("base-uri 'self'");
      expect(prodCSP).toContain("form-action 'self'");
      expect(prodCSP).toContain("frame-ancestors 'none'");

      // Should not include dev-only websocket schemes in production
      expect(prodCSP).not.toContain('ws://localhost:*');
      expect(prodCSP).not.toContain('ws://127.0.0.1:*');
      expect(prodCSP).not.toContain('wss://localhost:*');
    });

    it('includes embeddings-related domains in connect-src', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      // Both should include Hugging Face domains for embeddings
      expect(devCSP).toContain('https://huggingface.co');
      expect(devCSP).toContain('https://*.hf.co');
      expect(prodCSP).toContain('https://huggingface.co');
      expect(prodCSP).toContain('https://*.hf.co');
    });

    it('maintains strict security directives for Electron', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      // Security-critical directives should be the same
      expect(devCSP).toContain("object-src 'none'");
      expect(prodCSP).toContain("object-src 'none'");

      expect(devCSP).toContain("frame-ancestors 'none'");
      expect(prodCSP).toContain("frame-ancestors 'none'");
    });

    it('allows style-src unsafe-inline in production for Electron compatibility', () => {
      const prodCSP = getCSP('production');

      // Electron apps often need unsafe-inline for styles
      expect(prodCSP).toContain("style-src 'self' 'unsafe-inline'");
    });

    it('permits WASM compilation without full eval in production (BST-573)', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      // WASM needs only wasm-unsafe-eval; production must NOT carry full
      // eval, and no environment script-loads from the CDN (a jsdelivr
      // compromise must never mean code execution in a renderer holding the
      // secrets/terminal/git bridges — BST-573). ONNX Runtime's WASM is the
      // app's own file (BST-2003), so no directive allows jsdelivr at all.
      expect(devCSP).toContain("'wasm-unsafe-eval'");
      expect(prodCSP).toContain("'wasm-unsafe-eval'");
      expect(prodCSP).not.toContain("'unsafe-eval' ");
      const scriptSrcOf = (csp: string) =>
        csp.split(';').find((directive: string) => directive.trim().startsWith('script-src')) ?? '';
      expect(scriptSrcOf(prodCSP)).not.toContain('jsdelivr');
      expect(scriptSrcOf(devCSP)).not.toContain('jsdelivr');
      const connectSrcOf = (csp: string) =>
        csp.split(';').find((directive: string) => directive.trim().startsWith('connect-src')) ??
        '';
      expect(connectSrcOf(prodCSP)).not.toContain('jsdelivr');
      expect(connectSrcOf(devCSP)).not.toContain('jsdelivr');
    });
  });

  describe('getDevCSP', () => {
    it('returns the same result as getCSP("development")', () => {
      const devCSP1 = getDevCSP();
      const devCSP2 = getCSP('development');

      expect(devCSP1).toBe(devCSP2);
    });

    it('includes Electron development server support', () => {
      const devCSP = getDevCSP();

      expect(devCSP).toContain('http://localhost:*');
      expect(devCSP).toContain('ws://localhost:*');
      expect(devCSP).toContain('ws://127.0.0.1:*');
      expect(devCSP).toContain('wss://localhost:*');
    });
  });

  describe('Electron-specific requirements', () => {
    it('supports blob: workers for Web Workers', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      expect(devCSP).toContain("worker-src 'self' blob:");
      expect(prodCSP).toContain("worker-src 'self' blob:");
    });

    it('supports blob: script modules for ORT and transformers runtime loading', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      expect(devCSP).toContain("script-src 'self' blob:");
      expect(prodCSP).toContain("script-src 'self' blob:");
    });

    it('supports data: URIs for assets', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      // Images can be data: URIs
      expect(devCSP).toMatch(/img-src[^;]*data:/);
      expect(prodCSP).toMatch(/img-src[^;]*data:/);

      // Fonts can be data: URIs
      expect(devCSP).toMatch(/font-src[^;]*data:/);
      expect(prodCSP).toMatch(/font-src[^;]*data:/);
    });

    it('allows the root-validated brainstrike-asset: protocol for local images', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      expect(devCSP).toMatch(/img-src[^;]*brainstrike-asset:/);
      expect(prodCSP).toMatch(/img-src[^;]*brainstrike-asset:/);
    });

    it('maintains consistent CSP format', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      // Should be valid CSP format
      expect(devCSP).toMatch(/^[a-z-]+\s+.+?(?:;\s+[a-z-]+\s+.+)*$/);
      expect(prodCSP).toMatch(/^[a-z-]+\s+.+?(?:;\s+[a-z-]+\s+.+)*$/);

      // Should not have empty directives
      expect(devCSP).not.toMatch(/;\s+;/);
      expect(prodCSP).not.toMatch(/;\s+;/);
    });
  });

  describe('security validation', () => {
    it('prohibits dangerous directives in production', () => {
      const prodCSP = getCSP('production');

      // No full eval in production script-src — WASM runs on the narrower
      // 'wasm-unsafe-eval' (BST-573).
      expect(prodCSP).not.toMatch(/script-src[^;]*'unsafe-eval'/);
      expect(prodCSP).toMatch(/script-src[^;]*'wasm-unsafe-eval'/);

      // Should not allow inline scripts in production
      expect(prodCSP).not.toMatch(/script-src[^;]*'unsafe-inline'/);

      // Should block object-src completely
      expect(prodCSP).toContain("object-src 'none'");
    });

    it('has appropriate development allowances', () => {
      const devCSP = getCSP('development');

      // Development can have unsafe-inline for hot reloading
      expect(devCSP).toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(devCSP).toMatch(/style-src[^;]*'unsafe-inline'/);

      // Still blocks dangerous object-src
      expect(devCSP).toContain("object-src 'none'");
    });

    it('prevents clickjacking attacks', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      expect(devCSP).toContain("frame-ancestors 'none'");
      expect(prodCSP).toContain("frame-ancestors 'none'");
    });
  });
});
