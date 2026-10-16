/**
 * Vitest's browser mode rewrites every served `import()` to call
 * `globalThis.__vitest_browser_runner__.wrapDynamicImport`, which only the
 * test page defines. A worker realm has no runner, so there a dynamic import
 * loads directly. The browser project imports this first in every worker entry
 * it serves (`vitest.config.mts`); production bundles never see it.
 */
const runner = '__vitest_browser_runner__';
if (!Reflect.has(globalThis, runner)) {
  Reflect.set(globalThis, runner, {
    wrapDynamicImport: <T>(load: () => Promise<T>): Promise<T> => load(),
  });
}
