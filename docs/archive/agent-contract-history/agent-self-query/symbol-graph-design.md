# Symbol graph shape and lifecycle — evidence

Supports `docs/agents/agent-self-query.md` § "The symbol graph".
Read before changing migration 075, symbol extraction, or the name-based ref join. Extracted verbatim from the pre-distillation contract.

The code index carries a queryable symbol graph, extracted at chunking time
from the SAME parse that produces chunks (no separate walker — both the
initial sync and the edit-reindex path converge there):

- `file_symbols` — definitions: name, kind
  (`function|class|method|variable|interface|type|enum`), `exported`,
  line/offset ranges. JS/TS via the ESTree walker (oxc on desktop, Babel on
  web — same fields); Python via tree-sitter name captures.
- `file_symbol_refs` — name-based references: kind
  (`call|import|extends|implements`), `module` for imports, and
  `from_symbol_seq` = the ENCLOSING definition's seq (always intra-file).

**Refs store names, not resolved symbol ids — a settled ruling.** Symbol rows
share the chunk lifecycle (hard-deleted and re-inserted on every edit), so a
stored cross-file id would dangle after every re-index of the target file.
Cross-file edges are resolved at QUERY time by joining `refs.name =
symbols.name`. Over-connection (two `render`s alias) is the correct failure
direction for a retrieval index; exact resolution is the LSP pool's job, on
demand, later.

The headline traversal — transitive callers — is one statement, and its shape
(`UNION` dedup + join-terminated + explicit depth bound) is exactly what the
recursion guard admits:

```sql
WITH RECURSIVE callers(file_record_id, seq, name, depth) AS (
  SELECT s.file_record_id, s.seq, s.name, 0
  FROM file_symbols s WHERE s.name = 'startEmbeddingWorker'
  UNION
  SELECT encl.file_record_id, encl.seq, encl.name, c.depth + 1
  FROM callers c
  JOIN file_symbol_refs r ON r.name = c.name AND r.kind = 'call'
  JOIN file_symbols encl
    ON encl.file_record_id = r.file_record_id AND encl.seq = r.from_symbol_seq
  WHERE c.depth < 10
)
SELECT DISTINCT fr.path, c.name, c.depth
FROM callers c JOIN file_records fr ON fr.id = c.file_record_id
ORDER BY c.depth, fr.path;
```

Rows are keyed by composite `(file_record_id, seq)` — measured, not guessed:
v1 text ids cost ~98% of raw source bytes on this monorepo; the composite
shape brings the whole graph (22,920 symbols + 109,297 refs from 3,337 TS
files) to ~27 MB, with sub-250 ms cold traversals. `from_symbol_seq` is
always intra-file, so the enclosing join carries the file id along.

Lifecycle: a managed-cache REPLACE deletes a file's symbol rows explicitly
(the `file_records` row survives an edit, so FK CASCADE cannot do it); file
deletion cascades; re-extraction rides `chunks_processed_at = NULL` exactly
like chunks. Symbol persistence failure degrades LOUDLY to
chunks-without-symbols — it never fails the file import.
