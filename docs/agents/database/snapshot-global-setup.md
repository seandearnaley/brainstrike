# The DB snapshot globalSetup — evidence

Supports `docs/agents/database.md` § "The test snapshot `globalSetup` lives on ONE project — do not hoist it".

The two measured ways to break the migrated-snapshot `globalSetup`, its per-process property across native DB shards, the agent lane's narrower equivalent, and why the mutation config's second declaration is correct. Read before moving or adding a `globalSetup`.

The record below is the original contract text, extracted unchanged.

`packages/db/vitest.config.mts` declares
`globalSetup: ['./__tests__/helpers/db-snapshot-global.ts']` on the **`unit`
project only**. That setup runs the whole numbered-migration chain once and
`provide()`s the resulting tarball path, so per-test boots become cheap
`loadDataDir` restores (PR #1807). Two ways to break it, both measured on vitest
4.1.10 and pinned by `__tests__/vitest-global-setup-contract.test.ts`:

- **Declaring it on a second project** re-runs the full migration chain once per
  project — `globalSetup` is per-project, not per-run.
- **Hoisting it to the root `test` config** still runs once for a full
  `vitest run`, but a root-declared `globalSetup` also runs under *every*
  `--project` filter — including `--project browser`, which the `Browser tests`
  CI job runs against this package. `pglite-browser.browser.test.ts` never calls
  `inject('dbSnapshotPath')`, so that job would build and discard a fully
  migrated snapshot on every run.

Note this is a **per-process** property: each native DB shard is its own
`vitest run` process and therefore builds one snapshot. The two required Unit
rows and two nightly coverage rows run those processes on separate runners;
within each process, the selected files share that one snapshot.

The agent integration lane has a narrower package-owned equivalent at
`packages/agent/src/__tests__/helpers/migrated-agent-test-db.ts`. It builds one
pristine Mastra-schema snapshot lazily per test file, keeps only its immutable
tar bytes, and restores a fresh PGlite for every test. The restore path uses
`createEnginePglite`, so it carries the same complete engine-extension set as
production. Cold schema creation, initialization retry, and missing-sidecar
cases must keep their explicit empty-database or mock path. Reload cases still
construct a new store over the real PGlite owner; the snapshot is only for
cases whose subject starts after a valid schema exists.

**There is a second, correct declaration** — `packages/db/vitest.mutation.config.ts`
also declares the same `globalSetup`, deliberately: the Stryker lane throws in
`beforeEach` before any mutant runs without it. That is NOT the per-project
double-run this section warns about, because it is a separate config reached by
a separate `vitest run` invocation, so it inherits the per-process property
above. The rule to apply is "one declaration **per config**", not "one in the
package" — and the contract test inspects `vitest.config.mts` only, for exactly
that reason.

