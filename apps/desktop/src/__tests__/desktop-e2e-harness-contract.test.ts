import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readElectronHelpersSource(): string {
  return readFileSync(join(process.cwd(), 'e2e/utils/electron-helpers.mts'), 'utf8');
}

function readElectronFixtureSource(): string {
  return readFileSync(join(process.cwd(), 'e2e/fixtures/electron-fixture.ts'), 'utf8');
}

function readEmbeddingMemoryHelpersSource(): string {
  return readFileSync(join(process.cwd(), 'e2e/embedding-worker-renderer.shared.ts'), 'utf8');
}

function readWindowRoleSource(): string {
  return readFileSync(join(process.cwd(), 'src/window-role.ts'), 'utf8');
}

function extractDesktopWindowRoles(source: string): string[] {
  const unionMatch = source.match(/export type DesktopWindowRole =([^;]+);/);
  if (!unionMatch?.[1]) {
    throw new Error('Could not find the DesktopWindowRole union in src/window-role.ts');
  }
  const roles = [...unionMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
  if (roles.length < 4 || roles.some((role) => role.length === 0)) {
    throw new Error(
      `DesktopWindowRole extraction looks broken (got ${JSON.stringify(roles)}); fix the parser before trusting this contract.`
    );
  }
  return roles;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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
  });

  it('exposes renderer GC and fails loudly when the memory harness cannot collect', () => {
    const launcherSource = readElectronHelpersSource();
    const memoryHelpersSource = readEmbeddingMemoryHelpersSource();

    expect(launcherSource).toContain("'--js-flags=--expose-gc'");
    // Without precise memory info, Chromium quantizes performance.memory and
    // caches it for 20 minutes, so every heap "growth" reads as exactly 0.0
    // and the renderer heap ceilings can never bind.
    expect(launcherSource).toContain("'--enable-precise-memory-info'");
    expect(memoryHelpersSource).toContain("typeof globalWindow.gc !== 'function'");
    expect(memoryHelpersSource).toContain(
      'Renderer garbage collection is unavailable in the desktop E2E runtime.'
    );
    expect(memoryHelpersSource).not.toContain('globalWindow.gc?.()');
  });

  it('keeps the E2E window-mode classifiers in lockstep with DesktopWindowRole', () => {
    // This PR class exists because DesktopWindowRole gained 'llm-host' and the
    // two serialized classifier closures in embedding-worker-renderer.shared.ts
    // (readDesktopProcessSnapshot and readTrackedRuntimeWorkingSetMB) kept
    // silently bucketing it as 'visible-ui'. Both closures run inside
    // electronApp.evaluate and cannot share a module-scope helper, so each
    // union member must appear in BOTH hand-maintained blocks.
    const memoryHelpersSource = readEmbeddingMemoryHelpersSource();
    const roles = extractDesktopWindowRoles(readWindowRoleSource());

    expect(roles).toContain('visible-ui');
    for (const role of roles) {
      if (role === 'visible-ui') {
        // The visible window is the one mode-less window; both classifiers
        // must derive it via the null fallback, once each.
        expect(countOccurrences(memoryHelpersSource, "mode ?? 'visible-ui'")).toBe(2);
        continue;
      }
      expect(countOccurrences(memoryHelpersSource, `mode === '${role}'`)).toBeGreaterThanOrEqual(2);
    }
    // Both classifier blocks must throw on an unknown mode, never coerce.
    expect(countOccurrences(memoryHelpersSource, 'Unknown desktop window mode')).toBe(2);
  });

  it('removes isolated Electron user-data directories during fixture teardown', () => {
    const source = readElectronFixtureSource();

    expect(source).toContain('removeElectronUserDataDir');
    expect(source).toContain('await removeElectronUserDataDir(userDataDir)');
    expect(source).toContain('Failed to remove Electron userData directory after fixture teardown');
  });
});
