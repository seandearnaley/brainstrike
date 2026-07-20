import { describe, expect, it } from 'vitest';
import { getCSP, getDevCSP } from '../../csp-utils';

describe('csp-utils', () => {
  it('builds a development CSP with localhost and websocket allowances', () => {
    const csp = getCSP('development');

    expect(csp).toContain(
      "script-src 'self' blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' http://localhost:*"
    );
    expect(csp).toContain("connect-src 'self' ws://localhost:*");
    expect(csp).toContain("img-src 'self' data: blob: brainstrike-asset: http://localhost:*");
  });

  it('builds a production CSP without dev-only hosts', () => {
    const csp = getCSP('production');

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('ws://localhost:*');
  });

  it('getDevCSP delegates to development CSP', () => {
    expect(getDevCSP()).toBe(getCSP('development'));
  });
});
