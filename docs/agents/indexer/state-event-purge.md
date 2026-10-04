# State-event purge foundation

Supports the state projection and purge rules in `../indexer.md`.

## Scope

BST-1923 requires derived blob counts and physical FTS removal. The previous
state foundation used a truth-reading test double without FTS. This change adds
an unwired production adapter to the existing native indexer process. Synthetic
committed events exercise it; application chat, history ingestion/retrieval and
legacy migration are outside this foundation.

Canonical file rows cannot represent run events without fabricated file/root
identities. Dedicated event rows, reference rows and FTS remain in the same
derived SQLite file and writer. Schema 6 refuses prior schemas with the existing
explicit rebuild policy and preserves their files. Persisted canonical state-root
identity prevents reopening the projection against a different truth source.

The writer rereads exact events rather than receiving cached event bodies.
Catch-up uses a separate durable contiguous cursor, because a purge can reindex
sequence 2 before sequence 1 was ever indexed. Using MAX(projected sequence)
would skip an earlier shared-blob reference and allow premature collection.
Thread-drop retains its returned hashes across a failed physical checkpoint.

FTS secure deletion and SQLite core secure deletion are distinct mechanisms;
both are required for physical removal. A checked TRUNCATE checkpoint uses a
nonblocking busy policy and restores the connection's prior timeout. A pinned
reader is reported directly, allowing the durable purge intent to remain open.
[SQLite FTS5 secure-delete](https://www.sqlite.org/fts5.html#the_secure_delete_configuration_option).

## Qualification

The first allocated local slot used pnpm 11.15.0 and its pinned Node 26.8.2 on
Mac arm64. `pnpm node --version` also performed the missing local dependency
installation; it reused all 1900 packages and rebuilt secure-fs-native. Its
existing nonfatal lefthook-install warnings remained visible. The first indexer
dependency build passed ten tasks and failed the indexer on a readonly-array
return annotation. Correcting that annotation allowed the scoped package build.

Tests were written before production edits. Three temporary production-source
mutations each reproduced a causal RED, with the original source restored between
controls: skipped reindex left one searchable event; disabled FTS secure deletion
left the secret in index.sqlite despite no MATCH/vocabulary hit; omitted
second-thread catch-up deleted a still-referenced blob. Builds succeeded for
each control. The complete restored suite then passed all seven cases in one
file in 2.38 seconds. Source comparison confirmed the restored original exactly.

Commands: `pnpm exec turbo run build --filter=@brainstrike/indexer... --concurrency=2`,
then scoped `pnpm --filter @brainstrike/indexer build` for the repair/controls,
and `pnpm --filter @brainstrike/indexer exec vitest run --config vitest.integration.config.mts __tests__/state-purge.integration.test.ts`
(the controls selected their affected case with `-t`). Logs are
`/tmp/bst1923-state-purge-{build,build-repair,red-reindex,red-fts,red-refcount,green}.log`,
with separate control build logs. No normal commit hooks or broad regression
ran in this initial slot. These
tests establish the unwired foundation, not application chat migration or Node
query-sandbox memory-accounting qualification.

The bounded independent static review of the 20-file draft was CLEAN. In the
final allocated slot, required Ultracite formatting passed after readonly,
optional-chain and constructor-complexity repairs. The acquisition conditional
was extracted into `StateEventStore.acquire` without changing its behavior.
Affected production/test type checks passed all 18 tasks; strict Effect checks
reported zero diagnostics for all 31 indexer and 18 SQLite-query files. The
metadata unit case and the collection-store schema/refusal case passed. The
two mechanically updated SQLite-query fixture suites used Electron 44.4.5 in
Node mode and passed all 32 cases after one additional vector-profile fixture
was changed from schema 5 to 6. The first run's explicit schema refusal and the
repaired run are retained in separate logs. Rejection assertions were preserved.
Final logs use `/tmp/bst1923-state-purge-final-*.log`; normal commit-hook results
are reported with the committed head. Linux and Windows qualification and exact
original M0 suite parity remain open.

CI is disabled due to cost; validation must run locally.
