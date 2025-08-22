import { describe, expect, it } from 'vitest';
import { getCSP, getDevCSP } from '../csp';

describe('Security: CSP utilities', () => {
  describe('getCSP()', () => {
    it('generates development CSP with localhost and permissive dev policies', () => {
      const dev = getCSP('development');
      expect(dev).toContain("default-src 'self' http://localhost:* ws://localhost:*");
      expect(dev).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
      expect(dev).toContain("worker-src 'self' blob:");
      expect(dev).toContain("style-src 'self' 'unsafe-inline' http://localhost:*");
      expect(dev).toContain("img-src 'self' data: blob: http://localhost:*");
      expect(dev).toContain("font-src 'self' data: http://localhost:*");
      expect(dev).toContain(
        "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* wss://localhost:* https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net"
      );
      expect(dev).toContain("object-src 'none'");
      expect(dev).toContain("base-uri 'self'");
      expect(dev).toContain("form-action 'self'");
      expect(dev).toContain("frame-ancestors 'none'");
    });

    it('generates production CSP with restricted policies', () => {
      const prod = getCSP('production');
      expect(prod).toContain("default-src 'self'");
      expect(prod).toContain("script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net");
      expect(prod).toContain("worker-src 'self' blob:");
      expect(prod).toContain("style-src 'self' 'unsafe-inline'");
      expect(prod).toContain("img-src 'self' data: blob:");
      expect(prod).toContain("font-src 'self' data:");
      expect(prod).toContain(
        "connect-src 'self' https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net"
      );
      expect(prod).toContain("object-src 'none'");
      expect(prod).toContain("base-uri 'self'");
      expect(prod).toContain("form-action 'self'");
      expect(prod).toContain("frame-ancestors 'none'");

      // no dev-only allowances
      expect(prod).not.toContain('http://localhost:*');
      expect(prod).not.toContain('ws://localhost:*');
      expect(prod).not.toContain('ws://127.0.0.1:*');
      expect(prod).not.toContain('wss://localhost:*');

      // no 'unsafe-inline' in script-src for prod
      const script = prod.match(/script-src[^;]*/)?.[0] ?? '';
      expect(script).not.toContain("'unsafe-inline'");
    });

    it('has consistent directive ordering and formatting', () => {
      const csp = getCSP('production');
      const directives = csp.split('; ');
      expect(directives).toHaveLength(11);
      for (const d of directives) expect(d).toMatch(/^[a-z-]+\s+.+$/);
      expect(csp).not.toMatch(/^;/);
      expect(csp).not.toMatch(/;$/);
      expect(csp).not.toContain(';;');
      expect(csp).not.toContain(' ; ');
    });

    it('allows blob: for workers and data: for assets in both envs', () => {
      const dev = getCSP('development');
      const prod = getCSP('production');
      expect(dev).toContain("worker-src 'self' blob:");
      expect(prod).toContain("worker-src 'self' blob:");
      expect(dev).toMatch(/img-src[^;]*data:/);
      expect(prod).toMatch(/img-src[^;]*data:/);
      expect(dev).toMatch(/font-src[^;]*data:/);
      expect(prod).toMatch(/font-src[^;]*data:/);
    });

    it('includes required external domains in both envs', () => {
      const dev = getCSP('development');
      const prod = getCSP('production');
      for (const domain of [
        'https://huggingface.co',
        'https://*.hf.co',
        'https://cdn.jsdelivr.net',
      ]) {
        expect(dev).toContain(domain);
        expect(prod).toContain(domain);
      }
    });
  });

  describe('getDevCSP()', () => {
    it('equals getCSP("development")', () => {
      expect(getDevCSP()).toBe(getCSP('development'));
    });
  });
});
