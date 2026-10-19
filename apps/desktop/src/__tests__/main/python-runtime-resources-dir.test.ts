import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  resolveDesktopPythonRuntimeInstallDir,
  resolveDesktopPythonRuntimeResourcesDir,
} from '../../python-runtime';

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
    // — this case varies the input's directory shape so a hardcoded or
    // wrongly-derived implementation would fail here even though it happens
    // to pass the case above.
    expect(resolveDesktopPythonRuntimeResourcesDir(false, '/unused', '/a/b/c/dist/main.js')).toBe(
      path.join('/a/b/c', 'resources', 'python-runtime')
    );
  });

  it('rejects an empty __filename instead of guessing from cwd (PR #2680 review)', () => {
    // NO SILENT FALLBACKS: an empty __filename must fail loudly, not
    // degrade to a plausible-but-wrong process.cwd()-relative path.
    expect(() => resolveDesktopPythonRuntimeResourcesDir(false, '/unused', '')).toThrow(
      '__filename unavailable'
    );
  });

  it('rejects a module path whose parent directory is not literally named dist/ (PR #2680 review)', () => {
    // This resolver additionally depends on the running module's immediate
    // parent directory being NAMED "dist" — an identity check on that one
    // path segment, not a depth check (delta re-review corrected this
    // framing: out/dist/main.js would still PASS, since only the parent's
    // basename is compared, not its depth below the app root). The
    // watchdog/log-transport resolvers don't need this at all. A future
    // change that renames or restructures the bundled output away from a
    // literal dist/ directory must fail loudly here, not silently resolve
    // to the wrong resources directory.
    expect(() =>
      resolveDesktopPythonRuntimeResourcesDir(false, '/unused', '/repo/apps/desktop/build/main.js')
    ).toThrow('parent directory to be named "dist"');
  });

  it('accepts any dist/ regardless of depth below the app root — identity, not depth (PR #2680 review)', () => {
    // Proves the guard really is an identity check, not a depth check: a
    // dist/ nested arbitrarily deep (or shallow) still passes as long as
    // its own directory name is literally "dist".
    expect(resolveDesktopPythonRuntimeResourcesDir(false, '/unused', '/out/dist/main.js')).toBe(
      path.join('/out', 'resources', 'python-runtime')
    );
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
    // __filename: an empty string here WOULD throw if the unpackaged
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

describe('resolveDesktopPythonRuntimeInstallDir (BST-1627)', () => {
  it('is the packaged resources dir itself: extraResources copies the tree beside the manifest', () => {
    expect(
      resolveDesktopPythonRuntimeInstallDir(
        true,
        '/Applications/B.app/Resources/python-runtime',
        'darwin',
        'arm64'
      )
    ).toBe('/Applications/B.app/Resources/python-runtime');
  });

  it('is the per-target build-time unpack in development, so macOS and Linux trees never collide', () => {
    const resourcesDir = '/repo/apps/desktop/resources/python-runtime';
    expect(resolveDesktopPythonRuntimeInstallDir(false, resourcesDir, 'darwin', 'x64')).toBe(
      path.join(resourcesDir, 'unpacked', 'darwin-x64')
    );
    expect(resolveDesktopPythonRuntimeInstallDir(false, resourcesDir, 'linux', 'x64')).toBe(
      path.join(resourcesDir, 'unpacked', 'linux-x64')
    );
  });

  it('derives a path without classifying the platform, so the resolver reports an unsupported one typed', () => {
    expect(resolveDesktopPythonRuntimeInstallDir(false, '/r', 'win32', 'x64')).toBe(
      path.join('/r', 'unpacked', 'win32-x64')
    );
  });
});
