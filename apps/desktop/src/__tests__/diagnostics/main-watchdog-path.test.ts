import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveMainWatchdogWorkerPath } from '../../diagnostics/main-watchdog-path';

describe('resolveMainWatchdogWorkerPath', () => {
  it('resolves the emitted worker next to main.js in development', () => {
    expect(resolveMainWatchdogWorkerPath('/repo/apps/desktop', false)).toBe(
      path.join('/repo/apps/desktop', 'dist', 'main-watchdog-worker.js')
    );
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
