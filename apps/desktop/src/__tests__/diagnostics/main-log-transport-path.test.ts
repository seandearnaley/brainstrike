import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMainLogTransportPath } from '../../diagnostics/main-log-transport-path';

describe('main log transport path', () => {
  it('resolves the built worker next to main.js in development', () => {
    // BST-1459: direct-file Electron launches (Playwright's e2e harness)
    // make app.getAppPath() point at dist/ itself, so dev resolution
    // intentionally follows the current module instead of appPath+'dist'.
    const result = resolveMainLogTransportPath(
      '/repo/apps/desktop/dist',
      false,
      '/repo/apps/desktop/dist/main.js'
    );
    expect(result).toBe(path.join('/repo/apps/desktop', 'dist', 'main-log-transport.js'));
    expect(result).not.toContain(path.join('dist', 'dist'));
  });

  it('resolves the unpacked worker beside app.asar in a packaged application', () => {
    expect(
      resolveMainLogTransportPath('/Applications/BrainStrike.app/Contents/Resources/app.asar', true)
    ).toBe(
      path.join(
        '/Applications/BrainStrike.app/Contents/Resources',
        'app.asar.unpacked',
        'dist',
        'main-log-transport.js'
      )
    );
  });

  it('rejects an unexpected packaged application layout', () => {
    expect(() =>
      resolveMainLogTransportPath('/Applications/BrainStrike/resources/app', true)
    ).toThrow(/app\.asar/);
  });
});
