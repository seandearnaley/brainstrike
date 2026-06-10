# Grep-First Search Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `pg_trgm`-backed `brainstrike.grepSearch` agent tool — exact/regex line-level search over indexed file chunks with ripgrep-style `path:line` results — and reorient the assistant prompt so grep is the first-reach search verb.

**Architecture:** Two-phase search (Approach C from the approved spec at `docs/superpowers/specs/2026-06-09-grep-search-tool-design.md`): a trigram-indexed SQL `ILIKE` prefilter selects candidate chunks; an authoritative JS matcher computes line-accurate matches (absolute line = chunk `startLine` + offset), dedupes overlapping chunks, and bounds output. The service lives in `packages/db` (platform-reusable, unit-testable); the tool is wired into the LIVE desktop tool registry (`buildDesktopAssistantTools`), NOT the unwired DI-tool pattern in `packages/agent/src/tools/hybrid-search-tool.ts` (that tool is dead code — confirmed during planning).

**Tech Stack:** PGlite 0.5.1 contrib `pg_trgm` (`@electric-sql/pglite/contrib/pg_trgm` — verified present), raw-SQL `FileChunkRepository`, zod schemas in `@brainstrike/agent`, contract registries in `@brainstrike/assistant-contract`, Vitest.

**Conventions that apply to every task:**
- Run commands from the package dir given in each step.
- Biome auto-formats on commit (lefthook). If a commit fails on formatting, run `pnpm dlx ultracite fix` and re-stage.
- TypeScript is strict with `exactOptionalPropertyTypes` — never assign `undefined` to an optional property; spread conditionally (`...(x === undefined ? {} : { x })`), as the existing code does.
- Never use `any` (except with existing biome-ignore patterns in `db-main.ts`).

---

### Task 1: Load `pg_trgm` in packages/db PGlite constructors

**Files:**
- Modify: `packages/db/src/wasm-loader.ts` (extension loaders ~lines 41–76, preload ~line 116, `createPGlite` ~lines 129–156)
- Modify: `packages/db/src/pglite-worker-entry.ts` (~lines 1–42)

- [ ] **Step 1: Add a cached trgm loader to wasm-loader.ts**

After `loadLiveExtension` (line ~76), add (mirroring the existing cached-promise pattern):

```typescript
let cachedTrgmPromise: Promise<VectorExtension> | null = null;

async function loadTrgmExtension(): Promise<VectorExtension> {
  if (!cachedTrgmPromise) {
    cachedTrgmPromise = (async () => {
      try {
        const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
        return pg_trgm;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`pg_trgm extension is required and failed to load: ${message}`);
      }
    })();
  }

  return cachedTrgmPromise;
}
```

