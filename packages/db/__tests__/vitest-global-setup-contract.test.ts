import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contract: the migrate-once PGlite snapshot `globalSetup` must be declared on
 * EXACTLY ONE vitest project, and must NOT be hoisted to the root `test` config.
 *
 * Both halves are load-bearing, and both were measured on vitest 4.1.10 with a
 * throwaway two-project repro (a counter appended to a file from the setup):
 *
 *   declaration site        `vitest run`   `--project p1`   `--project p2`
 *   ---------------------   ------------   --------------   --------------
 *   both projects                2×              1×               1×
 *   one project (TODAY)          1×              1×               0×
 *   root `test` config           1×              1×               1×
 *
 * So:
 *
 * - MORE THAN ONE PROJECT declaring it re-runs `buildMigratedSnapshot()` — the
 *   whole numbered-migration chain — once per project, directly reversing the
 *   PR #1807 optimisation this setup exists to deliver.
 * - HOISTING IT TO THE ROOT also runs it exactly once for a full run, so it
 *   looks equivalent, but the bottom row shows the catch: a root-declared
 *   globalSetup runs under EVERY `--project` filter, including `browser`. The
 *   `pnpm test:browser` CI job (.github/workflows/test.yml) runs
 *   `--project browser` against this package, and `pglite-browser.browser.test.ts`
 *   never calls `inject('dbSnapshotPath')` — hoisting would make that job build
 *   and throw away a fully-migrated PGlite snapshot on every run.
 *
 * The current one-project shape is therefore already optimal; this test pins it
 * against a plausible-looking "simplification" in either direction.
 */

interface ProjectTestOptions {
  readonly globalSetup?: string | readonly string[];
  readonly name?: string;
}

interface ProjectConfig {
  readonly test?: ProjectTestOptions;
}

/** Vitest also accepts a glob/path string per project; db uses inline objects only. */
type ProjectEntry = ProjectConfig | string;

interface RootTestOptions extends ProjectTestOptions {
  readonly projects?: readonly ProjectEntry[];
}

interface DbVitestConfig {
  readonly test?: RootTestOptions;
}

interface GlobalSetupSummary {
  /** Project name -> its declared globalSetup entries. */
  readonly byProject: ReadonlyMap<string, readonly string[]>;
  /** Names of projects declaring their own globalSetup. Must have length 1. */
  readonly declaringProjects: readonly string[];
  /** globalSetup entries declared on the ROOT `test` config. Must stay empty. */
  readonly rootGlobalSetup: readonly string[];
}

function toEntries(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return typeof value === 'string' ? [value] : value;
}

/**
 * Pure, so the assertions below can be control-tested against synthetic configs
 * — an instrument that cannot fail is not evidence.
 */
function summarizeGlobalSetup(config: DbVitestConfig): GlobalSetupSummary {
  const byProject = new Map<string, readonly string[]>();
  const declaringProjects: string[] = [];

  for (const [index, project] of (config.test?.projects ?? []).entries()) {
    if (typeof project === 'string') {
      // NO SILENT FALLBACKS: a string entry points at another config file that
      // could declare its own globalSetup, which this summary cannot see. Fail
      // loudly rather than under-reporting.
      throw new TypeError(
        `vitest project #${index} is a path string (${project}); this contract can only inspect inline project objects.`
      );
    }
    const name = project.test?.name;
    if (name === undefined) {
      throw new TypeError(`vitest project #${index} has no name; cannot pin its globalSetup.`);
    }
    const entries = toEntries(project.test?.globalSetup);
    byProject.set(name, entries);
    if (entries.length > 0) {
      declaringProjects.push(name);
    }
  }

  return {
    byProject,
    declaringProjects,
    rootGlobalSetup: toEntries(config.test?.globalSetup),
  };
}

async function loadDbVitestConfig(): Promise<DbVitestConfig> {
  const configModule = (await import(
    pathToFileURL(path.join(path.resolve(import.meta.dirname, '..'), 'vitest.config.mts')).href
  )) as { readonly default: DbVitestConfig };

  return configModule.default;
}

describe('db vitest globalSetup contract', () => {
  it('builds the migrated PGlite snapshot from exactly one project', async () => {
    const summary = summarizeGlobalSetup(await loadDbVitestConfig());

    expect(summary.declaringProjects).toEqual(['unit']);
    expect(summary.byProject.get('unit')).toEqual(['./__tests__/helpers/db-snapshot-global.ts']);
  });

  it('keeps globalSetup off the root config so --project browser never builds a snapshot', async () => {
    const summary = summarizeGlobalSetup(await loadDbVitestConfig());

    // A root-declared globalSetup runs under every --project filter (see the
    // measurement table above), which would hand the browser CI job a full
    // migration chain it has no use for.
    expect(summary.rootGlobalSetup).toEqual([]);
    expect(summary.byProject.get('browser')).toEqual([]);
  });

  // --- Controls: prove the two assertions above can actually go red. ---

  it('reports every declaring project, so a second declaration cannot slip through', () => {
    const summary = summarizeGlobalSetup({
      test: {
        projects: [
          { test: { globalSetup: ['./a.ts'], name: 'unit' } },
          { test: { globalSetup: './b.ts', name: 'browser' } },
        ],
      },
    });

    expect(summary.declaringProjects).toEqual(['unit', 'browser']);
    // Exactly what the first test asserts against — and here it does NOT hold.
    expect(summary.declaringProjects).not.toEqual(['unit']);
  });

  it('reports a hoisted root globalSetup rather than looking at projects alone', () => {
    const summary = summarizeGlobalSetup({
      test: {
        globalSetup: ['./__tests__/helpers/db-snapshot-global.ts'],
        projects: [{ test: { name: 'unit' } }, { test: { name: 'browser' } }],
      },
    });

    // The hoisted shape has ZERO declaring projects, so a projects-only check
    // would pass it vacuously. The rootGlobalSetup assertion is what catches it.
    expect(summary.declaringProjects).toEqual([]);
    expect(summary.rootGlobalSetup).toEqual(['./__tests__/helpers/db-snapshot-global.ts']);
  });

  it('refuses to summarize a project shape it cannot inspect', () => {
    expect(() =>
      summarizeGlobalSetup({ test: { projects: ['./packages/*/vitest.config.ts'] } })
    ).toThrow(/can only inspect inline project objects/);
    expect(() => summarizeGlobalSetup({ test: { projects: [{ test: {} }] } })).toThrow(
      /has no name/
    );
  });
});
