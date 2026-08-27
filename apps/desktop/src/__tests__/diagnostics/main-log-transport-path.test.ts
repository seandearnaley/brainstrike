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
  });

  it('tracks a differently-shaped module path instead of a fixed string (PR #2680 review)', () => {
    // The golden-path `toBe` above pins one exact string, so a same-string
    // `not.toContain('dist/dist')` alongside it can never fail independently
    // — this case varies the input's directory shape so a naive/hardcoded
    // implementation (or a reintroduced 'dist'-appending composition) would
    // fail here even though it happens to pass the case above.
    expect(resolveMainLogTransportPath('/unused', false, '/a/b/c/dist/main.js')).toBe(
      path.join('/a/b/c', 'dist', 'main-log-transport.js')
    );
  });

  it('rejects an empty __filename instead of guessing from cwd (PR #2680 review)', () => {
    // NO SILENT FALLBACKS: an empty __filename must fail loudly, not
    // degrade to a plausible-but-wrong process.cwd()-relative path.
    expect(() => resolveMainLogTransportPath('/unused', false, '')).toThrow(
      '__filename unavailable'
    );
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

  it('ignores an otherwise-invalid third argument in packaged builds (PR #2680 review)', () => {
    // Proves the packaged branch never reads currentModuleFilename / __filename:
    // an empty string here WOULD throw if the unpackaged branch's guard ran
    // against it. Getting the normal packaged result instead shows the two
    // branches are structurally decoupled.
    expect(
      resolveMainLogTransportPath(
        '/Applications/BrainStrike.app/Contents/Resources/app.asar',
        true,
        ''
      )
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
