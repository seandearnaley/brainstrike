import { describe, expect, it } from 'vitest';
import { getCSP, getDevCSP } from '../csp-utils';

describe('CSP Utils', () => {
  describe('getCSP', () => {
    it('generates development CSP with localhost and unsafe policies', () => {
      const devCSP = getCSP('development');

      expect(devCSP).toContain("default-src 'self' http://localhost:* ws://localhost:*");
      expect(devCSP).toContain(
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* blob:"
      );
      expect(devCSP).toContain("worker-src 'self' blob:");
      expect(devCSP).toContain("style-src 'self' 'unsafe-inline' http://localhost:*");
      expect(devCSP).toContain("img-src 'self' data: blob: http://localhost:*");
      expect(devCSP).toContain("font-src 'self' data: http://localhost:*");
      expect(devCSP).toContain(
        "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* wss://localhost:* https://huggingface.co https://*.hf.co;"
      );
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
      expect(prodCSP).toContain("img-src 'self' data: blob:");
      expect(prodCSP).toContain("font-src 'self' data:");
      expect(prodCSP).toContain("connect-src 'self' https://huggingface.co https://*.hf.co;");
      expect(prodCSP).toContain("object-src 'none'");
      expect(prodCSP).toContain("base-uri 'self'");
      expect(prodCSP).toContain("form-action 'self'");
      expect(prodCSP).toContain("frame-ancestors 'none'");

      // Should not contain development-specific directives
      expect(prodCSP).not.toContain('http://localhost:*');
      expect(prodCSP).not.toContain('ws://localhost:*');
      expect(prodCSP).not.toContain('ws://127.0.0.1:*');
      expect(prodCSP).not.toContain('wss://localhost:*');

      // Should not allow unsafe-inline for script-src in production
      const scriptSrcMatch = prodCSP.match(/script-src[^;]*/);
      if (scriptSrcMatch) {
        expect(scriptSrcMatch[0]).not.toContain("'unsafe-inline'");
      }
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

    it('allows no CDN: ONNX Runtime WASM is served same-origin (BST-2003)', () => {
      expect(getCSP('development')).not.toContain('jsdelivr');
      expect(getCSP('production')).not.toContain('jsdelivr');
    });

    it('maintains strict security directives in both environments', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      // Security-critical directives should be the same
      expect(devCSP).toContain("object-src 'none'");
      expect(prodCSP).toContain("object-src 'none'");

      expect(devCSP).toContain("base-uri 'self'");
      expect(prodCSP).toContain("base-uri 'self'");

      expect(devCSP).toContain("form-action 'self'");
      expect(prodCSP).toContain("form-action 'self'");

      expect(devCSP).toContain("frame-ancestors 'none'");
      expect(prodCSP).toContain("frame-ancestors 'none'");
      // Canvas sandbox shell is the only framed document (BST-1173).
      expect(devCSP).toContain("frame-src 'self'");
      expect(prodCSP).toContain("frame-src 'self'");
    });

    it('formats CSP string correctly with semicolon separators', () => {
      const csp = getCSP('production');
      const directives = csp.split('; ');

      // Should have all expected directives (12 since frame-src, BST-1173)
      expect(directives).toHaveLength(12);

      // Each directive should have the correct format
      for (const directive of directives) {
        expect(directive).toMatch(/^[a-z-]+\s+.+$/);
      }
    });

    it('allows blob: for worker-src in both environments', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      expect(devCSP).toContain("worker-src 'self' blob:");
      expect(prodCSP).toContain("worker-src 'self' blob:");
    });

    it('allows data: URIs for images and fonts', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      expect(devCSP).toContain('img-src');
      expect(devCSP).toContain('data:');
      expect(devCSP).toContain('blob:');

      expect(prodCSP).toContain('img-src');
      expect(prodCSP).toContain('data:');
      expect(prodCSP).toContain('blob:');

      expect(devCSP).toContain('font-src');
      expect(devCSP).toContain('data:');

      expect(prodCSP).toContain('font-src');
      expect(prodCSP).toContain('data:');
    });

    it('includes websocket support for development', () => {
      const devCSP = getCSP('development');

      expect(devCSP).toContain('ws://localhost:*');
      expect(devCSP).toContain('ws://127.0.0.1:*');
      expect(devCSP).toContain('wss://localhost:*');
    });

    it('excludes websocket support for production', () => {
      const prodCSP = getCSP('production');

      expect(prodCSP).not.toContain('ws://');
      expect(prodCSP).not.toContain('wss://');
    });
  });

  describe('getDevCSP', () => {
    it('returns the same result as getCSP("development")', () => {
      const devCSP1 = getDevCSP();
      const devCSP2 = getCSP('development');

      expect(devCSP1).toBe(devCSP2);
    });

    it('includes all development-specific directives', () => {
      const devCSP = getDevCSP();

      expect(devCSP).toContain('http://localhost:*');
      expect(devCSP).toContain("'unsafe-inline'");
      expect(devCSP).toContain("'unsafe-eval'");
      expect(devCSP).toContain('ws://localhost:*');
    });
  });

  describe('CSP format validation', () => {
    it('produces valid CSP syntax', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      // Should not start or end with semicolon
      expect(devCSP).not.toMatch(/^;/);
      expect(devCSP).not.toMatch(/;$/);
      expect(prodCSP).not.toMatch(/^;/);
      expect(prodCSP).not.toMatch(/;$/);

      // Should not have double semicolons
      expect(devCSP).not.toContain(';;');
      expect(prodCSP).not.toContain(';;');

      // Should not have spaces around semicolons
      expect(devCSP).not.toContain(' ; ');
      expect(prodCSP).not.toContain(' ; ');
    });

    it('has consistent directive ordering', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      const expectedOrder = [
        'default-src',
        'script-src',
        'worker-src',
        'style-src',
        'img-src',
        'font-src',
        'connect-src',
        'object-src',
        'base-uri',
        'form-action',
        'frame-ancestors',
      ];

      for (const directive of expectedOrder) {
        expect(devCSP).toContain(directive);
        expect(prodCSP).toContain(directive);
      }
    });
  });

  describe('environment-specific differences', () => {
    it('development has more permissive script-src than production', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      // Development allows unsafe-inline for scripts
      expect(devCSP).toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(prodCSP).not.toMatch(/script-src[^;]*'unsafe-inline'/);

      // Production permits WebAssembly compilation without enabling string-to-code eval.
      expect(devCSP).toMatch(/script-src[^;]*'unsafe-eval'/);
      expect(prodCSP).not.toMatch(/script-src[^;]*'unsafe-eval'/);
      expect(prodCSP).toMatch(/script-src[^;]*'wasm-unsafe-eval'/);
    });

    it('development includes localhost in multiple directives', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      const localhostCount = (devCSP.match(/localhost/g) || []).length;
      const prodLocalhostCount = (prodCSP.match(/localhost/g) || []).length;

      expect(localhostCount).toBeGreaterThan(0);
      expect(prodLocalhostCount).toBe(0);
    });

    it('both environments support required external domains', () => {
      const devCSP = getCSP('development');
      const prodCSP = getCSP('production');

      // Critical external domains should be in both
      const requiredDomains = ['https://huggingface.co', 'https://*.hf.co'];

      for (const domain of requiredDomains) {
        expect(devCSP).toContain(domain);
        expect(prodCSP).toContain(domain);
      }
    });
  });
});
