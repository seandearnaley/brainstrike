import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveMainWatchdogWorkerPath } from '../../diagnostics/main-watchdog-path';

describe('resolveMainWatchdogWorkerPath', () => {
  it('resolves the emitted worker next to a directly launched main.js in development', () => {
    expect(
      resolveMainWatchdogWorkerPath(
        '/repo/apps/desktop/dist',
        false,
        '/repo/apps/desktop/dist/main.js'
      )
    ).toBe(path.join('/repo/apps/desktop', 'dist', 'main-watchdog-worker.js'));
  });

  it('resolves the explicitly unpacked worker in packaged builds', () => {
    expect(
      resolveMainWatchdogWorkerPath(
        '/Applications/Brainstrike.app/Contents/Resources/app.asar',
        true,
        '/Applications/Brainstrike.app/Contents/Resources/app.asar/dist/main.js'
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
      resolveMainWatchdogWorkerPath(
        '/Applications/Brainstrike.app/Contents/Resources/app',
        true,
        '/Applications/Brainstrike.app/Contents/Resources/app/dist/main.js'
      )
    ).toThrow('Expected packaged app path to end in app.asar');
  });

  it('rejects an unexpected development main entry layout', () => {
    expect(() =>
      resolveMainWatchdogWorkerPath('/repo/apps/desktop', false, '/repo/apps/desktop/src/main.js')
    ).toThrow('Expected development main entry to be dist/main.js');
  });
});
