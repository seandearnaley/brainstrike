# Lossless literal grep candidate filtering

Preserve canonical JavaScript line matching, authorized scope, exhaustive counts,
snapshot identity and fatal row conversion errors when filtering native grep
candidates before sorting and transferring them from SQLite.

## 2026-10-04 record

The foreground benchmark in
`apps/desktop/qualification/m2-native/performance.spec.ts` supplies a
case-sensitive, non-regex literal:
`packages/foreground-latency-probe/never-indexed.ts:total +=`.
The original grep SQL transfers every authorized chunk in path/ID order before
JavaScript splits its content into lines and applies the shared matcher.

The candidate adds a bound `instr(ch.content,?)>0` condition inside that same
authorized subquery. A per-line literal match necessarily exists in the whole
content. The reverse need not hold, notably for a pattern containing a newline;
the shared JavaScript matcher remains the final authority. No SQL LIMIT is added.
The LEFT JOIN retains the metadata row when no candidates remain.

Well-formed Unicode literals without U+FFFD have an exact UTF-8 representation.
SQLite 3.53.4's `instrFunc` compares needle bytes with `memcmp` and skips only
UTF-8 continuation bytes while advancing possible start positions. Valid UTF-8
needle starts cannot be skipped. This applies to astral characters, combining
characters and embedded NUL, without an ASCII restriction.

Two pattern classes keep the existing scan:

- Lone UTF-16 surrogates can match a half-surrogate within a JavaScript string,
  but binding them replaces them rather than preserving those code units.
- U+FFFD can match invalid stored UTF-8 after Node replaces invalid bytes during
  decoding. SQLite `instr` cannot find that replacement in the original bytes.
  A real `CAST(X'61FF62' AS TEXT)` control demonstrates this difference.

Regex and case-insensitive literals also keep the existing scan. Their matching
semantics are not delegated to SQLite.

The predicate retains non-text content, non-finite REAL values in every projected
column, and INTEGER values outside JavaScript's safe range. The canonical reader
rejects these during decoding or native row conversion even when the content
does not match. All projection expressions share one list so collection metadata
is subject to the same protection. Metadata validation stays outside the filter.

Corruption and native row conversion errors are distinct from operational
resource failures. A filtered nonmatching row need not reproduce an engine
length-limit error caused by materializing or sorting its oversized values in
the original query. The control covers TEXT, BLOB and combined BLOB values:
the candidate avoids that work, while making the row match still fails under
the unchanged limit. No extra materialization or aggregate-size guard is added.
The corruption predicates do add SQLite type checks and numeric comparisons
for every projected column; their net performance cost is unmeasured.

## Verification

`literal-grep-prefilter.integration.test.ts` imports the production sandbox source
and uses real SQLite statements. Iterator instrumentation counts actual emitted
rows without substituting results. The first RED control observed 32 nonmatching
chunks transferred; GREEN emits one metadata-only row. A separate RED control
proved unsafe INTEGER errors were initially hidden; the final predicate retains
both signed extremes.

The fixture compares literal results against the canonical escaped-regex scan,
including authorization, nullable collections, empty inventory, ordered caps,
exhaustive counts, native chunk metadata, Unicode, NUL, newline, quotes and SQL
wildcards. It also checks non-text and non-finite values, invalid metadata, result
budgets, empty-pattern rejection and every one-byte malformed UTF-8 prefix before
four well-formed literal needles.

Runtime: the already-qualified Node v26.8.2 / SQLite 3.53.4 executable at
`/private/tmp/bst1941-node26-memstatus-preparation-20261004T102639Z/source/out/Release/node`.
The sandbox itself checks applied engine limits and enabled memory accounting.
No runtime build or relocation was performed.

This is a correctness and row-transfer candidate. No app benchmark was run after
the change, so throughput and foreground-latency improvement remain unmeasured.

## Same-day review correction: bound literal byte limit

Independent review found a valid request whose pattern was
`'漢'.repeat(6_000_000)`: its six million UTF-16 units pass public validation,
but its 18 million UTF-8 bytes exceed the configured 16 MiB SQLite length limit.
The initial candidate attempted to bind it and failed, while canonical scanning
returned zero matches. Eligibility now also requires
`Buffer.byteLength(options.pattern) <= LENGTH_LIMIT`, using the same constant as
the configured engine. Public request validation and engine limits are unchanged;
larger literals keep canonical scanning.

The production-connected RED control reproduced the exact error. A second
control at exactly 16 MiB of Unicode UTF-8 bytes already passed and remains
eligible. Both compare against the unfiltered literal path: Han and the ASCII
suffix have no case mapping, so case-insensitive literal scanning is an exact
comparator for these patterns. Iterator counts distinguish the canonical scan
from the metadata-only filtered result. No other behavior was changed.
