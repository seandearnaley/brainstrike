// Integration lane config for @brainstrike/agent.
//
// Runs ONLY the env-sensitive `*.integration.spec.ts` files (note: this package
// names tests `*.spec.ts`, so the suffix is `.integration.spec.ts`, not
// `.integration.test.*`). These are the specs that construct REAL PGlite
// (`new PGlite()` / `PGlite.create({ extensions: { vector } })`), spawn the host
// shell + bind loopback MCP/HTTP servers, touch the real filesystem, or assert
// against un-faked wall-clock timing / event-loop-starvation windows — outcomes
// that can depend on un-hashed CPU contention and therefore must never be
// replayed from a turbo cache. Executed by the `test:integration` script, which
// turbo routes through the root uncached `test:integration` task (turbo.jsonc,
// `cache: false`).
//
// It reuses the base config verbatim and REPLACES only `test.include` with the
// integration suffix glob. The pure `test` script runs the complementary set
// (`vitest run --exclude '**/*.integration.spec.ts'`), so the two lanes
// partition the base suite by construction — no file can be orphaned. Base
// `test:coverage` keeps the base config's full include so coverage still
// measures every file. Both lanes keep `--no-file-parallelism` (serialization is
// held constant across the split; only caching changes).
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  // Coverage stays OFF in this lane. Under `turbo run test test:integration`
  // both lanes execute CONCURRENTLY in the same package — two vitest processes
  // sharing one coverage/.tmp directory race and crash (observed in CI:
  // "Something removed the coverage directory ... Vitest created earlier").
  // Full-suite coverage is owned by the single-process `test:coverage` script.
  // NOTE: this package's base config declares `coverage` at the TOP LEVEL (not
  // under `test`), where vitest ignores it — coverage is driven only by the
  // `--coverage` CLI flag. We neutralize BOTH the (dead) top-level key and the
  // canonical `test.coverage` so no future config move can re-enable it here.
  coverage: { ...(baseConfig.coverage ?? {}), enabled: false },
  test: {
    ...baseTest,
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    // This include MIRRORS the pure lane's --exclude suffix (restricted to
    // real test-module extensions; see the note just above the glob), so the
    // two lanes partition the suffix by construction: a
    // file the pure lane excludes is always picked up here — it can never be
    // silently orphaned. A suffix file outside the base include would run
    // here without counting toward coverage — the safe direction.
    // Canonical test-extension suffix instead of a bare `*` so sibling
    // artifacts (e.g. __snapshots__/x.integration.spec.ts.snap) aren't
    // loaded as test modules; still any real JS/TS extension.
    include: ['**/*.integration.spec.?(c|m)[jt]s?(x)'],
  },
});
