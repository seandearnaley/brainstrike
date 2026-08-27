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
  });

  it('tracks a differently-shaped module path instead of a fixed string (PR #2680 review)', () => {
    // The golden-path `toBe` above pins one exact string, so a same-string
    // `not.toContain('dist/dist')` alongside it can never fail independently
    // — this case varies the input's directory shape so a naive/hardcoded
    // implementation (or a reintroduced 'dist'-appending composition) would
    // fail here even though it happens to pass the case above.
    expect(resolveMainWatchdogWorkerPath('/unused', false, '/a/b/c/dist/main.js')).toBe(
      path.join('/a/b/c', 'dist', 'main-watchdog-worker.js')
    );
  });

  it('rejects an empty __filename instead of guessing from cwd (PR #2680 review)', () => {
    // NO SILENT FALLBACKS: an empty __filename must fail loudly, not
    // degrade to a plausible-but-wrong process.cwd()-relative path.
    expect(() => resolveMainWatchdogWorkerPath('/unused', false, '')).toThrow(
      '__filename unavailable'
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

  it('ignores an otherwise-invalid third argument in packaged builds (PR #2680 review)', () => {
    // Proves the packaged branch never reads currentModuleFilename / __filename:
    // an empty string here WOULD throw if the unpackaged branch's guard ran
    // against it. Getting the normal packaged result instead shows the two
    // branches are structurally decoupled, not just decoupled by luck of the
    // isPackaged check happening to run first.
    expect(
      resolveMainWatchdogWorkerPath(
        '/Applications/Brainstrike.app/Contents/Resources/app.asar',
        true,
        ''
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
