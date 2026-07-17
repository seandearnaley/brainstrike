import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface MutationVitestConfig {
  readonly test?: {
    readonly exclude?: readonly string[];
  };
}

const packageRoot = path.resolve(import.meta.dirname, '..');

async function loadMutationConfig(): Promise<MutationVitestConfig> {
  const configModule = (await import(
    pathToFileURL(path.join(packageRoot, 'vitest.mutation.config.ts')).href
  )) as { readonly default: MutationVitestConfig };

  return configModule.default;
}

describe('db mutation (Stryker) vitest config contract', () => {
  it('excludes browser-only specs from the jsdom mutation lane', async () => {
    const config = await loadMutationConfig();
    const exclude = config.test?.exclude ?? [];

    // pglite-browser.browser.test.ts asserts a real window/indexedDB and
    // fails under jsdom regardless of build state — without this exclude the
    // Stryker mutation lane is permanently red on that file.
    expect(exclude).toContain('**/*.browser.test.{ts,tsx}');
  });

  it('keeps at least one *.browser.test.* fixture, so the exclude above stays load-bearing', () => {
    const testsDir = path.join(packageRoot, '__tests__');
    // Recursive: the `**/*.browser.test.{ts,tsx}` exclude glob matches at any
    // depth, so a non-recursive scan here could silently pass with zero
    // fixtures if a browser spec ever moved into a subdirectory.
    const browserSpecs = readdirSync(testsDir, { recursive: true }).filter((name) =>
      /\.browser\.test\.[jt]sx?$/u.test(name.toString())
    );

    expect(browserSpecs.length).toBeGreaterThan(0);
  });
});
