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
    expect(result).not.toContain(path.join('dist', 'dist'));
    expect(result).not.toContain(path.join('dist', 'resources'));
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
});
