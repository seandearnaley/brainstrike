import { defineConfig, type ViteUserConfig } from 'vitest/config';
import LostTestFileReporter from '../vitest-lost-file-reporter.mjs';

/** Coverage runs in CI or with COVERAGE=true; COVERAGE=false turns it off. */
export const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

/**
 * What every package's Vitest config shares. Each package merges its own
 * options on top with Vitest's `mergeConfig` (arrays concatenate):
 *
 *   export default mergeConfig(sharedConfig, defineConfig({ test: { include: [...] } }));
 *
 * Workspace packages resolve through their `exports`; Vitest configs carry no aliases.
 */
export const sharedConfig = defineConfig({
  test: {
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    reporters: ['default', new LostTestFileReporter()],
  },
});

/**
 * A package's `test:integration` lane: its config with `include` replaced (the
 * `test` script excludes the same files, so the lanes partition the suite) and
 * coverage off, since both lanes can run at once and would share one
 * coverage directory.
 */
export function integrationLane(config: ViteUserConfig, include: string[]): ViteUserConfig {
  return {
    ...config,
    test: { ...config.test, coverage: { ...config.test?.coverage, enabled: false }, include },
  };
}
