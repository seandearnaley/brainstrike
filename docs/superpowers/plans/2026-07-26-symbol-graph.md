# Symbol graph v1 (BST-919): defs/refs/imports as relational tables

Date: 2026-07-26. Prerequisite BST-913/BST-923 (querySelf + explain) are on main,
so the graph has a query surface the moment it exists.

## The one-sentence design

Extract symbol definitions and name-based references at the chunking layer
(where both the full-index and incremental paths already converge), store them
in two indexed tables scoped like `file_chunks`, and let `brainstrike.querySelf`
traverse them with a recursive CTE — the join-terminated shape the recursion
guard explicitly preserves.

## The four open questions, settled

### 1. Resolution fidelity: name-based edges, resolved at QUERY time

Refs store the referenced **name**, not a resolved symbol id. This is a design
ruling, not a shortcut, for two reasons:

- **Id churn.** Symbol rows are deleted and re-inserted on every file edit
  (same lifecycle as chunks). A stored `to_symbol_id` into another file would
  dangle every time that file re-indexes. A name join
  (`refs.name = symbols.name`) is stable under churn by construction.
- **Fidelity honesty.** Exact resolution needs type information the parsers do
  not have. A name join over-connects (two `render` functions in different
  packages alias), which for a *retrieval* index is the correct failure
  direction: extra candidates, ranked down by the caller — never a silently
  missing edge. The LSP pool can disambiguate on demand later (TS/JS only);
  it is an enrichment path, not the index (no `documentSymbol`/bulk API today,
  4s budget, per-file lock — measured in `lsp-diagnostics.ts`).

`from_symbol_id` (the *enclosing* definition of a ref) IS a real id — but it
always points into the same file's extraction batch, inserted in the same
transaction, so it can never dangle across files.

### 2. Language coverage: JS/TS + Python, engine-agnostic where possible

- **JS/TS:** the extractor walks the ESTree `Program`. On desktop that comes
  from oxc via the parser host — the FULL tree already crosses IPC
  (`parser-host-entry.ts` sends `result.program` unpruned); the chunker just
  never read the names. On web it comes from Babel, which emits the same
  ESTree fields. One extractor, two engines.
- **Python:** tree-sitter's adapter deliberately strips nodes to
  `{type,start,end}` before the boundary. The `.scm` query gains name captures
  and the adapter carries them through — the change the exploration measured
  as small, made inside the adapter so the payload stays bounded.
- **Everything else:** no parser ⇒ no symbols. Same posture as chunking:
  absence, not degradation.

### 3. Web parity: extraction everywhere, query surface desktop-only

Extraction runs wherever chunking runs — both platforms, because the schema is
one schema and the Babel path has the data. The *query* surface (`querySelf`)
remains desktop-only (`WEB_NATIVE_TOOL_IDS` exclusion stands: no assistant
server in the browser). The tables being populated on web costs little and
keeps the door open.

### 4. Storage cost: measured before commit

Measured on this monorepo during implementation (numbers recorded in the PR):
symbol and ref counts, table + index bytes via `pg_total_relation_size`, and
extraction overhead on the chunking benchmark suite. Go/no-go gate: if the
graph exceeds ~15% of `file_chunks`' footprint, drop call-ref granularity to
imports+defs and file the rest.

## Schema (migration 075)

```sql
CREATE TABLE file_symbols (
  id text PRIMARY KEY,                     -- `${fileRecordId}_sym_${n}` (extraction order)
  file_record_id text NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  embedding_set_id text,                   -- denormalized, same dual-form scoping as chunks
  name text NOT NULL,
  kind text NOT NULL,                      -- function|class|method|variable|interface|type|enum
  exported boolean NOT NULL DEFAULT false,
  start_line int NOT NULL, end_line int NOT NULL,
  start_offset int NOT NULL, end_offset int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON file_symbols(name);
CREATE INDEX ON file_symbols(file_record_id);
CREATE INDEX ON file_symbols(embedding_set_id);

CREATE TABLE file_symbol_refs (
  id text PRIMARY KEY,                     -- `${fileRecordId}_ref_${n}`
  file_record_id text NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  embedding_set_id text,
  from_symbol_id text REFERENCES file_symbols(id) ON DELETE CASCADE,  -- enclosing def; NULL = module level
  name text NOT NULL,                      -- referenced name (unresolved by design)
  kind text NOT NULL,                      -- call|import|extends|implements
  module text,                             -- imports: the source specifier
  line int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON file_symbol_refs(name);
CREATE INDEX ON file_symbol_refs(file_record_id);
CREATE INDEX ON file_symbol_refs(from_symbol_id);
```

Registered in BOTH runners (numbered + drizzle `customMigrations`), read role
grants arrive via migration 074's `ALTER DEFAULT PRIVILEGES` automatically.
New db tests → regex in `dbUnitLaneDefinitions`.

## Lifecycle (the part that rots if unstated)

- **Insert:** the chunking worker returns `symbols` + `refs` alongside
  `chunks`; `chunking-worker-port` inserts them in the same flow that inserts
  chunks. Both index paths (initial sync + edit reindex) converge there, so
  there is NO separate walker — the BST-919 requirement.
- **Invalidate:** `applyManagedCacheReplacements` deletes
  `file_symbols`/`file_symbol_refs` rows for replaced files next to its
  existing chunk delete (symbols key on `file_record_id`, and the
  file_records row SURVIVES an edit, so CASCADE does not fire — the delete
  must be explicit). File deletion cascades via FK.
- **Re-extract:** rides `chunks_processed_at = NULL` exactly like chunks.

## The headline query (worked example for the tool description)

```sql
WITH RECURSIVE callers(id, name, depth) AS (
  SELECT s.id, s.name, 0 FROM file_symbols s WHERE s.name = 'startEmbeddingWorker'
  UNION
  SELECT encl.id, encl.name, c.depth + 1
  FROM callers c
  JOIN file_symbol_refs r ON r.name = c.name AND r.kind = 'call'
  JOIN file_symbols encl ON encl.id = r.from_symbol_id
  WHERE c.depth < 10
)
SELECT DISTINCT fr.path, c.name, c.depth
FROM callers c JOIN file_symbols s ON s.id = c.id
JOIN file_records fr ON fr.id = s.file_record_id
ORDER BY c.depth, fr.path;
```

`UNION` (dedup) + join-terminated + explicit depth bound — admitted by the
recursion guard on all three grounds. This exact statement is the CDT
verification target.

## Layers (red/green each, one branch, layered commits)

1. **db:** migration 075 + `FileSymbolRepository` (insertMany/deleteForFileRecords)
   + invalidation in `applyManagedCacheReplacements` + real-PGlite tests
   including the recursive traversal above.
2. **extraction:** `extract-symbols.ts` in chunking-worker against the ESTree
   walker (JS/TS defs/imports/calls/extends, exported flag) + tree-sitter
   `.scm`/adapter widening (Python defs/imports/calls) + fixture tests per
   language, including the "same extractor, Babel engine" case.
3. **wiring:** worker protocol carries symbols; port maps to inserts; both
   sync paths covered by integration test (edit a file → symbols replaced).
4. **surface:** querySelf description example + `docs/agents/agent-self-query.md`
   + `docs/agents/database.md` rows; storage measurement recorded; CDT
   manual run of the headline query.

## Non-goals (filed, not smuggled)

- LSP-resolved edges (follow-up; enrichment only).
- Method-receiver resolution (`obj.method()` stores `method`).
- Languages beyond JS/TS/Python.
- Web query surface.
