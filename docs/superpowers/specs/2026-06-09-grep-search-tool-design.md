# Grep-First Search Tool — Design

**Date:** 2026-06-09
**Status:** Approved (brainstorm spec)
**Scope:** One PR. PGlite `pg_trgm` extension + `brainstrike.grepSearch` agent tool + prompt reorientation.

## Problem

The assistant's search tools (`brainstrike.retrieveContext`, `brainstrike.hybridSearch`) are
linguistic/semantic: tsvector FTS stems and tokenizes, vector search matches concepts. Neither can
find an exact substring, identifier, or regex match — `tsquery` cannot find `EmbeddingGate` inside
`ForegroundEmbeddingGate`, and stemming destroys code symbols. Agents are trained to reach for
grep-shaped tools first (exact pattern → read context → refine); the absence of one pushes the
model into semantic search for queries it is bad at.

## Goals

- A grep-shaped agent tool over indexed file content with ripgrep-style `path:line` results.
- Index-accelerated (no per-query full corpus scan) via `pg_trgm` trigram GIN index.
- True JavaScript regex semantics (agents emit PCRE/JS-flavored patterns, not Postgres POSIX).
- Reorient the assistant's default instructions so grep is the first-reach search verb.

## Non-Goals

- Chat-history grep (corpus is `file_chunks` only — user decision).
- BM25 ranking upgrade (`pg_textsearch`), trigram lane in RRF fusion, `btree_gin` composite
  indexes — all deferred follow-ups.
- Whole-file (`file_records.content`) grep — chunks carry `startLine`/`endLine`, which is what
  enables line-accurate output with no schema change.

## Decision Record

- **Corpus:** indexed files only (`file_chunks`).
- **Approach:** C — SQL trigram prefilter for candidate chunks, JS authoritative line matcher.
  - A (pure SQL `~`) rejected: Postgres POSIX regex semantics diverge from the JS/PCRE patterns
    agents emit; the mismatch produces wrong results or confusing errors.
  - B (pure JS scan) rejected: O(corpus) per query through the worker/IPC boundary; ignores the
    database.
- **Verified:** `pg_trgm` ships in installed `@electric-sql/pglite@0.5.1` as
  `@electric-sql/pglite/contrib/pg_trgm` (importable like the existing `live` extension).

## Architecture

### 1. Extension loading

Add `pg_trgm` to the extensions map at **every** PGlite construction site, exactly as `vector` is
loaded today:

- `packages/db/src/pglite-worker-entry.ts` (line ~40)
- `packages/db/src/wasm-loader.ts` (both branches, lines ~152/156)
- `apps/desktop/src/db-main.ts` (line ~357 — desktop main-process host; note it casts extension
  modules and has a `load-extensions` failure stage that must keep working)

### 2. Migration (dual-runner rule applies)

One numbered migration registered in **both**:

- `packages/db/src/migrations/index.ts` (numbered MigrationRunner — tests)
- `customMigrations` ledger in `packages/db/src/drizzle/migrate.ts` (real app)

Contents:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_file_chunks_content_trgm
  ON file_chunks USING gin (content gin_trgm_ops);
```

Use `IF NOT EXISTS` guards: the two migration paths create different table states. The extension
module must be passed to the PGlite constructor before `CREATE EXTENSION` runs (same ordering the
`vector` extension already relies on).

Index cost: trigram GIN ≈ 20–50% of indexed content size on disk. Acceptable for a local-first app.

### 3. Grep search service — `packages/db/src/search/grep-search-service.ts`

Two-phase execution:

**Phase 1 — SQL candidate selection (trigram-accelerated):**

- Literal mode (`isRegex: false`, default): escaped pattern via
  `content ILIKE '%' || $1 || '%'` (case-insensitive, default) or `LIKE` (case-sensitive).
  `%`/`_`/`\` in the user pattern are escaped — pattern is a literal, never a LIKE template.
- Regex mode (`isRegex: true`): extract literal runs ≥3 chars from the pattern (outside character
  classes/groups with quantifiers); prefilter on the longest literal with `ILIKE`. If no literal
  ≥3 chars is extractable, run a bounded candidate scan (`LIMIT` on candidate chunks) and set
  `scanLimited: true` in the result — explicit, never silent.
- Filters: `embeddingSetId` (defaults to active set — chunks are duplicated per embedding set;
  filtering to one set prevents duplicate matches), optional `filePaths` prefix filter via join to
  `file_records`.
- Selects: chunk `content`, `start_line`, file `path`. Never selects `embedding`.

**Phase 2 — JS authoritative match:**

- Split candidate chunk content into lines; run the real match per line (JS `RegExp` with computed
  flags, or `String.includes`/case-folded compare for literal mode).
- Absolute line number = chunk `startLine` + offset.
- Collect `contextLines` of before/after from within the chunk content.
- Dedupe on `(path, absoluteLine)` across overlapping chunks; sort by `(path, line)`; cap at
  `maxResults`, set `truncated: true` when capped.

### 4. Agent tool — `packages/agent/src/tools/grep-search-tool.ts`

`brainstrike.grepSearch`, dependency-injection pattern matching `createHybridSearchTool`
(host injects a `performGrepSearch` callback; desktop wiring lives beside
`apps/desktop/src/assistant-server/retrieval-tool.ts`, web equivalent in its assistant server).

Input schema:

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `pattern` | string (min 2 chars) | required | literal or regex source |
| `isRegex` | boolean | `false` | |
| `caseSensitive` | boolean | `false` | |
| `filePaths` | string[] | — | path prefixes |
| `contextLines` | int 0–5 | `1` | |
| `maxResults` | int | `50` | hard cap enforced server-side |

Output: `{ matches: Array<{ path, line, lineText, before: string[], after: string[] }>,
totalMatches, truncated, scanLimited }`.

### 5. Prompt reorientation

Update `buildDefaultInstructions` (`packages/agent/src/mastra/agent-runtime.ts`): grep is the
primary search verb for identifiers, exact strings, error messages, and known symbols;
`hybridSearch` when exact wording is unknown (concept queries); `retrieveContext` to pack context
after locating. Tool descriptions updated to match.

## Error Handling

- Invalid regex → structured tool error with the `RegExp` constructor message. No coercion to
  literal mode (no-silent-fallback rule).
- Empty/1-char pattern → schema validation error.
- Patterns under 3 literal chars work but are not index-accelerated; bounded by candidate `LIMIT`.
- `scanLimited` and `truncated` flags make every coverage reduction visible to the agent.

## Testing

- Real-PGlite integration test for the service: extension loads, index exists, literal/regex/case
  modes, line-number math across chunk boundaries, overlap dedupe, filePaths + embeddingSetId
  filters, truncation flags. **Register in both `packages/db/scripts/test-lanes.mjs` and
  `packages/db/scripts/coverage-lanes.mjs`.**
- Unit tests: regex literal-extraction, LIKE-escaping, absolute-line computation.
- Tool tests: schema validation, error shapes, DI contract (mocked `performGrepSearch`).
- Full suite green in one run (build, lint, types, unit) before completion.

## Follow-Ups (explicitly deferred)

- `pg_textsearch` (BM25) replacing `ts_rank` in the hybrid FTS lane (verify pglite 0.5.x compat).
- Trigram lane as a third RRF fusion source.
- `btree_gin` composite `(embedding_set_id, content_tsvector)` index.
- Chat-history grep (would need trigram index on the messages store).
