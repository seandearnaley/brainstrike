import { describe, expect, it, vi } from 'vitest';

const registerSchemesAsPrivileged = vi.fn();

vi.mock('electron', () => ({
  protocol: {
    get registerSchemesAsPrivileged() {
      return registerSchemesAsPrivileged;
    },
  },
}));

import { PRIVILEGED_SCHEMES, registerPrivilegedSchemes } from '../privileged-schemes';

/**
 * Electron honors exactly ONE registerSchemesAsPrivileged call per launch; a
 * second call replaces the first, silently stripping the earlier scheme's
 * privileges (Codex review, PR #2290). This suite pins the single-call
 * contract and the reviewed privilege set for every scheme.
 */
describe('registerPrivilegedSchemes', () => {
  it('registers every privileged scheme in one call', () => {
    registerPrivilegedSchemes();
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    const [entries] = registerSchemesAsPrivileged.mock.calls[0] as [
      Array<{ privileges: Record<string, boolean>; scheme: string }>,
    ];
    expect(entries.map((entry) => entry.scheme).sort()).toEqual([
      'brainstrike-app',
      'brainstrike-asset',
      'brainstrike-canvas',
      'brainstrike-mcp-app',
    ]);
  });

  it('never grants bypassCSP to any scheme', () => {
    for (const entry of PRIVILEGED_SCHEMES) {
      expect(entry.privileges.bypassCSP).toBe(false);
    }
  });

  it('keeps the canvas scheme inert beyond framing (no fetch, no CORS, no streams)', () => {
    const canvas = PRIVILEGED_SCHEMES.find((entry) => entry.scheme === 'brainstrike-canvas');
    expect(canvas?.privileges).toMatchObject({
      corsEnabled: false,
      standard: false,
      stream: false,
      supportFetchAPI: false,
    });
  });

  it('gives the MCP App shell scheme a real origin but nothing else (no fetch, no CORS, no streams)', () => {
    // `standard: true` is what makes brainstrike-mcp-app://<token>/ an origin
    // of its own (one per registered shell), so a shell never shares the host
    // renderer's origin the way a blob: URL did.
    const shell = PRIVILEGED_SCHEMES.find((entry) => entry.scheme === 'brainstrike-mcp-app');
    expect(shell?.privileges).toMatchObject({
      corsEnabled: false,
      secure: true,
      standard: true,
      stream: false,
      supportFetchAPI: false,
    });
  });
});
