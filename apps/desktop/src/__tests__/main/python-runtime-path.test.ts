import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolvePythonRuntimeResourcesDir } from '../../python-runtime/python-runtime-path';

describe('resolvePythonRuntimeResourcesDir', () => {
  it('resolves the checked-in manifest beside dist for a directly launched development build', () => {
    expect(
      resolvePythonRuntimeResourcesDir({
        isPackaged: false,
        mainModulePath: '/repo/apps/desktop/dist/main.js',
        resourcesPath: '/unused-in-development',
      })
    ).toBe(path.join('/repo/apps/desktop', 'resources', 'python-runtime'));
  });

  it('resolves electron-builder extraResources in a packaged application', () => {
    expect(
      resolvePythonRuntimeResourcesDir({
        isPackaged: true,
        mainModulePath: '/Applications/Brainstrike.app/Contents/Resources/app.asar/dist/main.js',
        resourcesPath: '/Applications/Brainstrike.app/Contents/Resources',
      })
    ).toBe(path.join('/Applications/Brainstrike.app/Contents/Resources', 'python-runtime'));
  });

  it('rejects an unexpected development main entry layout', () => {
    expect(() =>
      resolvePythonRuntimeResourcesDir({
        isPackaged: false,
        mainModulePath: '/repo/apps/desktop/src/main.js',
        resourcesPath: '/unused-in-development',
      })
    ).toThrow('Expected development main entry to be dist/main.js');
  });
});
