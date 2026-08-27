import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveDesktopPythonRuntimeResourcesDir } from '../../python-runtime';

describe('resolveDesktopPythonRuntimeResourcesDir', () => {
  it('resolves development resources from the parent of the emitted main module', () => {
    const result = resolveDesktopPythonRuntimeResourcesDir(
      false,
      '/unused/packaged/resources',
      '/repo/apps/desktop/dist/main.js'
    );
    expect(result).toBe(path.join('/repo/apps/desktop', 'resources', 'python-runtime'));
  });

  it('tracks a differently-shaped module path instead of a fixed string (PR #2680 review)', () => {
    // The golden-path `toBe` above pins one exact string, so a same-string
    // `not.toContain('dist/dist')` alongside it can never fail independently
    // — this case varies the input's directory depth so a hardcoded or
    // wrongly-derived implementation would fail here even though it happens
    // to pass the case above.
    expect(resolveDesktopPythonRuntimeResourcesDir(false, '/unused', '/a/b/c/dist/main.js')).toBe(
      path.join('/a/b/c', 'resources', 'python-runtime')
    );
  });

  it('rejects an empty module filename instead of guessing from cwd (PR #2680 review)', () => {
    // NO SILENT FALLBACKS: an unreachable-in-practice empty module.filename
    // must fail loudly, not degrade to a plausible-but-wrong
    // process.cwd()-relative path.
    expect(() => resolveDesktopPythonRuntimeResourcesDir(false, '/unused', '')).toThrow(
      'module.filename unavailable'
    );
  });

  it('rejects a module path that is not directly inside dist/ (PR #2680 review)', () => {
    // This resolver additionally depends on dist/'s DEPTH below the app
    // root (two dirname() calls, not one), which is more fragile than the
    // sibling-of-main.js pattern the watchdog/log-transport resolvers use.
    // A future change that nests the bundled output somewhere other than
    // a flat dist/ must fail loudly here, not silently resolve to the
    // wrong resources directory.
    expect(() =>
      resolveDesktopPythonRuntimeResourcesDir(false, '/unused', '/repo/apps/desktop/build/main.js')
    ).toThrow('expected the running main module to live in dist/');
  });

  it('resolves packaged resources from process.resourcesPath', () => {
    expect(
      resolveDesktopPythonRuntimeResourcesDir(
        true,
        '/Applications/Brainstrike.app/Contents/Resources',
        '/Applications/Brainstrike.app/Contents/Resources/app.asar/dist/main.js'
      )
    ).toBe(path.join('/Applications/Brainstrike.app/Contents/Resources', 'python-runtime'));
  });

  it('ignores an otherwise-invalid third argument in packaged builds (PR #2680 review)', () => {
    // Proves the packaged branch never reads currentModuleFilename /
    // module.filename: an empty string here WOULD throw if the unpackaged
    // branch's guards ran against it. Getting the normal packaged result
    // instead shows the two branches are structurally decoupled.
    expect(
      resolveDesktopPythonRuntimeResourcesDir(
        true,
        '/Applications/Brainstrike.app/Contents/Resources',
        ''
      )
    ).toBe(path.join('/Applications/Brainstrike.app/Contents/Resources', 'python-runtime'));
  });
});