(`VectorExtension` is just an alias for PGlite's `Extension` type — reuse it; do not invent a new alias.)

- [ ] **Step 2: Wire trgm into preload and createPGlite**

In `loadWasm()` (line ~116) change:

```typescript
await Promise.all([loadVectorExtension(), loadLiveExtension(), loadTrgmExtension()]);
```

In `createPGlite()` (line ~129) change:

```typescript
const [vector, live, pg_trgm] = await Promise.all([
  loadVectorExtension(),
  loadLiveExtension(),
  loadTrgmExtension(),
]);
```

and both constructor branches (lines ~152/156):

```typescript
    const db = normalizedDataDir
      ? new PGlite({
          dataDir: normalizedDataDir,
          extensions: { vector, live, pg_trgm },
        })
      : new PGlite({ extensions: { vector, live, pg_trgm } });
```

- [ ] **Step 3: Wire trgm into the worker entry**

`packages/db/src/pglite-worker-entry.ts` — add the import and extension (note: `live` is intentionally absent here; it is a client-side extension installed by `PGliteWorker`, per the existing comment. `pg_trgm` is an ENGINE extension and belongs here):

```typescript
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
```

and in the `init` callback:

```typescript
    const pgliteOptions: PGliteOptions = {
      extensions: { vector, pg_trgm },
    };
```

- [ ] **Step 4: Type-check the package**

Run from `packages/db`: `pnpm type-check` (or `pnpm tsc --noEmit` if no script — check package.json scripts first)
Expected: clean.

- [ ] **Step 5: Check for an extension-manifest test**

`packages/db/__tests__/runtime-import-extensions.test.ts` exists and may assert the exact set of dynamic extension imports. Run it:

Run from `packages/db`: `pnpm vitest run runtime-import-extensions`
Expected: if it fails by enumerating extension imports, add `pg_trgm` to its expectation following the existing entries' shape. Re-run until green.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/wasm-loader.ts packages/db/src/pglite-worker-entry.ts packages/db/__tests__/runtime-import-extensions.test.ts
git commit -m "feat(db): load pg_trgm extension in PGlite constructors"
```

---

### Task 2: Migration 037 — `CREATE EXTENSION pg_trgm` + trigram GIN index (dual-runner)

**Files:**
- Create: `packages/db/src/migrations/037-pg-trgm-grep-index.ts`
- Modify: `packages/db/src/migrations/index.ts` (import + array entry after migration 036)
- Modify: `packages/db/src/drizzle/migrate.ts` (import ~line 28, `customMigrations` ledger entry ~line 156)

- [ ] **Step 1: Write the migration**

Create `packages/db/src/migrations/037-pg-trgm-grep-index.ts`:

```typescript
import type { Migration } from './migration-runner';

/**
 * Migration 037: Enable pg_trgm and add a trigram GIN index for grep-style search
 *
 * Powers the brainstrike.grepSearch tool: substring (ILIKE '%...%') and
 * regex-literal prefilter queries on file_chunks.content become index scans
 * instead of sequential scans. Requires the pg_trgm extension module to be
 * passed to the PGlite constructor (see wasm-loader.ts / pglite-worker-entry.ts /
 * apps/desktop/src/db-main.ts) before CREATE EXTENSION can succeed.
 */

export const migration037PgTrgmGrepIndex: Migration = {
  version: 37,
  name: 'pg_trgm_grep_index',
  up: `
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE INDEX IF NOT EXISTS idx_file_chunks_content_trgm
      ON file_chunks USING gin (content gin_trgm_ops);
  `,
  down: `
    DROP INDEX IF EXISTS idx_file_chunks_content_trgm;

    DROP EXTENSION IF EXISTS pg_trgm;
  `,
};
```

- [ ] **Step 2: Register in the numbered runner**

`packages/db/src/migrations/index.ts` — add after the 036 import:

```typescript
import { migration037PgTrgmGrepIndex } from './037-pg-trgm-grep-index.js';
```

and append to the `migrations` array after `migration036WorkspaceIndexSystemRole`:

```typescript
  migration037PgTrgmGrepIndex,
```

- [ ] **Step 3: Register in the drizzle customMigrations ledger**

`packages/db/src/drizzle/migrate.ts` — add after the 036 import (~line 28):

```typescript
import { migration037PgTrgmGrepIndex } from '../migrations/037-pg-trgm-grep-index.js';
```

and append to `customMigrations` (~line 156, after the 036 entry — the ledger is append-only):

```typescript
  customMigration('custom-037-pg-trgm-grep-index', migration037PgTrgmGrepIndex),
```

- [ ] **Step 4: Run the migration-related test lanes and fix any enumeration assertions**

Tests like `drizzle-migrate.test.ts`, `db-migration-authority.test.ts`, and `migration-integration.test.ts` may assert migration counts or ledger contents.

Run from `packages/db`: `pnpm vitest run drizzle-migrate db-migration-authority migration-integration bootstrap`
Expected: failures only of the "expected N migrations" / snapshot-enumeration kind. Update those expectations to include migration 037 / `custom-037-pg-trgm-grep-index`, following how the 036 entries appear. Re-run until green. Any OTHER kind of failure means the migration SQL is wrong — stop and fix the migration, not the test.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/037-pg-trgm-grep-index.ts packages/db/src/migrations/index.ts packages/db/src/drizzle/migrate.ts packages/db/__tests__
git commit -m "feat(db): add migration 037 pg_trgm extension + trigram GIN index (both runners)"
```

---

### Task 3: Grep pattern utilities (LIKE escaping + trigram literal extraction)

**Files:**
- Create: `packages/db/src/search/grep-pattern.ts`
- Test: `packages/db/__tests__/search-grep-pattern.test.ts`

These are pure functions — strict TDD.

- [ ] **Step 1: Write the failing tests**

Create `packages/db/__tests__/search-grep-pattern.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  escapeLikeLiteral,
  extractTrigramLiteral,
  MIN_TRIGRAM_LITERAL_LENGTH,
} from '../src/search/grep-pattern.js';

describe('escapeLikeLiteral', () => {
  it('escapes LIKE metacharacters and backslashes', () => {
    expect(escapeLikeLiteral('100%_done\\x')).toBe('100\\%\\_done\\\\x');
  });

  it('passes plain text through unchanged', () => {
    expect(escapeLikeLiteral('createForegroundEmbeddingGate')).toBe(
      'createForegroundEmbeddingGate'
    );
  });
});

describe('extractTrigramLiteral', () => {
  it('returns the longest literal run from a regex', () => {
    expect(extractTrigramLiteral('embedding\\s+gate\\(')).toBe('embedding');
  });

  it('treats escaped punctuation as literal characters', () => {
    // \. is a literal dot — "config.load" wins over "load"
    expect(extractTrigramLiteral('config\\.load')).toBe('config.load');
  });

  it('drops the character preceding ? and * quantifiers', () => {
    // "colou?r": the u is optional, so only "colo" + "r" are guaranteed
    expect(extractTrigramLiteral('colou?r')).toBe('colo');
  });

  it('keeps the character preceding + (at least one occurrence)', () => {
    expect(extractTrigramLiteral('foob+ar')).toBe('foob');
  });

  it('drops the character preceding a brace quantifier', () => {
    expect(extractTrigramLiteral('abcd{0,3}ef')).toBe('abc');
  });

  it('breaks runs at character classes, dots, and anchors', () => {
    expect(extractTrigramLiteral('^get[A-Z]\\w+Handler$')).toBe('Handler');
  });

  it('breaks runs at class escapes like \\d and \\w', () => {
    expect(extractTrigramLiteral('version\\d+')).toBe('version');
  });

  it('returns null when no literal run reaches the minimum length', () => {
    expect(extractTrigramLiteral('\\d+\\.\\d+')).toBeNull();
    expect(extractTrigramLiteral('a.b.c')).toBeNull();
  });

  it('returns null for alternation (no single required literal)', () => {
    expect(extractTrigramLiteral('foobar|bazqux')).toBeNull();
  });

  it('returns null for negative lookaround (asserted-absent text is not required)', () => {
    expect(extractTrigramLiteral('(?!forbidden)allowed')).toBeNull();
    expect(extractTrigramLiteral('(?<!skip)needle')).toBeNull();
  });

  it('returns null when a group is optionalized (cannot attribute runs safely)', () => {
    expect(extractTrigramLiteral('(prefix)?suffix')).toBeNull();
  });

  it('collects literals inside non-optional groups', () => {
    expect(extractTrigramLiteral('(needle)stack')).toBe('needle');
  });

  it('exports the minimum literal length used by the service', () => {
    expect(MIN_TRIGRAM_LITERAL_LENGTH).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `packages/db`: `pnpm vitest run search-grep-pattern`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/db/src/search/grep-pattern.ts`:

```typescript
/**
 * Pattern utilities for grep-style search.
 *
 * escapeLikeLiteral: makes user text safe to embed in a LIKE/ILIKE pattern
 * (used with `ESCAPE '\'` in SQL).
 *
 * extractTrigramLiteral: conservatively extracts the longest literal substring
 * that a JS regex GUARANTEES to be present in any match, so it can drive a
 * trigram-indexed ILIKE prefilter. Returns null when no literal of at least
 * MIN_TRIGRAM_LITERAL_LENGTH chars is guaranteed — the caller must then fall
 * back to a bounded scan and surface that explicitly (no silent degradation).
 */

export const MIN_TRIGRAM_LITERAL_LENGTH = 3;

export function escapeLikeLiteral(literal: string): string {
  return literal.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Regex constructs we refuse to reason about — bail to bounded scan. */
const UNSUPPORTED_CONSTRUCTS = ['|', '(?!', '(?<!'];

function skipCharacterClass(source: string, openIndex: number): number {
  let i = openIndex + 1;
  if (source[i] === '^') {
    i += 1;
  }
  if (source[i] === ']') {
    i += 1; // leading ] is a literal member of the class
  }
  while (i < source.length && source[i] !== ']') {
    if (source[i] === '\\') {
      i += 1;
    }
    i += 1;
  }
  return i + 1; // past the closing ]
}

function skipBraceQuantifier(source: string, openIndex: number): number {
  let i = openIndex;
  while (i < source.length && source[i] !== '}') {
    i += 1;
  }
  return i + 1; // past the closing }
}

export function extractTrigramLiteral(source: string): string | null {
  for (const construct of UNSUPPORTED_CONSTRUCTS) {
    if (source.includes(construct)) {
      return null;
    }
  }
  // A `)` followed by an optionalizing quantifier makes every run inside that
  // group optional; attributing runs to groups needs a real parser. Bail.
  if (/\)[?*]|\)\{/.test(source)) {
    return null;
  }

  const runs: string[] = [];
  let current = '';
  const endRun = (): void => {
    if (current.length > 0) {
      runs.push(current);
      current = '';
    }
  };
  const dropLastAndEndRun = (): void => {
    current = current.slice(0, -1);
    endRun();
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (/[a-zA-Z0-9]/.test(next)) {
        endRun(); // class escape (\d \w \b \1 ...) — not a guaranteed literal
      } else {
        current += next; // escaped punctuation IS a literal character
      }
      i += 2;
      continue;
    }
    if (ch === '[') {
      endRun();
      i = skipCharacterClass(source, i);
      continue;
    }
    if (ch === '?' || ch === '*') {
      dropLastAndEndRun(); // preceding char is optional
      i += 1;
      continue;
    }
    if (ch === '{') {
      dropLastAndEndRun(); // {0,..} may allow zero occurrences — be conservative
      i = skipBraceQuantifier(source, i);
      continue;
    }
    if (ch === '+') {
      endRun(); // at least one occurrence — preceding char stays in the run
      i += 1;
      continue;
    }
    if (ch === '.' || ch === '^' || ch === '$' || ch === '(' || ch === ')') {
      endRun();
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  endRun();

  let longest = '';
  for (const run of runs) {
    if (run.length > longest.length) {
      longest = run;
    }
  }
  return longest.length >= MIN_TRIGRAM_LITERAL_LENGTH ? longest : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `packages/db`: `pnpm vitest run search-grep-pattern`
Expected: PASS (all cases). If `(prefix)?suffix` fails: the `\)[?*]` bail-out regex must run BEFORE scanning — verify ordering.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/search/grep-pattern.ts packages/db/__tests__/search-grep-pattern.test.ts
git commit -m "feat(db): grep pattern utilities (LIKE escaping, trigram literal extraction)"
```

---

### Task 4: Grep types + `findGrepCandidates` on the raw FileChunkRepository

**Files:**
- Create: `packages/db/src/models/grep.ts`
- Modify: `packages/db/src/repositories/file-chunk-repository.ts` (add method after `fullTextSearch`, ~line 590)
- Modify: `packages/db/src/models/index.ts` if one exists re-exporting models (check; mirror how `file-chunk.js` models are exported)

The desktop assistant server uses THIS repository (raw PGlite, `new FileChunkRepository(db)` — see `apps/desktop/src/assistant-server/retrieval-tool.ts:592`), not the drizzle variant. Implement here only; drizzle parity is a deferred follow-up.

- [ ] **Step 1: Define the model types**

Create `packages/db/src/models/grep.ts`:

```typescript
/** Options for the SQL candidate-selection phase of grep search. */
export interface GrepCandidateOptions {
  /** Case-sensitive matching: uses LIKE instead of ILIKE. */
  caseSensitive: boolean;
  /** Optional embedding-set filter (chunks are duplicated per set). */
  embeddingSetId?: string;
  /** Optional exact-path allowlist (file_records.path values). */
  filePaths?: readonly string[];
  /**
   * Pre-escaped LIKE pattern (no surrounding wildcards — the repository adds
   * them), or null for an unfiltered bounded scan (regex with no extractable
   * literal).
   */
  likePattern: string | null;
  /** Maximum candidate chunks to return. */
  limit: number;
}

/** One candidate chunk for JS-side line matching. */
export interface GrepCandidate {
  content: string;
  filePath: string;
  /** 1-based first line of the chunk within its file; null when unindexed. */
  startLine: number | null;
}
```

- [ ] **Step 2: Add the repository method**

In `packages/db/src/repositories/file-chunk-repository.ts`, import the types at the top (alongside the other `../models/` type imports):

```typescript
import type { GrepCandidate, GrepCandidateOptions } from '../models/grep';
```

Add after `fullTextSearch` (follow the file's existing raw-SQL style — numbered `$n` params, `this.db.query`; inspect a neighbor method for the exact query-execution idiom used in this class and match it):

```typescript
  /**
   * Candidate selection for grep search: trigram-accelerated ILIKE/LIKE
   * prefilter (idx_file_chunks_content_trgm), or a bounded unfiltered scan
   * when likePattern is null. Joins file_records for the path so the grep
   * service can emit path:line results without a second lookup.
   */
  async findGrepCandidates(options: GrepCandidateOptions): Promise<GrepCandidate[]> {
    const { likePattern, caseSensitive, embeddingSetId, filePaths, limit } = options;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (likePattern !== null) {
      params.push(`%${likePattern}%`);
      const operator = caseSensitive ? 'LIKE' : 'ILIKE';
      conditions.push(`fc.content ${operator} $${params.length} ESCAPE '\\'`);
    }
    if (embeddingSetId !== undefined) {
      params.push(embeddingSetId);
      conditions.push(`fc.embedding_set_id = $${params.length}`);
    }
    if (filePaths !== undefined && filePaths.length > 0) {
      params.push(Array.from(filePaths));
      conditions.push(`fr.path = ANY($${params.length}::text[])`);
    }
    params.push(limit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.db.query(
      `SELECT fc.content, fc.start_line, fr.path
         FROM file_chunks fc
         JOIN file_records fr ON fr.id = fc.file_record_id
         ${whereClause}
        ORDER BY fr.path, fc.chunk_index
        LIMIT $${params.length}`,
      params
    );

    return (result.rows as Array<{ content: string; path: string; start_line: number | null }>).map(
      (row) => ({
        content: row.content,
        filePath: row.path,
        startLine: row.start_line,
      })
    );
  }
```

IMPORTANT adaptation note (not optional): this class executes SQL through a `Queryable` adapter — check how `fullTextSearch` in THIS file (not the drizzle one) runs its query (`this.db.query(...)` vs an adapter helper) and use the same call shape. The SQL text and parameter list above are the contract; the execution idiom must match the file.

- [ ] **Step 3: Export the model types from the package**

Check how `models/file-chunk.js` types reach the public API (`packages/db/src/index.ts` or a models barrel). Add `export type { GrepCandidate, GrepCandidateOptions } from './models/grep.js';` at the same level.

- [ ] **Step 4: Type-check**

Run from `packages/db`: `pnpm type-check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/models/grep.ts packages/db/src/repositories/file-chunk-repository.ts packages/db/src/index.ts
git commit -m "feat(db): findGrepCandidates trigram-prefilter query on FileChunkRepository"
```

---

### Task 5: GrepSearchService (authoritative JS line matcher)

**Files:**
- Create: `packages/db/src/search/grep-search-service.ts`
- Modify: `packages/db/src/search/index.ts` (exports)
- Test: `packages/db/__tests__/search-grep-service.test.ts` (unit, stub repository)

- [ ] **Step 1: Write the failing unit tests**

Create `packages/db/__tests__/search-grep-service.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { GrepCandidate, GrepCandidateOptions } from '../src/models/grep.js';
import { GrepSearchService } from '../src/search/grep-search-service.js';

function stubRepository(candidates: GrepCandidate[], calls: GrepCandidateOptions[] = []) {
  return {
    calls,
    findGrepCandidates: (options: GrepCandidateOptions): Promise<GrepCandidate[]> => {
      calls.push(options);
      return Promise.resolve(candidates);
    },
  };
}

const CHUNK_A: GrepCandidate = {
  filePath: 'src/alpha.ts',
  startLine: 10,
  content: 'const gate = createGate();\nawait gate.open();\nreturn gate;',
};

describe('GrepSearchService', () => {
  it('returns line-accurate matches with context from chunk content', async () => {
    const repo = stubRepository([CHUNK_A]);
    const service = new GrepSearchService(repo);
    const result = await service.search({ pattern: 'gate.open', contextLines: 1 });

    expect(result.matches).toEqual([
      {
        path: 'src/alpha.ts',
        line: 11,
        lineText: 'await gate.open();',
        before: ['const gate = createGate();'],
        after: ['return gate;'],
      },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.scanLimited).toBe(false);
  });

  it('is case-insensitive by default and case-sensitive on request', async () => {
    const repo = stubRepository([CHUNK_A]);
    const service = new GrepSearchService(repo);
    const insensitive = await service.search({ pattern: 'CREATEGATE' });
    expect(insensitive.matches).toHaveLength(1);
    const sensitive = await service.search({ pattern: 'CREATEGATE', caseSensitive: true });
    expect(sensitive.matches).toHaveLength(0);
  });

  it('passes an escaped ILIKE pattern for literal mode', async () => {
    const calls: GrepCandidateOptions[] = [];
    const service = new GrepSearchService(stubRepository([], calls));
    await service.search({ pattern: '100%_done' });
    expect(calls[0]?.likePattern).toBe('100\\%\\_done');
    expect(calls[0]?.caseSensitive).toBe(false);
  });

  it('prefilters regex mode on the longest extracted literal', async () => {
    const calls: GrepCandidateOptions[] = [];
    const service = new GrepSearchService(stubRepository([], calls));
    await service.search({ pattern: 'embedding\\s+gate', isRegex: true });
    expect(calls[0]?.likePattern).toBe('embedding');
  });

  it('matches with real JS regex semantics', async () => {
    const repo = stubRepository([CHUNK_A]);
    const service = new GrepSearchService(repo);
    const result = await service.search({ pattern: 'gate\\.\\w+\\(\\)', isRegex: true });
    expect(result.matches.map((m) => m.line)).toEqual([11]);
  });

  it('flags scanLimited when a regex has no extractable literal', async () => {
    const calls: GrepCandidateOptions[] = [];
    const service = new GrepSearchService(stubRepository([CHUNK_A], calls));
    const result = await service.search({ pattern: '\\d+\\.\\d+', isRegex: true });
    expect(calls[0]?.likePattern).toBeNull();
    expect(result.scanLimited).toBe(true);
  });

  it('throws a structured error for an invalid regex (no literal fallback)', async () => {
    const service = new GrepSearchService(stubRepository([]));
    await expect(service.search({ pattern: '([unclosed', isRegex: true })).rejects.toThrow(
      /Invalid regular expression pattern/
    );
  });

  it('dedupes overlapping chunks on (path, line) and sorts by path then line', async () => {
    const overlapping: GrepCandidate[] = [
      { filePath: 'src/b.ts', startLine: 5, content: 'needle here\nfiller' },
      { filePath: 'src/b.ts', startLine: 4, content: 'previous\nneedle here' },
      { filePath: 'src/a.ts', startLine: 1, content: 'needle first' },
    ];
    const service = new GrepSearchService(stubRepository(overlapping));
    const result = await service.search({ pattern: 'needle' });
    expect(result.matches.map((m) => `${m.path}:${m.line}`)).toEqual(['src/a.ts:1', 'src/b.ts:5']);
  });

  it('caps results at maxResults and reports truncation + totalMatches', async () => {
    const many: GrepCandidate[] = [
      { filePath: 'src/c.ts', startLine: 1, content: 'hit\nhit\nhit\nhit' },
    ];
    const service = new GrepSearchService(stubRepository(many));
    const result = await service.search({ pattern: 'hit', maxResults: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.totalMatches).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it('skips chunks without startLine and counts them', async () => {
    const noLines: GrepCandidate[] = [
      { filePath: 'src/d.ts', startLine: null, content: 'needle but no line metadata' },
    ];
    const service = new GrepSearchService(stubRepository(noLines));
    const result = await service.search({ pattern: 'needle' });
    expect(result.matches).toHaveLength(0);
    expect(result.skippedMissingLineMetadata).toBe(1);
  });

  it('rejects patterns shorter than 2 characters', async () => {
    const service = new GrepSearchService(stubRepository([]));
    await expect(service.search({ pattern: 'x' })).rejects.toThrow(/at least 2 characters/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `packages/db`: `pnpm vitest run search-grep-service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `packages/db/src/search/grep-search-service.ts`:

```typescript
/**
 * Grep Search Service
 *
 * Two-phase grep over indexed file chunks:
 *   Phase 1 (SQL): trigram-accelerated ILIKE/LIKE candidate selection via
 *     GrepSearchRepository (idx_file_chunks_content_trgm). Regex patterns are
 *     prefiltered on their longest guaranteed literal (extractTrigramLiteral);
 *     patterns with no such literal fall back to a bounded scan, surfaced via
 *     scanLimited (never silent).
 *   Phase 2 (JS): authoritative per-line matching with real JS RegExp
 *     semantics, absolute line numbers from chunk startLine, context lines,
 *     (path, line) dedupe across overlapping chunks, and bounded output.
 */

import type { GrepCandidate, GrepCandidateOptions } from '../models/grep.js';
import { escapeLikeLiteral, extractTrigramLiteral } from './grep-pattern.js';

export interface GrepSearchRepository {
  findGrepCandidates(options: GrepCandidateOptions): Promise<GrepCandidate[]>;
}

export interface GrepSearchOptions {
  /** Bounded candidate-pool size for phase 1 (default 500). */
  candidateLimit?: number;
  /** Case-sensitive matching (default false). */
  caseSensitive?: boolean;
  /** Lines of context before/after each match, from within the chunk (0–5, default 1). */
  contextLines?: number;
  /** Optional embedding-set filter; dedupe also guards against cross-set duplicates. */
  embeddingSetId?: string;
  /** Optional exact-path allowlist. */
  filePaths?: readonly string[];
  /** Treat pattern as a JavaScript regular expression (default false: literal). */
  isRegex?: boolean;
  /** Maximum matches returned (default 50). */
  maxResults?: number;
  /** Literal text or JS regex source. Minimum 2 characters. */
  pattern: string;
}

export interface GrepMatch {
  after: string[];
  before: string[];
  line: number;
  lineText: string;
  path: string;
}

export interface GrepSearchResult {
  /** Phase-1 candidate pool hit its limit — more files may contain matches. */
  candidatesTruncated: boolean;
  matches: GrepMatch[];
  /** Phase 1 ran without a trigram prefilter (regex had no extractable literal). */
  scanLimited: boolean;
  /** Chunks that matched but lack startLine metadata (cannot report path:line). */
  skippedMissingLineMetadata: number;
  /** Matches found across scanned candidates before the maxResults cap. */
  totalMatches: number;
  truncated: boolean;
}

export const GREP_DEFAULT_MAX_RESULTS = 50;
export const GREP_DEFAULT_CONTEXT_LINES = 1;
export const GREP_DEFAULT_CANDIDATE_LIMIT = 500;
const MIN_PATTERN_LENGTH = 2;

interface LineMatcher {
  matches(line: string): boolean;
}

function buildLiteralMatcher(pattern: string, caseSensitive: boolean): LineMatcher {
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return {
    matches: (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle),
  };
}

function buildRegexMatcher(pattern: string, caseSensitive: boolean): LineMatcher {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression pattern: ${message}`);
  }
  return { matches: (line) => regex.test(line) };
}

function resolveLikePattern(pattern: string, isRegex: boolean): string | null {
  if (!isRegex) {
    return escapeLikeLiteral(pattern);
  }
  const literal = extractTrigramLiteral(pattern);
  return literal === null ? null : escapeLikeLiteral(literal);
}

export class GrepSearchService {
  constructor(private readonly repository: GrepSearchRepository) {}

  async search(options: GrepSearchOptions): Promise<GrepSearchResult> {
    const pattern = options.pattern;
    if (pattern.length < MIN_PATTERN_LENGTH) {
      throw new Error(`Grep pattern must be at least ${MIN_PATTERN_LENGTH} characters.`);
    }
    const isRegex = options.isRegex ?? false;
    const caseSensitive = options.caseSensitive ?? false;
    const contextLines = options.contextLines ?? GREP_DEFAULT_CONTEXT_LINES;
    const maxResults = options.maxResults ?? GREP_DEFAULT_MAX_RESULTS;
    const candidateLimit = options.candidateLimit ?? GREP_DEFAULT_CANDIDATE_LIMIT;

    // Build the matcher FIRST so an invalid regex fails before any DB work.
    const matcher = isRegex
      ? buildRegexMatcher(pattern, caseSensitive)
      : buildLiteralMatcher(pattern, caseSensitive);
    const likePattern = resolveLikePattern(pattern, isRegex);

    const candidateOptions: GrepCandidateOptions = {
      likePattern,
      caseSensitive,
      limit: candidateLimit,
      ...(options.embeddingSetId === undefined ? {} : { embeddingSetId: options.embeddingSetId }),
      ...(options.filePaths === undefined ? {} : { filePaths: options.filePaths }),
    };
    const candidates = await this.repository.findGrepCandidates(candidateOptions);

    const seen = new Set<string>();
    const matches: GrepMatch[] = [];
    let totalMatches = 0;
    let skippedMissingLineMetadata = 0;

    for (const candidate of candidates) {
      const lines = candidate.content.split('\n');
      let candidateHasMatch = false;
      for (let index = 0; index < lines.length; index += 1) {
        const lineText = lines[index] ?? '';
        if (!matcher.matches(lineText)) {
          continue;
        }
        if (candidate.startLine === null) {
          candidateHasMatch = true;
          continue;
        }
        const absoluteLine = candidate.startLine + index;
        const key = `${candidate.filePath}:${absoluteLine}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        totalMatches += 1;
        matches.push({
          path: candidate.filePath,
          line: absoluteLine,
          lineText,
          before: lines.slice(Math.max(0, index - contextLines), index),
          after: lines.slice(index + 1, index + 1 + contextLines),
        });
      }
      if (candidateHasMatch && candidate.startLine === null) {
        skippedMissingLineMetadata += 1;
      }
    }

    matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    const capped = matches.slice(0, maxResults);

    return {
      matches: capped,
      totalMatches,
      truncated: totalMatches > capped.length,
      scanLimited: likePattern === null,
      candidatesTruncated: candidates.length >= candidateLimit,
      skippedMissingLineMetadata,
    };
  }
}

export function createGrepSearchService(repository: GrepSearchRepository): GrepSearchService {
  return new GrepSearchService(repository);
}
```

- [ ] **Step 4: Export from the search barrel**

Append to `packages/db/src/search/index.ts` (mirroring the hybrid exports' style):

```typescript
// Grep Search Service
export {
  createGrepSearchService,
  GREP_DEFAULT_CANDIDATE_LIMIT,
  GREP_DEFAULT_CONTEXT_LINES,
  GREP_DEFAULT_MAX_RESULTS,
  type GrepMatch,
  type GrepSearchOptions,
  GrepSearchService,
  type GrepSearchRepository,
  type GrepSearchResult,
} from './grep-search-service.js';
// Grep pattern utilities
export {
  escapeLikeLiteral,
  extractTrigramLiteral,
  MIN_TRIGRAM_LITERAL_LENGTH,
} from './grep-pattern.js';
```

Confirm `packages/db/src/index.ts` re-exports the search barrel (it exports the hybrid service today, so it does — verify, and add nothing if `export * from './search/index.js'` style is already present; otherwise mirror how hybrid symbols are re-exported).

- [ ] **Step 5: Run tests to verify they pass**

Run from `packages/db`: `pnpm vitest run search-grep-service search-grep-pattern`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/search/grep-search-service.ts packages/db/src/search/index.ts packages/db/src/index.ts packages/db/__tests__/search-grep-service.test.ts
git commit -m "feat(db): GrepSearchService two-phase grep with JS line matching"
```

---

### Task 6: Real-PGlite integration test + BOTH lane registries

**Files:**
- Test: `packages/db/__tests__/search-grep.integration.test.ts`
- Modify: `packages/db/scripts/coverage-lanes.mjs` (add all three new test files to the lane that contains `hybrid-search-service.test.ts`)

Naming note: all three new test files start with `search-`, which auto-matches the `search` lane regex `/^search-/` in `test-lanes.mjs` — no edit needed THERE. `coverage-lanes.mjs` uses explicit filename lists and MUST be edited (this is the issue-#1101 trap).

- [ ] **Step 1: Write the integration test**

Create `packages/db/__tests__/search-grep.integration.test.ts`. Use `tsvector-generated-column.integration.test.ts` as the structural reference (PGlite via `wasmLoader.createPGlite('memory://...')`, `migrate(db)` from `../src/migrations/bootstrap.js`, `repo.insertMany([...])`, `await db.close()`):

```typescript
/**
 * Grep Search Integration Tests (real PGlite + pg_trgm)
 *
 * Proves: migration 037 creates the pg_trgm extension and trigram GIN index,
 * and GrepSearchService returns line-accurate matches end-to-end through the
 * raw FileChunkRepository candidate query.
 *
 * Run with: pnpm vitest run search-grep.integration
 */

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { GrepSearchService } from '../src/search/grep-search-service.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('grep search (integration)', () => {
  let db: PGlite;
  let repo: FileChunkRepository;
  let service: GrepSearchService;

  beforeAll(async () => {
    db = await wasmLoader.createPGlite('memory://grep-search-integration');
    await migrate(db);

    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO file_records (id, name, path, size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
      [
        'fr-alpha', 'alpha.ts', 'src/alpha.ts', 100, now, now,
        'fr-beta', 'beta.ts', 'src/beta.ts', 100, now, now,
      ]
    );

    const baseChunk = {
      contentHash: 'h',
      tokenCount: 10,
      chunkType: 'code' as const,
      chunkSize: 50,
    };
    const chunks: FileChunkInsert[] = [
      {
        ...baseChunk,
        id: 'gc-1',
        fileRecordId: 'fr-alpha',
        chunkIndex: 0,
        content: 'function createGate() {\n  return new ForegroundGate();\n}',
        startLine: 1,
        endLine: 3,
      },
      // Overlapping chunk: repeats line 2 ('return new ForegroundGate();')
      // with startLine 2, so dedupe on (path, line) is genuinely exercised.
      {
        ...baseChunk,
        id: 'gc-2',
        fileRecordId: 'fr-alpha',
        chunkIndex: 1,
        content: '  return new ForegroundGate();\n}\n\nexport const gate = createGate();',
        startLine: 2,
        endLine: 5,
      },
      {
        ...baseChunk,
        id: 'gc-3',
        fileRecordId: 'fr-beta',
        chunkIndex: 0,
        content: 'const version = "1.2.3"; // 100%_done marker',
        startLine: 1,
        endLine: 1,
      },
    ];
    repo = new FileChunkRepository(db);
    await repo.insertMany(chunks);
    service = new GrepSearchService(repo);
  });

  afterAll(async () => {
    await db.close();
  });

  it('registers the pg_trgm extension via migration 037', async () => {
    const res = await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(res.rows).toHaveLength(1);
  });

  it('creates the trigram GIN index on file_chunks.content', async () => {
    const res = await db.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'file_chunks' AND indexname = 'idx_file_chunks_content_trgm'`
    );
    const row = res.rows[0] as { indexdef: string } | undefined;
    expect(row?.indexdef).toContain('gin');
    expect(row?.indexdef).toContain('gin_trgm_ops');
  });

  it('finds literal matches with absolute line numbers', async () => {
    const result = await service.search({ pattern: 'foregroundgate' });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/alpha.ts');
    expect(result.matches[0]?.line).toBe(2);
    expect(result.matches[0]?.lineText).toContain('ForegroundGate');
  });

  it('treats LIKE metacharacters in the pattern as literals', async () => {
    const result = await service.search({ pattern: '100%_done' });
    expect(result.matches.map((m) => `${m.path}:${m.line}`)).toEqual(['src/beta.ts:1']);
  });

  it('supports regex mode end-to-end with literal prefilter', async () => {
    const result = await service.search({ pattern: 'create\\w+\\(\\)', isRegex: true });
    const keys = result.matches.map((m) => `${m.path}:${m.line}`);
    expect(keys).toContain('src/alpha.ts:1');
    expect(keys).toContain('src/alpha.ts:5');
    expect(result.scanLimited).toBe(false);
  });

  it('respects the filePaths filter', async () => {
    const result = await service.search({
      pattern: 'createGate',
      filePaths: ['src/beta.ts'],
    });
    expect(result.matches).toHaveLength(0);
  });

  it('dedupes overlapping chunks on (path, line)', async () => {
    // Line 2 ('return new ForegroundGate();') exists in BOTH gc-1 (startLine 1,
    // offset 1) and gc-2 (startLine 2, offset 0) — exactly one match must survive.
    const result = await service.search({ pattern: 'ForegroundGate' });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.line).toBe(2);
  });
});
```

Adaptation notes (verify against `tsvector-generated-column.integration.test.ts` before running): the exact `file_records` insert column list, the `FileChunkInsert` required fields, and whether the suite needs `TEST_ENABLE_VECTOR=true`. Match whatever that file does — it is the canonical reference for this suite family.

- [ ] **Step 2: Run the integration test**

Run from `packages/db`: `pnpm vitest run search-grep.integration`
Expected: PASS. If `CREATE EXTENSION pg_trgm` fails with "extension not found", Task 1's wasm-loader change isn't feeding `pg_trgm` into `createPGlite` — fix there, not here.

- [ ] **Step 3: Register all three new tests in coverage-lanes.mjs**

In `packages/db/scripts/coverage-lanes.mjs`, find the lane whose list contains `'hybrid-search-service.test.ts'` and add, keeping the list's existing alphabetical-ish placement:

```javascript
    'search-grep-pattern.test.ts',
    'search-grep-service.test.ts',
    'search-grep.integration.test.ts',
```

- [ ] **Step 4: Verify BOTH lane registries**

Run from `packages/db`:
```bash
node scripts/test-lanes.mjs check && node scripts/coverage-lanes.mjs check
```
Expected: both print success / no failures. An "is not assigned" error names the file you missed.

- [ ] **Step 5: Commit**

```bash
git add packages/db/__tests__/search-grep.integration.test.ts packages/db/scripts/coverage-lanes.mjs
git commit -m "test(db): grep search integration coverage, registered in both lane registries"
```

---

### Task 7: Agent input schema + assistant-contract registries

**Files:**
- Modify: `packages/agent/src/tools/schemas.ts` (add schema after `HybridSearchInputSchema`)
- Modify: `packages/agent/src/index.ts` (export schema + type alongside the other tool schemas, ~lines 306–349)
- Modify: `packages/assistant-contract/src/tool-categories.ts` (`NATIVE_TOOL_DEFAULTS`, after the `queryEmbeddingSpace` entry ~line 178)
- Modify: `packages/assistant-contract/src/tool-descriptions.ts` (`TOOL_DESCRIPTIONS`)
- Modify: `packages/assistant-contract/src/tool-schemas-display.ts` (display entry, after `findWorkspaceSymbol` ~line 110)

- [ ] **Step 1: Add the zod schema**

In `packages/agent/src/tools/schemas.ts`, after the hybrid-search block:

```typescript
// ============================================================================
// Grep Search Tool Schema
// ============================================================================

export const GrepSearchInputSchema = z
  .object({
    pattern: z
      .string()
      .min(2)
      .max(500)
      .describe('Exact text (default) or JavaScript regex to find in indexed file content'),
    isRegex: z
      .boolean()
      .optional()
      .describe('Treat pattern as a JavaScript regular expression (default false)'),
    caseSensitive: z.boolean().optional().describe('Case-sensitive matching (default false)'),
    filePaths: z
      .array(z.string().min(1))
      .max(1000)
      .optional()
      .describe('Restrict the search to specific indexed file paths'),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe('Lines of context before/after each match (default 1)'),
    maxResults: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Maximum matches to return (default 50)'),
  })
  .strict();

export type GrepSearchInput = z.infer<typeof GrepSearchInputSchema>;
```

- [ ] **Step 2: Export from the agent package**

In `packages/agent/src/index.ts`, add `GrepSearchInputSchema` and `type GrepSearchInput` to the existing schema export block (match how `HybridSearchInputSchema`/`HybridSearchInput` are exported).

- [ ] **Step 3: Register in NATIVE_TOOL_DEFAULTS**

In `packages/assistant-contract/src/tool-categories.ts`, inside `NATIVE_TOOL_DEFAULTS` after the `'brainstrike.queryEmbeddingSpace'` entry:

```typescript
  'brainstrike.grepSearch': {
    category: 'retrieval',
    loadingTier: 'critical',
    requiresApproval: false,
    estimatedTokens: 160,
  },
```

(The native-tool preferences store keys off `NATIVE_TOOL_DEFAULTS` and stores per-tool overrides, so a newly registered tool defaults to enabled — verified during planning; no preferences migration needed.)

- [ ] **Step 4: Register the description**

In `packages/assistant-contract/src/tool-descriptions.ts`:

```typescript
  'brainstrike.grepSearch':
    'Grep indexed file content for an exact string or regex, returning path:line matches with context',
```

- [ ] **Step 5: Register the display schema**

In `packages/assistant-contract/src/tool-schemas-display.ts`, after the `findWorkspaceSymbol` entry, following its exact field shape:

```typescript
  'brainstrike.grepSearch': {
    toolId: 'brainstrike.grepSearch',
    description:
      'Grep indexed file content for an exact string or regex, returning path:line matches with context.',
    parameters: [
      {
        name: 'pattern',
        type: 'string',
        description: 'Exact text (default) or JavaScript regex to find',
        required: true,
        minLength: 2,
      },
      {
        name: 'isRegex',
        type: 'boolean',
        description: 'Treat pattern as a JavaScript regular expression',
        required: false,
        default: false,
      },
      {
        name: 'caseSensitive',
        type: 'boolean',
        description: 'Case-sensitive matching',
        required: false,
        default: false,
      },
      {
        name: 'filePaths',
        type: 'array',
        description: 'Restrict the search to specific indexed file paths',
        required: false,
      },
      {
        name: 'contextLines',
        type: 'number',
        description: 'Lines of context before/after each match',
        required: false,
        default: 1,
        min: 0,
        max: 5,
      },
      {
        name: 'maxResults',
        type: 'number',
        description: 'Maximum matches to return',
        required: false,
        default: 50,
        min: 1,
        max: 200,
      },
    ],
    returns:
      'Matches with file path, 1-based line number, line text, and surrounding context lines, plus truncation flags',
  },
```

Adapt field names to the file's actual `parameters` entry shape if it differs (read the `findWorkspaceSymbol` entry first).

- [ ] **Step 6: Run contract + agent tests, fix registry-parity assertions**

Run from repo root: `pnpm --filter @brainstrike/assistant-contract test && pnpm --filter @brainstrike/agent test`
Expected: failures only in tests that enumerate the registries (counts, id lists, parity between the three registries). Add `brainstrike.grepSearch` to those expectations. Re-run until green.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/tools/schemas.ts packages/agent/src/index.ts packages/assistant-contract/src
git commit -m "feat(agent,contract): grepSearch input schema and native-tool registry entries"
```

---

### Task 8: Desktop wiring — db-main extension + grep tool in the live registry

**Files:**
- Modify: `apps/desktop/src/db-main.ts` (extension loader after `loadPgLiveExtension` ~line 224, `getPGlite` ~line 227, `createVectorDatabase` ~line 345, call site ~line 1276)
- Create: `apps/desktop/src/assistant-server/grep-search-tool.ts`
- Modify: `apps/desktop/src/assistant-server/assistant-tools.ts` (tool id const + registry entry)
- Test: `apps/desktop/src/__tests__/assistant-server/grep-search-tool.test.ts`

- [ ] **Step 1: Load pg_trgm in the desktop main process**

In `apps/desktop/src/db-main.ts`, after `loadPgLiveExtension` (mirror its shape exactly, including `extractExtensionExport` and error logging):

```typescript
async function loadPgTrgmExtension(): Promise<unknown> {
  try {
    const trgmModule = await import('@electric-sql/pglite/contrib/pg_trgm');
    const pgTrgm = extractExtensionExport(trgmModule, 'pg_trgm');
    if (!pgTrgm) {
      throw new Error('pg_trgm export missing from module');
    }
    logger.debug('pg_trgm extension loaded successfully (ESM)');
    return pgTrgm;
  } catch (error) {
    const details = getErrorDetails(error);
    logger.error('pg_trgm extension failed to load.', details);
    throw new Error(
      `pg_trgm extension is required and failed to load via ESM import. (${details.message})`
    );
  }
}
```

Extend `getPGlite` to load and return it:

```typescript
const getPGlite = async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { migrate } = await import('@brainstrike/db');
  const vector = await loadPgVectorExtension();
  const live = await loadPgLiveExtension();
  const pgTrgm = await loadPgTrgmExtension();
  return { PGlite, migrate, vector, live, pgTrgm };
};
```

Extend `createVectorDatabase` with a `pgTrgm: unknown` parameter and pass it through (keep the existing biome-ignore comment style):

```typescript
async function createVectorDatabase(
  PGliteCtor: unknown,
  dataDir: string,
  vector: unknown,
  live: unknown,
  pgTrgm: unknown
) {
  // ...
  const instance: any = new Ctor({
    dataDir,
    // biome-ignore lint/suspicious/noExplicitAny: PGlite extension types not available at compile time
    extensions: { vector: vector as any, live: live as any, pg_trgm: pgTrgm as any },
  });
```

Then update the call site (~line 1276) to pass the new argument — find it via `grep -n "createVectorDatabase(" apps/desktop/src/db-main.ts` and add `pgTrgm` from the `getPGlite()` destructuring in that scope.

- [ ] **Step 2: Run the desktop db-main tests**

Run from `apps/desktop`: `pnpm vitest run db-main`
Expected: PASS (or failures only where tests stub `getPGlite`/`createVectorDatabase` — extend stubs with `pgTrgm`). Re-run until green.

- [ ] **Step 3: Write the failing tool test**

Create `apps/desktop/src/__tests__/assistant-server/grep-search-tool.test.ts`. Read `apps/desktop/src/__tests__/assistant-server/retrieval-tool.test.ts` FIRST — if its `../db-main` mocking idiom differs from the `vi.mock` below, follow that file's idiom instead (the assertions stay the same):

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGrepSearch } from '../../assistant-server/grep-search-tool';

const queryMock = vi.fn();

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => ({ query: queryMock })),
}));

