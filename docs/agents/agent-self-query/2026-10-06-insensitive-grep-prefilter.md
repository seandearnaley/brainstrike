# Case-insensitive grep candidate filtering

The final normal root launch on `c26ff6552` reached native readiness, but a live
semantic search for `workspace indexing startup` failed at
`2026-10-06T04:24:37.256Z` with `SqliteQueryDeadlineError` at the existing
1,000 ms query deadline. Semantic search requires BM25, grep and vector candidate
pools together; the failure belongs to the grep reader, whose deadline differs
from the indexer's five-second vector request deadline.

The original case-insensitive grep scanned and transferred every authorized
chunk before JavaScript decoded rows and performed canonical line matching.
The reader exhausts the scope to retain exact matched-chunk counts even after
its output cap. The scoped vector retrieval and query inference were not changed.

The new conservative candidate predicate applies only to literals whose folded
needle is ASCII. SQLite's documented `lower` primitive folds ASCII characters:
[SQLite core function documentation](https://sqlite.org/lang_corefunc.html#lower).
Keep every non-ASCII content row by comparing UTF-8 blob length to character
length; embedded NUL also keeps a row because character length stops there.
The canonical JavaScript matcher still verifies every candidate. Non-ASCII
needles, regexes and existing lossless-binding exceptions use the original scan.
No Unicode exception map, new SQL function, schema/index, candidate limit,
response shortcut, request allowance or fallback pool is introduced.

All existing metadata, selected-row conversion-error predicates, native chunk
identity, authorized-file scope, ordered output, exhaustive count and payload
limits remain. Unicode Kelvin/dotted-I, Unicode needles, NUL content, nullable
collection records, caps and nonmatching malformed-row controls exercise those
invariants against real SQLite.

Read-only measurements used the original live database while the coordinator
owned the running app. The inventory was about 8,012 files / 65,451 chunks and
the store identity remained `71763187565c469bc81decd336b84222d5cda88f1eb4113e16a3dfa53e0283fd`.
The benchmark used Electron 44.4.5 in Node mode without an app window or user-data
writes. Direct engine work for the UI phrase measured 789.947 ms before and
472.354 ms after; the live inventory advanced slightly between those two reads.

A stronger paired owned-client run captured one authorized stored-file inventory
for both versions, used the unchanged one-second deadline and confirmed actual
process exit on every outcome:

| Literal | Original request | Candidate request | Result |
| --- | ---: | ---: | --- |
| workspace indexing startup | 900.168 ms | 453.177 ms | Both zero grep matches |
| native index | 964.315 ms | 494.027 ms | Both 76 matches; ordered chunk IDs identical |
| canonical | Deadline failure at 1,001.431 ms | 498.443 ms | Candidate 2,101 matches, 100 output rows |

These are observed loaded-store query measurements, not foreground p95 or a
cross-platform guarantee. They do not prove final GUI semantic search until the
coordinator demonstrates that complete flow after rebuilding.

Receipts: `/tmp/m2-live-grep-baseline.log`, `/tmp/m2-live-grep-candidate.log`,
`/tmp/m2-live-grep-client-pair.log`. The original implementation with the new
transfer controls had 2 failing / 52 passing cases on the existing qualified
Node 26.8.2 memory-accounting runtime (`/tmp/m2-insensitive-grep-qualified-red.log`).
The original Electron implementation had those two failures plus an unchanged
INT64-minimum conversion assertion failure (`/tmp/m2-insensitive-grep-electron-baseline.log`).
The candidate retains that Electron failure; it is not an all-green Electron
suite or full regression claim. No runtime was installed or patched.

Final focused validation:

- The existing qualified Node 26.8.2 executable ran `node_modules/vitest/vitest.mjs run src/__tests__/literal-grep-prefilter.integration.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism` from `packages/sqlite-query`: 57/57 passed (`/tmp/m2-insensitive-grep-final-green.log`).
- `pnpm --filter @brainstrike/sqlite-query build`: exit 0 (`/tmp/m2-insensitive-grep-build.log`).
- `pnpm --filter @brainstrike/sqlite-query type-check`: exit 0, including 19 Effect diagnostic files (`/tmp/m2-insensitive-grep-types.log`).
- `pnpm dlx ultracite fix` on the two changed TypeScript files: exit 0 after extracting the literal predicate into a private helper (`/tmp/m2-insensitive-grep-ultracite-final.log`).
- `git diff --check`: exit 0.

The helper uses UTF-8 byte length equal to UTF-16 length to recognize an ASCII
folded needle without adding a control-character regex or materializing a
character array. Independent review found the final helper and SQL predicate
consistent with the conservative proof above. Final app and full regression
remain unverified in this focused receipt.

**CI is disabled due to cost; validation must run locally.**
