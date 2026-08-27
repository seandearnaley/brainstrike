import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveMainWatchdogWorkerPath } from '../../diagnostics/main-watchdog-path';

describe('resolveMainWatchdogWorkerPath', () => {
  it('resolves the emitted worker next to main.js in development', () => {
    // BST-1459: direct-file Electron launches make appPath point at dist/, so
    // dev resolution intentionally follows the current module instead.
    const result = resolveMainWatchdogWorkerPath(
      '/repo/apps/desktop/dist',
      false,
      '/repo/apps/desktop/dist/main.js'
    );
    expect(result).toBe(path.join('/repo/apps/desktop', 'dist', 'main-watchdog-worker.js'));
    expect(result).not.toContain(path.join('dist', 'dist'));
  });

  it('resolves the explicitly unpacked worker in packaged builds', () => {
    expect(
      resolveMainWatchdogWorkerPath(
        '/Applications/Brainstrike.app/Contents/Resources/app.asar',
        true
      )
    ).toBe(
      path.join(
        '/Applications/Brainstrike.app/Contents/Resources',
        'app.asar.unpacked',
        'dist',
        'main-watchdog-worker.js'
      )
    );
  });

  it('rejects an unexpected packaged app layout', () => {
    expect(() =>
      resolveMainWatchdogWorkerPath('/Applications/Brainstrike.app/Contents/Resources/app', true)
    ).toThrow('Expected packaged app path to end in app.asar');
  });
});
