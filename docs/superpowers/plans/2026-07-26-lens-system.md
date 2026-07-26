# Lens system (BST-921) — named parameterized retrieval SQL as reviewable artifacts

> 2026-07-26. Follow-up to BST-913 (querySelf sandbox) and BST-935 (hybrid
> one-statement proof). "Retrieval strategy is a reviewable artifact."

## Shape

A **lens** is a `.sql` file under `.brainstrike/lenses/` (per mounted root,
then `~/.brainstrike/lenses/` — the persona two-tier convention), with a
comment header declaring a description and ordered parameters:

```sql
-- description: Hybrid retrieval over a symbol's caller graph
-- param: symbol text  Seed symbol name (e.g. startEmbeddingWorker)
-- param: terms text   BM25 terms (prose words; camelCase does not tokenize)
WITH RECURSIVE callers(...) AS ( ... WHERE s.name = $1 ... )
... to_bm25query($2, 'idx_file_chunks_content_bm25') ...
```

Invoked through `brainstrike.querySelf` — two new modes, no new tool:
`mode: 'listLenses'` (discovery, invalid entries VISIBLE with errors) and
`mode: 'lens'` + `lens: <id>` + `values: string[]` (positional, coerced by
declared type, fail-closed).

## Settled decisions

1. **Same sandbox, no elevation.** Lenses execute via `AgentSqlService.query`
   with the identical four-layer preamble + admission. A lens file is
   untrusted input, exactly like a persona file.
2. **Real bind parameters.** `query()` gains `params`; the row-cap wrapper
   preserves `$n` positions (LIMIT is a literal). NEVER string-interpolate a
   value into lens SQL.
3. **Parser is pure and lives in `assistant-contract`**
   (`parseLensFile` — no fs, no Electron), so packages/db golden tests and
   the desktop loader share one grammar. The fs loader
   (`lens-loader.ts`, desktop) mirrors `user-personas-loader.ts`: flat scan,
   50-file cap, 16 KiB file cap, `entries` with `status: 'ok' | 'invalid'`,
   first-id-wins across tiers, warn-once logging.
4. **Id = filename stem**, `^[a-z0-9][a-z0-9-]{0,63}$`. Flat scan only.
5. **Param grammar**: `-- param: <name> <type> <description>` in declaration
   order = `$1..$N`; types `text | integer | number | boolean`; the SQL's
   max placeholder must equal N and every `$k ≤ N` must appear (an unused or
   excess placeholder is an authoring error → invalid lens, not a runtime
   surprise).
6. **Every lens ships with a golden test.** The first lens,
   `.brainstrike/lenses/callers-hybrid.sql`, IS the BST-935 canonical
   statement parameterized; `packages/db/__tests__/search-lens-callers-hybrid.test.ts`
   reads THE file, parses it with the contract parser, and executes it
   through the sandbox against the BST-935 fixture. The file is the single
   source of truth (the test no longer carries its own copy).
7. **Admission with params** is settled empirically in L1 (does PGlite's
   `EXPLAIN (FORMAT JSON)` accept extended-protocol params?); whichever
   mechanism ships, execution uses true binds and the test pins that an
   injection-shaped value stays a literal.

## Layers (each red/green)

1. db: bind params through `query()` + admission; injection pin;
   placeholder/param-count mismatch errors.
2. assistant-contract: `parseLensFile` + caps + tests.
3. desktop: `scanUserLenses` loader + tests (mirror the persona 8).
4. desktop/agent: querySelf schema (`lens`, `values`), dispatch, coercion,
   projection for `listLenses`; prompt-budget raise recorded.
5. The shipped lens + golden test.
6. Docs (agent-self-query.md, workspace-context.md), PR, review loop, CDT.