describe('grep search tool', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('returns path:line matches for a literal pattern', async () => {
    queryMock.mockResolvedValue({
      rows: [{ content: 'alpha\nneedle line\nomega', start_line: 10, path: 'src/x.ts' }],
    });
    const result = await runGrepSearch({ pattern: 'needle' }, undefined);
    expect(result.matches).toEqual([
      {
        path: 'src/x.ts',
        line: 11,
        lineText: 'needle line',
        before: ['alpha'],
        after: ['omega'],
      },
    ]);
  });

  it('passes the workspace-index embedding set id from runtimeData', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await runGrepSearch(
      { pattern: 'needle' },
      { workspaceIndexEmbeddingSetId: 'set-1' }
    );
    const [sql, params] = queryMock.mock.calls[0] ?? [];
    expect(String(sql)).toContain('embedding_set_id');
    expect(params).toContain('set-1');
  });

  it('surfaces invalid-regex errors without coercion', async () => {
    await expect(runGrepSearch({ pattern: '([', isRegex: true }, undefined)).rejects.toThrow(
      /Invalid regular expression pattern/
    );
    expect(queryMock).not.toHaveBeenCalled();
  });
});
```

Adaptation notes: the `RuntimeData` literal in the second test may need additional required fields — build it the way retrieval-tool.test.ts builds its runtime data. If `FileChunkRepository`'s query path goes through an adapter rather than `db.query` directly, the mocked database shape must expose whatever the adapter calls (check `PGliteAdapter` usage in `packages/db/src/repositories/file-chunk-repository.ts:23`).

- [ ] **Step 4: Run it to verify failure**

Run from `apps/desktop`: `pnpm vitest run grep-search-tool`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement the desktop tool**

Create `apps/desktop/src/assistant-server/grep-search-tool.ts`:

```typescript
import type { GrepSearchInput, RuntimeData } from '@brainstrike/agent';
import {
  GrepSearchInputSchema,
  normalizeOptionalText,
  resolveWorkspaceIndexEmbeddingSetId,
} from '@brainstrike/agent';
import type { GrepSearchResult } from '@brainstrike/db';
import { FileChunkRepository, GrepSearchService } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import type { PGlite } from '@electric-sql/pglite';
import { getDatabase } from '../db-main';

