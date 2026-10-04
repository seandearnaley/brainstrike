# Scoped caller profile admission

Caller-vector admission and execution consume the current canonical scoped profile while the global underlying index identity stays TEXT.

The M2 caller fixture originally published legacy `vec_chunks` and global VECTOR metadata. Production publishes `scoped_vectors`/`vector_profiles` with global TEXT metadata, so the old caller guard refused an explicitly configured, fully covered collection.

This change retains the current canonical collection/profile and acknowledged file IDs under the native read lease, verifies store identity and complete graph vectors within the same SQL transaction, and supplies private scope bindings to the canonical lens. Public symbol/terms arguments, recursion depth10, top50 arms and RRF60 remain unchanged.

Paired guards use scoped publication through the public IndexerPort, recorded renderer/parser vectors, global TEXT metadata, wrong-profile and missing-vector controls, and the production `runQuerySelf` entry. The authority unit guards retain the read through cleanup and refuse changed generation or cancellation.

Validation on parent `95f5b2dd1c1392ae1eed4f14b908064b61065805`:

- Causal RED: restore only `caller-vectors.ts` and `sandbox.ts` from the parent, rebuild `@brainstrike/sqlite-query`, and run the production-entry integration test against the new scoped fixture. It fails with `ToolInputError: Caller-vector lens requires an explicitly configured complete vector profile.` after asserting global TEXT metadata. Restore the patch and rebuild: the same test passes with eight rows, including `mcp/bridges.ts`.
- Actual native reader: qualified Electron 44.4.5 / embedded Node 24.21.0 from the complete-qualification worktree; public scoped writer: Node 26.10.0. The integration driver also uses that Electron runtime, preserving native accounting and cross-process serialization qualification. No inference or hosted provider runs are needed for the recorded vectors.
- `vitest run ... callers-lens.integration.test.ts`: seven cases pass, including wrong profile, missing graph vector, missing seed, bound hostile seed, corrupted vector bytes, top50/RRF60 and depth10/cycle controls.
- SQLite query protocol/host/ownership/cancellation unit lane: 15 cases pass.
- Desktop focused unit command covering `native-caller-query`, `query-self-index-target`, and `query-self-user-cancel`: 17 cases pass.
- `pnpm turbo run type-check --filter=@brainstrike/desktop --filter=@brainstrike/sqlite-query --output-logs=errors-only`: all 59 required tasks pass.

The native commands set `ELECTRON_RUN_AS_NODE=1`, `INDEXER_TEST_EXEC_PATH` to the Node writer, and `SQLITE_QUERY_TEST_EXEC_PATH` to the qualified Electron binary. The production-entry test uses desktop `vitest.integration.config.mts --environment node --pool=forks --maxWorkers=1 --no-file-parallelism`; caller controls use the package config with the same serialized worker options. The source client preserves error-class identity in Vite; the built process adapter resolves the actual compiled query host. The deliberate corrupt-storage fixture loads the vec extension and disables check constraints only on its private raw writer to admit invalid-length negative-control bytes.


Reproduction commands (from the worktree root, with the runtime environment above):

```sh
pnpm --filter @brainstrike/sqlite-query build
# From apps/desktop, both RED and GREEN:
"$SQLITE_QUERY_TEST_EXEC_PATH" ../../node_modules/vitest/vitest.mjs run --config vitest.integration.config.mts --environment node --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/query-self-scoped-callers.integration.test.ts
# From packages/sqlite-query:
"$SQLITE_QUERY_TEST_EXEC_PATH" ../../node_modules/vitest/vitest.mjs run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/callers-lens.integration.test.ts
# Unset ELECTRON_RUN_AS_NODE for pnpm commands at the root:
pnpm --filter @brainstrike/desktop exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/native-caller-query.test.ts src/__tests__/assistant-server/query-self-index-target.test.ts src/__tests__/assistant-server/query-self-user-cancel.test.ts
pnpm --filter @brainstrike/sqlite-query exec vitest run --exclude '**/*.integration.test.ts'
pnpm turbo run type-check --filter=@brainstrike/desktop --filter=@brainstrike/sqlite-query --output-logs=errors-only
```
