# Why the hybrid one-statement query is admitted — evidence

Supports `docs/agents/agent-self-query.md` § "The hybrid one-statement query (BST-935) — PROVEN admitted".
Read before changing the recursion guard, the BM25/vector arm idioms, or the `callers-hybrid` lens body. Extracted verbatim from the pre-distillation contract.

The original BST-919 pitch — traverse the graph, then rank the reachable
files' chunks with the BM25 and vector arms, fused, in ONE statement — runs
through the sandbox **as-is**. No sandbox change was needed; the guard's
allowlist direction survives contact with its headline use case.

**Be precise about WHY it is admitted, because the row cap plays no part.**
The statement's top level is a `GROUP BY … ORDER BY`, so `query()`'s
`LIMIT n+1` wrapper sits above a draining `Aggregate`/`Sort` — the walk in
`findUnboundableRecursion` reaches the `Recursive Union` with
`reachedByRowCap = false`, exactly as on the `explain(analyze)` path. The
statement drains fully regardless of `maxRows`. Admission rests entirely on
the recursion-bound heuristic (the depth filter + join conds below the
`Recursive Union` — a heuristic, not a termination proof; see "What counts
as a bound") plus the cost gate. Measured: planner cost ≈ 472 at a
2,005-chunk fixture and 25 ms wall-clock against a live 322-chunk workspace
— versus the 50,000 ceiling.

Idioms in the statement that are NOT discoverable via `describe` (operators
and an index name appear in no column listing), which is why the tool
description carries the first two:

- BM25 arm: `content <@> to_bm25query('terms', 'idx_file_chunks_content_bm25')`
  — raw score is ascending-better; the repositories negate it. english config
  does not split camelCase identifiers. Pair it with a
  `content_tsvector @@ websearch_to_tsquery(…)` match predicate so
  zero-relevance chunks earn no RRF mass.
- Vector arm: `embedding <=> (SELECT embedding FROM …)` — a STORED chunk
  embedding as the query vector (the chunk CONTAINING the seed symbol's
  `start_line`, not an arbitrary chunk of the file), so the whole statement
  needs no out-of-band embedding computation.
- **Scope the vector arm to the seed's `embedding_set_id`**
  (`IS NOT DISTINCT FROM`): `file_chunks.embedding` is deliberately
  dimensionless, and comparing across sets with different dimensions aborts
  the whole statement with `different vector dimensions`.
- Give each arm a `LIMIT` (canonically 50): the arms' work then scales with
  top-N, not with the size of the reachable set.

The canonical statement (traversal → `reachable` file set → both arms scoped
to it → RRF fusion `sum(1.0 / (60 + position))`) now SHIPS as the
`callers-hybrid` lens (`.brainstrike/lenses/callers-hybrid.sql` — see the
lens section below); the raw-SQL admission path stays pinned in
`packages/db/__tests__/search-hybrid-symbol-retrieval.test.ts`, including the
scoping proof (a bait chunk with content and embedding identical to the seed
chunk, in an unreachable file, must not appear), the mixed-dimension abort
without set scoping, thousand-chunk admission, and the BM25 index-name
tripwire against `BM25_CONTENT_INDEX_NAME`.
