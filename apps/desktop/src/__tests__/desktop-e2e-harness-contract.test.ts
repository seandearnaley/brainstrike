import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readElectronHelpersSource(): string {
  return readFileSync(join(process.cwd(), 'e2e/utils/electron-helpers.mts'), 'utf8');
}

function readElectronFixtureSource(): string {
  return readFileSync(join(process.cwd(), 'e2e/fixtures/electron-fixture.ts'), 'utf8');
}

describe('desktop E2E harness contract', () => {
  it('keeps dev-server launches in Electron test mode', () => {
    const source = readElectronHelpersSource();

    expect(source).toContain("'--test-mode'");
    expect(source).not.toContain("launchMode === 'test-built' ? ['--test-mode'] : []");
  });

  it('keeps the native window-focus bridge off by default and lets a spec opt in (BST-1864)', () => {
    // The harness window is `focusable: false` and never shown, so it can never
    // take native focus, while Playwright forces the renderer's
    // `document.hasFocus()` true. With the bridge present every spec would read
    // an unfocused app; absent, each keeps the focused app it has always run with.
    // An explicit value (even '') wins, so a spec opts in with ''.
    const source = readElectronHelpersSource();

    expect(source).toMatch(
      /BRAINSTRIKE_E2E_DISABLE_PRELOAD_BRIDGES:\s*baseEnv\['BRAINSTRIKE_E2E_DISABLE_PRELOAD_BRIDGES'\]\s*\?\?\s*'windowFocus'/
    );
  });

  it('lets a spec add launch env, but never override the harness-owned variables', () => {
    // A spec passes `LOG_LEVEL` (say) through `test.use({ electronEnv })`, not by mutating
    // `process.env`; the extra env is spread before every variable the harness itself sets.
    const source = readElectronHelpersSource();
    const extraEnvAt = source.indexOf('...extraEnv,');

    expect(extraEnvAt).toBeGreaterThan(source.indexOf('...baseEnv,'));
    expect(extraEnvAt).toBeLessThan(source.indexOf("ELECTRON_IS_E2E_TEST: 'true'"));
    expect(extraEnvAt).toBeLessThan(source.indexOf('BRAINSTRIKE_DISABLE_FILE_LOGS'));
    // ...and it must stay that way for the one variable a spec exists to pass: nothing after the
    // spread, up to the end of `createLaunchOptions`, may set `LOG_LEVEL` and override it.
    const regionAt = source.indexOf('// #region Linux CI Electron');
    expect(regionAt).toBeGreaterThan(extraEnvAt);
    const afterSpread = source.slice(extraEnvAt, regionAt);
    expect(afterSpread).not.toContain('LOG_LEVEL');
  });

  it('launches renderers with GC exposed and precise memory info', () => {
    const launcherSource = readElectronHelpersSource();

    expect(launcherSource).toContain("'--js-flags=--expose-gc'");
    // Without precise memory info, Chromium quantizes performance.memory and
    // caches it for 20 minutes, so every heap "growth" reads as exactly 0.0.
    expect(launcherSource).toContain("'--enable-precise-memory-info'");
  });

  it('removes isolated Electron user-data directories during fixture teardown', () => {
    const source = readElectronFixtureSource();

    expect(source).toContain('removeElectronUserDataDir');
    expect(source).toContain('await removeElectronUserDataDir(userDataDir)');
    expect(source).toContain('Failed to remove Electron userData directory after fixture teardown');
  });
});