const logger = createLogger('AssistantGrepSearchTool');

export const GREP_SEARCH_TOOL_ID = 'brainstrike.grepSearch' as const;

export async function runGrepSearch(
  input: GrepSearchInput,
  runtimeData: RuntimeData | undefined
): Promise<GrepSearchResult> {
  const db = (await getDatabase()) as unknown as PGlite;
  const repository = new FileChunkRepository(db);
  const service = new GrepSearchService(repository);

  const embeddingSetId =
    normalizeOptionalText(runtimeData?.embeddingSetId) ??
    resolveWorkspaceIndexEmbeddingSetId(runtimeData) ??
    undefined;

  try {
    return await service.search({
      pattern: input.pattern,
      ...(input.isRegex === undefined ? {} : { isRegex: input.isRegex }),
      ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }),
      ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
      ...(input.contextLines === undefined ? {} : { contextLines: input.contextLines }),
      ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
      ...(embeddingSetId === undefined ? {} : { embeddingSetId }),
    });
  } catch (error) {
    logger.error('grepSearch failed', { error, pattern: input.pattern.slice(0, 100) });
    throw error;
  }
}
```

Fix the placeholder import line to exactly match retrieval-tool.ts's PGlite type import. The service's own error messages ("Invalid regular expression pattern: ...", "Grep pattern must be at least 2 characters.") contain no sensitive data and are safe to rethrow as-is — that is why this tool rethrows rather than mapping to generic messages.

- [ ] **Step 6: Register in the live desktop tool registry**

In `apps/desktop/src/assistant-server/assistant-tools.ts`:

Add the import:

```typescript
import { GREP_SEARCH_TOOL_ID, runGrepSearch } from './grep-search-tool';
```

Add the schema/type to the existing `@brainstrike/agent` import block: `type GrepSearchInput, GrepSearchInputSchema`.

Add the registry entry inside `buildDesktopAssistantTools`'s `tools` object (after the `FIND_WORKSPACE_SYMBOL_TOOL_ID` entry, matching its shape):

```typescript
    [GREP_SEARCH_TOOL_ID]: {
      id: GREP_SEARCH_TOOL_ID,
      description:
        'Grep indexed file content for an exact string (default) or JavaScript regex. Returns path:line matches with surrounding context lines. Use this FIRST for identifiers, exact strings, and error messages; use semantic search only when you do not know the exact wording.',
      inputSchema: GrepSearchInputSchema,
      execute: async (input: ToolExecuteInput<GrepSearchInput>) => {
        const resolvedInput = parseToolExecuteInput(GrepSearchInputSchema, input);
        try {
          return await runGrepSearch(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('grepSearch failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
```

- [ ] **Step 7: Run desktop assistant-server tests**

Run from `apps/desktop`: `pnpm vitest run assistant-server grep-search-tool assistant-tools`
Expected: the new test passes; `assistant-tools.test.ts` may enumerate registered tool ids — add `brainstrike.grepSearch` to its expectations. Re-run until green.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/db-main.ts apps/desktop/src/assistant-server/grep-search-tool.ts apps/desktop/src/assistant-server/assistant-tools.ts apps/desktop/src/__tests__
git commit -m "feat(desktop): wire pg_trgm + brainstrike.grepSearch into the assistant tool registry"
```

---

### Task 9: Prompt reorientation — grep is the first-reach search verb

**Files:**
- Modify: `packages/agent/src/mastra/default-instructions.ts`
- Test: `packages/agent/src/mastra/__tests__/default-instructions.spec.ts`

- [ ] **Step 1: Extend the failing spec first**

Read `default-instructions.spec.ts` to learn its harness (it builds a `toolNameMap` and asserts substrings). Add cases:

```typescript
// 1. With grepSearch registered: instructions mention it BEFORE the semantic
//    search guidance and tell the model to use it first for exact strings.
// 2. Without grepSearch registered: instructions state exact-text search is
//    unavailable (mirroring how other tools degrade).
```

Concretely, assert: `expect(instructions).toContain('exact strings, identifiers, and error messages')` for the registered case, and `expect(instructions.indexOf(grepName)).toBeLessThan(instructions.indexOf(queryEmbeddingSpaceName))`.

Run from `packages/agent`: `pnpm vitest run default-instructions`
Expected: FAIL on the new cases.

- [ ] **Step 2: Implement the instruction changes**

In `packages/agent/src/mastra/default-instructions.ts`:

Add to `BRAINSTRIKE_CONTEXT_TOOL_IDS`:

```typescript
  grepSearch: 'brainstrike.grepSearch',
```

Add `grepSearch: string | null;` to `ModelFacingToolNames` (keep the interface's alphabetical field order) and resolve it in `getModelFacingToolNames`:

```typescript
    grepSearch: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.grepSearch
    ),
```

Add a grep-first instruction and reposition semantic search as the fallback. Replace the current `semanticSearchInstruction` construction with:

```typescript
  const grepSearchInstruction = names.grepSearch
    ? `For exact strings, identifiers, and error messages, call ${names.grepSearch} FIRST — it greps indexed file content and returns path:line matches with context. Prefer it over semantic search whenever you know the exact wording.`
    : 'Exact-text grep search is unavailable in this run.';
  const semanticSearchInstruction =
    names.listEmbeddingSpaces && names.queryEmbeddingSpace
      ? `When you do NOT know the exact wording (concept or behavior questions), call ${names.queryEmbeddingSpace} without embeddingSetId so it uses the Workspace Index. Use ${names.listEmbeddingSpaces} first only when you need coverage details or a specific non-default embedding space.`
      : 'Semantic workspace search is unavailable unless both listEmbeddingSpaces and queryEmbeddingSpace are registered.';
```

And in the returned template, insert `${grepSearchInstruction}` immediately before `${semanticSearchInstruction}` on the line that currently reads:

```
When project or codebase context is needed, use registered Brainstrike native tools explicitly. ${workspaceInspectionInstruction} ${grepSearchInstruction} ${semanticSearchInstruction} ${readContextInstruction}
```

- [ ] **Step 3: Run the spec**

Run from `packages/agent`: `pnpm vitest run default-instructions`
Expected: PASS — including pre-existing cases (the `formatAvailableToolNames` list now includes the grep name when registered; update any exact-string assertions that enumerate it).

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/mastra/default-instructions.ts packages/agent/src/mastra/__tests__/default-instructions.spec.ts
git commit -m "feat(agent): reorient default instructions around grep-first search"
```

---

### Task 10: Full verification (everything green in one run)

- [ ] **Step 1: Format**

Run from repo root: `pnpm dlx ultracite fix`
Expected: clean or auto-fixed files; re-stage anything it touched.

- [ ] **Step 2: Full suite**

Run from repo root:
```bash
pnpm build && pnpm lint && pnpm type-check && pnpm test
```
(Verify exact script names in the root `package.json` first — use the turbo equivalents the repo defines.)
Expected: ALL green in the same run. Iterate on failures; the team bar is build + lint + types + unit all passing together.

Known flake (memory): `@brainstrike/db` tests can be flaky under turbo concurrency — if the db package fails with unrelated tests, re-run it in isolation: `pnpm --filter @brainstrike/db test`.

- [ ] **Step 3: Both lane checks once more**

Run from `packages/db`:
```bash
node scripts/test-lanes.mjs check && node scripts/coverage-lanes.mjs check
```
Expected: both pass.

- [ ] **Step 4: Final commit (if formatting touched files)**

```bash
git add -A
git commit -m "chore: formatting and verification fixes for grep search feature"
```

---

## Out of Scope (do not implement)

- BM25 / `pg_textsearch`, trigram RRF lane, `btree_gin` composite index, chat-history grep, drizzle-repository `findGrepCandidates` parity, web wiring (web has no native assistant tool registry today) — all documented as follow-ups in the spec.

## Spec deviations made during planning (already reflected above)

1. **No DI tool in `packages/agent/src/tools/`**: the spec referenced the `createHybridSearchTool` DI pattern, but planning revealed that tool is dead code — the LIVE registry is `buildDesktopAssistantTools` in `apps/desktop/src/assistant-server/assistant-tools.ts`. The reusable logic lives in `@brainstrike/db` (`GrepSearchService`); the desktop tool is a thin adapter, exactly like `findWorkspaceSymbol`/`queryEmbeddingSpace`.
2. **`embeddingSetId` is optional** rather than "defaults to active set" hard-required: the service dedupes on `(path, line)`, so cross-set duplicates collapse; the desktop tool passes the workspace-index set id when the runtime provides one.
3. **Three contract registries** (`tool-categories`, `tool-descriptions`, `tool-schemas-display`) were not in the spec but are required for the tool to appear in preferences/UI — discovered during planning.
