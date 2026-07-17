# Workspace Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Search tab beside Explorer in the context-explorer right panel: VS Code-inspired Text (grep) + Semantic (hybrid RRF) search over the indexed workspace, with checkbox curation of files/chunks into the Explorer selection + Tapestry ranges.

**Architecture:** New `@brainstrike/workspace-search` package (core executor + panel UI + selection bridge) composed by app-shell via a new `ExplorerSearchTabs` wrapper. Additive `rootIds` scoping + chunk metadata in `packages/db` search paths. Embedder resolution extracted from db-explorer into `packages/vector-management` and shared.

**Tech Stack:** TypeScript strict, React 19, Zustand, TreeTable (`@brainstrike/ui`), PGlite (real-DB integration tests), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-08-workspace-search-design.md` — read it first; it is the requirements contract.

## Global Constraints

- TypeScript strict, `noImplicitAny`; NEVER `any` — use `unknown` + narrowing. `exactOptionalPropertyTypes` is ON: use conditional spread (`...(x === undefined ? {} : { x })`), never assign `undefined` to optional props.
- No silent fallbacks: malformed input throws or surfaces visibly; structured degradation flags (`scanLimited`, `truncated`, …) must render, never be swallowed.
- Filenames kebab-case; components PascalCase exports; hooks `use-*.ts` / `useCamelCase`.
- Biome/Ultracite: block statements always; run `pnpm dlx ultracite fix` before each commit.
- New `packages/db/__tests__/*.test.ts` files MUST be registered in BOTH `packages/db/scripts/test-lanes.mjs` AND `packages/db/scripts/coverage-lanes.mjs`; verify with `node scripts/test-lanes.mjs check && node scripts/coverage-lanes.mjs check` (from `packages/db`).
- Tests that construct PGlite directly must load the full extension set (`vector`, `pg_trgm`, `live`) — mirror `packages/db/__tests__/drizzle-migrate.test.ts` setup exactly.
- Do NOT run dev servers or builds unless a step says so. The exit bar (final task) is build + lint + type-check + unit green in the same run.
- RED/GREEN TDD: write the failing test, see it fail, implement, see it pass, commit.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch: all work on `feature/workspace-search` (already created).

---

### Task 1: db — `rootIds` scoping + chunk metadata on the grep candidate path

**Files:**
- Modify: `packages/db/src/models/grep.ts`
- Modify: `packages/db/src/repositories/file-chunk-repository.ts` (`findGrepCandidates`, ~line 620)
- Modify: `packages/db/src/search/grep-search-service.ts`
- Test: `packages/db/__tests__/workspace-search-scoping.test.ts` (new)
- Modify: `packages/db/scripts/test-lanes.mjs`, `packages/db/scripts/coverage-lanes.mjs` (register the new test file)

**Interfaces:**
- Consumes: existing `GrepCandidateOptions`/`GrepCandidate`/`GrepSearchOptions`/`GrepMatch`.
- Produces (later tasks rely on these exact shapes):
  - `GrepCandidateOptions.rootIds?: readonly string[]` (AND-composed with existing filters; `rootId` stays for back-compat)
  - `GrepCandidate` gains `chunkId: string`, `endLine: number | null`
  - `GrepSearchOptions.rootIds?: readonly string[]`
  - `GrepMatch` gains `chunkId?: string`, `chunkStartLine?: number`, `chunkEndLine?: number`

- [ ] **Step 1: Write the failing tests**

Create `packages/db/__tests__/workspace-search-scoping.test.ts`. Copy the PGlite construction + migration setup verbatim from `packages/db/__tests__/drizzle-migrate.test.ts` (full extension set: `vector`, `pg_trgm`, `live`) into a local `createTestDb()` helper, then seed two roots, two files (one per root), and chunks via plain SQL INSERTs (uuids can be literal strings). Test body:

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
// PGlite + migration setup: mirror drizzle-migrate.test.ts imports exactly.
import { DrizzleFileChunkRepository } from '../src/repositories/file-chunk-repository';
import { createGrepSearchService } from '../src/search/grep-search-service';

// Seed constants
const ROOT_A = '00000000-0000-0000-0000-00000000000a';
const ROOT_B = '00000000-0000-0000-0000-00000000000b';
const SET_ID = '00000000-0000-0000-0000-0000000000e1';
const FILE_A = '00000000-0000-0000-0000-0000000000f1';
const FILE_B = '00000000-0000-0000-0000-0000000000f2';
const FILE_LEGACY = '00000000-0000-0000-0000-0000000000f3';

// In beforeAll, after migrations, seed:
//   roots: (ROOT_A,'path','Alpha','/a','live'), (ROOT_B,'path','Beta','/b','live')
//   embedding_sets row SET_ID (model_key 'local:test', dimensions 4, distance 'cosine', name 'T')
//   file_records: FILE_A(root ROOT_A, path 'src/alpha.ts'), FILE_B(root ROOT_B, path 'src/beta.ts'),
//     FILE_LEGACY(root_id NULL, path 'legacy.ts')
//   file_chunks: one chunk per file, content containing 'needleToken', start_line 10,
//     end_line 14, embedding_set_id SET_ID, chunk_index 0.

describe('grep rootIds scoping', () => {
  it('rootIds limits candidates to the given roots and excludes NULL-root legacy rows', async () => {
    const repo = new DrizzleFileChunkRepository(db);
    const service = createGrepSearchService(repo);
    const result = await service.search({
      pattern: 'needleToken',
      embeddingSetId: SET_ID,
      rootIds: [ROOT_A],
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/alpha.ts');
    expect(result.matches[0]?.rootId).toBe(ROOT_A);
  });

  it('rootIds spanning both roots returns both files but never the legacy row', async () => {
    const repo = new DrizzleFileChunkRepository(db);
    const service = createGrepSearchService(repo);
    const result = await service.search({
      pattern: 'needleToken',
      embeddingSetId: SET_ID,
      rootIds: [ROOT_A, ROOT_B],
    });
    expect(result.matches.map((m) => m.path).sort()).toEqual(['src/alpha.ts', 'src/beta.ts']);
  });

  it('matches carry containing-chunk identity and line range', async () => {
    const repo = new DrizzleFileChunkRepository(db);
    const service = createGrepSearchService(repo);
    const result = await service.search({
      pattern: 'needleToken',
      embeddingSetId: SET_ID,
      rootIds: [ROOT_A],
    });
    const match = result.matches[0];
    expect(match?.chunkId).toBeTruthy();
    expect(match?.chunkStartLine).toBe(10);
    expect(match?.chunkEndLine).toBe(14);
  });
});
```

- [ ] **Step 2: Register the test file in BOTH lane registries, then run to verify failure**

Add `workspace-search-scoping.test.ts` to the lane arrays in `packages/db/scripts/test-lanes.mjs` and `packages/db/scripts/coverage-lanes.mjs` (follow how existing files are listed). Then:

Run: `cd packages/db && node scripts/test-lanes.mjs check && node scripts/coverage-lanes.mjs check && pnpm vitest run __tests__/workspace-search-scoping.test.ts`
Expected: lane checks PASS; tests FAIL (rootIds/chunkId unknown).

- [ ] **Step 3: Implement the model + repository + service changes**

`packages/db/src/models/grep.ts` — add to `GrepCandidateOptions`:
```ts
  /** Optional multi-root workspace filter (file_records.root_id ∈ rootIds). */
  rootIds?: readonly string[];
```
and to `GrepCandidate`:
```ts
  /** Owning chunk id (file_chunks.id). */
  chunkId: string;
  /** 1-based last line of the chunk within its file; null when unindexed. */
  endLine: number | null;
```

`file-chunk-repository.ts` `findGrepCandidates` — after the existing `rootId` block add:
```ts
    if (rootIds !== undefined) {
      if (rootIds.length === 0) {
        return []; // empty allowlist = nothing allowed (mirror filePaths semantics)
      }
      params.push(Array.from(rootIds));
      conditions.push(`fr.root_id = ANY($${params.length}::text[])`);
    }
```
(destructure `rootIds` from `options`). Extend the SELECT to `SELECT fc.id AS chunk_id, fc.content, fc.start_line, fc.end_line, fr.path, fr.root_id, r.display_name` and the row mapping to include `chunkId: row.chunk_id`, `endLine: row.end_line` (extend the inline row type accordingly).

`grep-search-service.ts`:
- `GrepSearchOptions` gains `rootIds?: readonly string[]` (doc comment: multi-root workspace filter).
- `GrepMatch` gains `chunkId?: string; chunkStartLine?: number; chunkEndLine?: number;`.
- In `search()`, thread `...(options.rootIds === undefined ? {} : { rootIds: options.rootIds })` into `candidateOptions`.
- In `processCandidate`, when pushing a match add:
```ts
      chunkId: candidate.chunkId,
      chunkStartLine: candidate.startLine,
      ...(candidate.endLine === null ? {} : { chunkEndLine: candidate.endLine }),
```
(`candidate.startLine` is non-null on this path — the null case `continue`s above.)

- [ ] **Step 4: Run tests to verify pass**

Run: `cd packages/db && pnpm vitest run __tests__/workspace-search-scoping.test.ts`
Expected: PASS. Also run the existing grep tests to catch regressions: `pnpm vitest run -t grep` (or the package's full `pnpm test` if fast enough).

- [ ] **Step 5: Type-check, fix format, commit**

```bash
cd packages/db && pnpm type-check && cd ../.. && pnpm dlx ultracite fix
git add packages/db && git commit -m "feat(db): rootIds scoping + chunk metadata on grep candidate path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: db — `findGrepCandidates` on `ElectronFileChunkRepository`

Desktop-renderer Text mode is impossible without this: the electron repo has `searchSimilar`/`fullTextSearch` but no grep candidate path.

**Files:**
- Modify: `packages/db/src/repositories/electron-file-chunk-repository.ts`
- Test: `packages/db/src/repositories/__tests__/electron-file-chunk-repository.test.ts` if it exists (check first); otherwise add a unit test file next to existing electron repo tests exercising the SQL + mapping via a mocked `ElectronDbAPI` (`{ query: vi.fn() }`).

**Interfaces:**
- Produces: `ElectronFileChunkRepository.findGrepCandidates(options: GrepCandidateOptions): Promise<GrepCandidate[]>` — byte-identical SQL/semantics to the Drizzle version (Task 1 shape, including `rootIds`, `chunkId`, `endLine`).

- [ ] **Step 1: Write the failing test** — mocked `db.query` capturing SQL + params:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ElectronFileChunkRepository } from '../electron-file-chunk-repository';

describe('ElectronFileChunkRepository.findGrepCandidates', () => {
  it('builds the trigram prefilter with rootIds and maps candidates', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          chunk_id: 'c1', content: 'hello needle', start_line: 3, end_line: 7,
          path: 'src/a.ts', root_id: 'r1', display_name: 'Alpha',
        },
      ],
    });
    const repo = new ElectronFileChunkRepository({ query } as never);
    const candidates = await repo.findGrepCandidates({
      caseSensitive: false, likePattern: 'needle', limit: 500, rootIds: ['r1'],
    });
    expect(query.mock.calls[0]?.[0]).toContain("fc.content ILIKE $1 ESCAPE '\\\\'");
    expect(query.mock.calls[0]?.[0]).toContain('fr.root_id = ANY($2::text[])');
    expect(candidates[0]).toEqual({
      chunkId: 'c1', content: 'hello needle', filePath: 'src/a.ts',
      rootId: 'r1', rootName: 'Alpha', startLine: 3, endLine: 7,
    });
  });

  it('returns [] for an empty rootIds allowlist without querying', async () => {
    const query = vi.fn();
    const repo = new ElectronFileChunkRepository({ query } as never);
    await expect(
      repo.findGrepCandidates({ caseSensitive: false, likePattern: 'x', limit: 10, rootIds: [] })
    ).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd packages/db && pnpm vitest run -t findGrepCandidates` → FAIL (method missing).

- [ ] **Step 3: Implement** — copy the Task 1 (post-change) Drizzle `findGrepCandidates` method body verbatim into `ElectronFileChunkRepository` (the query seam is identical: `this.db.query(sql, params)`); import `GrepCandidate`/`GrepCandidateOptions` from `../models/grep.js`.

- [ ] **Step 4: Run tests** — same command, expected PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db && git commit -m "feat(db): findGrepCandidates on ElectronFileChunkRepository (desktop renderer grep)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: db — `rootIds` on `searchSimilar` + `fullTextSearch` (both repos) + `HybridSearchOptions`

**Files:**
- Modify: `packages/db/src/models/file-chunk.ts` (`ChunkSearchOptions`, `FTSSearchOptions`)
- Modify: `packages/db/src/repositories/file-chunk-repository.ts` (`searchSimilarPgVector` ~line 399, `fullTextSearch` ~line 508)
- Modify: `packages/db/src/repositories/electron-file-chunk-repository.ts` (same two methods)
- Modify: `packages/db/src/search/hybrid-search-service.ts` (`HybridSearchOptions` + option threading)
- Test: extend `packages/db/__tests__/workspace-search-scoping.test.ts`

**Interfaces:**
- Produces: `ChunkSearchOptions.rootIds?: readonly string[]`, `FTSSearchOptions.rootIds?: readonly string[]`, `HybridSearchOptions.rootIds?: readonly string[]` — all filter `file_record_id IN (SELECT id FROM file_records WHERE root_id = ANY($n::text[]))`.

- [ ] **Step 1: Write the failing tests** (append to the Task 1 file; seed embeddings on the chunks in `beforeAll` — 4-dim literal vectors like `'[0.1,0.2,0.3,0.4]'`):

```ts
describe('fullTextSearch rootIds scoping', () => {
  it('only returns chunks whose file is in the given roots', async () => {
    const repo = new DrizzleFileChunkRepository(db);
    const results = await repo.fullTextSearch('needleToken', {
      rootIds: [ROOT_B], limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.fileRecordId).toBe(FILE_B);
  });
});

describe('searchSimilar rootIds scoping', () => {
  it('excludes chunks outside the given roots (incl. NULL-root legacy)', async () => {
    const repo = new DrizzleFileChunkRepository(db);
    const results = await repo.searchSimilar([0.1, 0.2, 0.3, 0.4], {
      embeddingSetId: SET_ID, rootIds: [ROOT_A], threshold: 0, limit: 10,
    });
    expect(results.map((r) => r.chunk.fileRecordId)).toEqual([FILE_A]);
  });
});

describe('HybridSearchService rootIds threading', () => {
  it('passes rootIds to both arms', async () => {
    const searchSimilar = vi.fn().mockResolvedValue([]);
    const fullTextSearch = vi.fn().mockResolvedValue([]);
    const service = createHybridSearchService({ fullTextSearch, searchSimilar });
    await service.search('q', [0.1, 0.2, 0.3, 0.4], {
      embeddingSetId: SET_ID, rootIds: [ROOT_A],
    });
    expect(searchSimilar.mock.calls[0]?.[1]?.rootIds).toEqual([ROOT_A]);
    expect(fullTextSearch.mock.calls[0]?.[1]?.rootIds).toEqual([ROOT_A]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd packages/db && pnpm vitest run __tests__/workspace-search-scoping.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement**

`models/file-chunk.ts` — add to BOTH `ChunkSearchOptions` and `FTSSearchOptions`:
```ts
  /** Optional multi-root workspace scope (file_records.root_id ∈ rootIds). Empty array matches nothing. */
  rootIds?: readonly string[];
```

`file-chunk-repository.ts` — in `searchSimilarPgVector`, directly after the existing single-`rootId` subquery block (line ~401), add the plural variant (same subquery shape so the partial-HNSW predicate stays matchable):
```ts
    if (rootIds !== undefined) {
      whereParts.push(
        `file_record_id IN (SELECT id FROM file_records WHERE root_id = ANY($${paramIndex}::text[]))`
      );
      params.push(Array.from(rootIds));
      paramIndex += 1;
    }
```
(destructure `rootIds` from options; an empty array yields `ANY('{}')` = matches nothing, which is the correct allowlist semantics — add a test if in doubt). In `fullTextSearch`, add the identical block after the `appendSelectionFilters` call. Mirror BOTH additions into `ElectronFileChunkRepository`'s corresponding methods (their WHERE-builders have the same structure).

`hybrid-search-service.ts` — add `rootIds?: readonly string[]` to `HybridSearchOptions` (Common Filters section), destructure it in `search()`, and thread into both option objects:
```ts
    if (rootIds !== undefined) {
      vectorSearchOptions.rootIds = rootIds;
      ftsSearchOptions.rootIds = rootIds;
    }
```

- [ ] **Step 4: Run tests** — full file PASS + package regressions: `cd packages/db && pnpm test` (if the package suite is flaky under turbo, run in isolation per project memory).

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix && git add packages/db && git commit -m "feat(db): rootIds workspace scoping for vector, FTS, and hybrid search

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: vector-management — extract shared `useSearchEmbedder` from db-explorer

**Files:**
- Create: `packages/vector-management/src/search-embedder/use-search-embedder.ts`
- Create: `packages/vector-management/src/search-embedder/index.ts`
- Modify: `packages/vector-management/src/index.ts` (export) — check whether the package uses subpath exports; follow its existing pattern
- Modify: `packages/db-explorer/src/hooks/use-semantic-search-executor.ts` (consume the shared hook; delete the moved code)
- Test: `packages/vector-management/src/search-embedder/__tests__/use-search-embedder.test.tsx`

**Interfaces:**
- Produces (workspace-search consumes this in Task 7):
```ts
export type EmbedderRuntime = 'webgpu' | 'wasm' | 'hosted';
export interface SearchEmbedder {
  dispose?: () => Promise<void> | void;
  embedQuery: (text: string) => Promise<{ embedding: number[] }>;
  runtime: EmbedderRuntime;
}
export interface EmbeddingSetModelInfo {
  dimensions: number;
  modelKey: string;
  modelConfig: EmbeddingModelConfig | null; // resolved local config, null for hosted
}
export interface UseSearchEmbedderResult {
  /** Resolves (cached) embedder for the model; throws with named causes (no key, no local model, …). */
  ensureEmbedderReady: (info: EmbeddingSetModelInfo) => Promise<SearchEmbedder>;
  /** Embed with the device-loss single-retry semantics from db-explorer. */
  embedQueryWithRecovery: (info: EmbeddingSetModelInfo, text: string) => Promise<number[]>;
}
export function useSearchEmbedder(): UseSearchEmbedderResult;
```

- [ ] **Step 1: Move, don't rewrite.** Lift these VERBATIM from `packages/db-explorer/src/hooks/use-semantic-search-executor.ts` into `use-search-embedder.ts`: `SearchEmbedder`/`EmbedderRuntime`/`EmbedderError` types, `createHostedEmbedder`, `createLocalEmbedder`, `DEVICE_LOSS_ERROR_FRAGMENTS`, `isDeviceLossError`, `createHostedConfig` (as a module function), and the `embedderRef`/`currentModelKeyRef`/`initializingPromiseRef`/`disposeCachedEmbedder`/visibilitychange-dispose/`ensureEmbedderReady` machinery, wrapped as `useSearchEmbedder()`. `embedQueryWithRecovery` wraps the existing try/device-loss-retry block:

```ts
  const embedQueryWithRecovery = useCallback(
    async (info: EmbeddingSetModelInfo, text: string): Promise<number[]> => {
      const embedder = await ensureEmbedderReady(info);
      try {
        const { embedding } = await embedder.embedQuery(text);
        return embedding;
      } catch (error) {
        if (!isDeviceLossError(error)) {
          throw error;
        }
        logger.warn('WebGPU device loss detected; rebuilding embedder and retrying once', {
          error: error instanceof Error ? error.message : String(error),
        });
        await disposeCachedEmbedder('device-loss');
        const refreshed = await ensureEmbedderReady(info);
        const { embedding } = await refreshed.embedQuery(text);
        return embedding;
      }
    },
    [ensureEmbedderReady, disposeCachedEmbedder]
  );
```
The `devicePref` read (`useVectorPreferencesStore((s) => s.devicePref)`) moves into the hook. The model-info resolution (`getEmbeddingSetModelInfo` — a db query) STAYS with callers; the hook takes resolved `EmbeddingSetModelInfo`. Check `packages/vector-management/package.json` and add any missing deps the moved code needs (`@brainstrike/embeddings`, `@brainstrike/indexing-contract`, `@brainstrike/preferences`).

- [ ] **Step 2: Write the failing hook test** (renderHook from `@testing-library/react`; mock `@brainstrike/embeddings/factory` and `@brainstrike/embeddings/service` with `vi.mock`): asserts (a) hosted path returns an embedder whose `embedQuery` maps provider results, (b) same-model second call reuses the cached embedder (factory called once), (c) `embedQueryWithRecovery` retries exactly once on an error whose message contains `'device was lost'` and rethrows other errors untouched. Run to verify failure, then wire until green.

Run: `cd packages/vector-management && pnpm vitest run search-embedder`

- [ ] **Step 3: Refactor db-explorer to consume it.** In `use-semantic-search-executor.ts`, delete the moved code and replace with `const { embedQueryWithRecovery } = useSearchEmbedder();` — the executor's embedding block becomes `const embedding = await embedQueryWithRecovery(modelInfo, query);` (adapt `EffectiveModelInfo` → `EmbeddingSetModelInfo`; they carry the same three fields — if `resolveEmbeddingSetModelInfo` returns extra fields, map explicitly).

- [ ] **Step 4: Verify both packages green**

Run: `cd packages/vector-management && pnpm test && pnpm type-check && cd ../db-explorer && pnpm test && pnpm type-check`
Expected: PASS — db-explorer's existing semantic-search tests are the regression net for the refactor.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix && git add packages/vector-management packages/db-explorer
git commit -m "refactor: extract shared useSearchEmbedder into vector-management

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: workspace-search — package scaffold, result model, session store

**Files:**
- Create: `packages/workspace-search/package.json`, `tsconfig.json`, `tsconfig.test.json`, `tsup.config.ts` (or CLI flags in the build script), `vitest.config.ts` — copy each from `packages/context-actions` (small, current template) and adjust names/deps
- Create: `packages/workspace-search/src/core/search-result-model.ts`
- Create: `packages/workspace-search/src/core/workspace-search-store.ts`
- Create: `packages/workspace-search/src/index.ts`
- Test: `packages/workspace-search/src/core/__tests__/workspace-search-store.test.ts`

**Interfaces:**
- Produces (exact types later tasks import):

```ts
// search-result-model.ts
export type WorkspaceSearchMode = 'text' | 'semantic';
export type ResultProvenance = 'index'; // 'live' reserved for the dual-pass fast-follow

export interface WorkspaceSearchTextMatch {
  kind: 'match';
  chunkId: string;
  /** Containing chunk bounds, 1-based INCLUSIVE (FileChunk convention). */
  chunkStartLine: number;
  chunkEndLine: number;
  line: number;
  lineText: string;
  before: readonly string[];
  after: readonly string[];
  provenance: ResultProvenance;
}

export interface WorkspaceSearchChunkHit {
  kind: 'chunk';
  chunkId: string;
  startLine: number; // inclusive
  endLine: number;   // inclusive
  content: string;
  headline: string | null;
  tokenCount: number;
  /** Normalized 0–1 relevance (RRF-normalized). */
  score: number;
  provenance: ResultProvenance;
}

export type WorkspaceSearchChild = WorkspaceSearchTextMatch | WorkspaceSearchChunkHit;

export interface WorkspaceSearchFileResult {
  /** Present in semantic mode (from chunk.fileRecordId); absent in text mode. */
  fileRecordId?: string;
  path: string;
  /** DB roots.id — translate to adapter rootId at the app-shell seam. */
  dbRootId: string;
  rootDisplayName: string | null;
  children: readonly WorkspaceSearchChild[];
}

export interface WorkspaceSearchNotices {
  scanLimited: boolean;
  truncated: boolean;
  candidatesTruncated: boolean;
  skippedMissingLineMetadata: number;
}

export interface WorkspaceSearchResults {
  files: readonly WorkspaceSearchFileResult[];
  mode: WorkspaceSearchMode;
  notices: WorkspaceSearchNotices;
  totalMatches: number;
}
```

```ts
// workspace-search-store.ts (plain create(), session-lived per repo convention)
export type WorkspaceSearchStatus = 'idle' | 'searching' | 'results' | 'error';
interface WorkspaceSearchState {
  query: string;
  mode: WorkspaceSearchMode;
  caseSensitive: boolean;
  isRegex: boolean;
  wholeWord: boolean;
  /** embedding_sets.id; null = resolve the workspace-index set at query time. */
  collectionId: string | null;
  expandedIds: Set<string>;
  status: WorkspaceSearchStatus;
  error: string | null;
  results: WorkspaceSearchResults | null;
  setQuery: (q: string) => void;
  setMode: (m: WorkspaceSearchMode) => void;
  toggleCase: () => void;
  toggleRegex: () => void;
  toggleWholeWord: () => void;
  setCollectionId: (id: string | null) => void;
  toggleExpanded: (nodeId: string) => void;
  beginSearch: () => void;
  resolveResults: (r: WorkspaceSearchResults) => void;
  failSearch: (message: string) => void;
  reset: () => void;
}
export const useWorkspaceSearchStore = create<WorkspaceSearchState>((set) => ({ /* … */ }));
```
Store rules to implement: `setMode`/`setCollectionId`/toggles clear `results` + set `status: 'idle'` (stale results must never survive a corpus/mode change); `resolveResults` sets `status: 'results'` and default-expands every file node id (`expandedIds` = file node ids); `failSearch` sets `status: 'error'` + `error`.

- [ ] **Step 1: Scaffold.** Copy the four config files from `packages/context-actions`, rename to `@brainstrike/workspace-search`, deps: `@brainstrike/db`, `@brainstrike/ui`, `@brainstrike/utils`, `@brainstrike/types`, `@brainstrike/file-explorer-ui`, `@brainstrike/file-explorer`, `@brainstrike/vector-management`, `@brainstrike/preferences`, `zustand` (workspace:\* / versions matching other packages); peer `react ^19.2.4`. Run `pnpm install` at repo root to link.

- [ ] **Step 2: Write the failing store tests** — cover: toggling mode clears results and resets status; `resolveResults` populates results + expands all file ids; `failSearch` surfaces message; `toggleExpanded` flips membership. (Direct store usage: `useWorkspaceSearchStore.getState()` — no rendering needed.)

Run: `cd packages/workspace-search && pnpm vitest run` → FAIL (module missing).

- [ ] **Step 3: Implement model + store** per the interfaces above (the model file is types-only).

- [ ] **Step 4: Verify** — `pnpm vitest run && pnpm type-check` → PASS.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix && git add packages/workspace-search pnpm-lock.yaml
git commit -m "feat(workspace-search): package scaffold, result model, session store

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: workspace-search — executor, Text mode

**Files:**
- Create: `packages/workspace-search/src/core/workspace-search-executor.ts`
- Test: `packages/workspace-search/src/core/__tests__/workspace-search-executor.test.ts`

**Interfaces:**
- Consumes: `GrepSearchService` (Task 1), result model (Task 5).
- Produces:
```ts
export interface WorkspaceSearchExecutorDeps {
  grepService: Pick<GrepSearchService, 'search'>;
  hybridService: Pick<HybridSearchService, 'search'>; // used in Task 7
  /** fileRecordId → { path, rootId, rootName } resolution for semantic grouping (Task 7). */
  resolveFiles: (fileRecordIds: readonly string[]) => Promise<ReadonlyMap<string, { path: string; dbRootId: string | null; rootDisplayName: string | null }>>;
  embedQuery: (embeddingSetId: string, text: string) => Promise<number[]>; // Task 7
}
export interface TextSearchRequest {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  embeddingSetId: string;
  rootIds: readonly string[];
  maxResults?: number;
}
export class WorkspaceSearchExecutor {
  constructor(deps: WorkspaceSearchExecutorDeps);
  /** Rejects with the underlying error; resolves null if superseded by a newer request. */
  searchText(req: TextSearchRequest): Promise<WorkspaceSearchResults | null>;
}
export function escapeRegExpLiteral(s: string): string;
export function buildGrepPattern(req: Pick<TextSearchRequest, 'query' | 'isRegex' | 'wholeWord'>): { pattern: string; isRegex: boolean };
```

- [ ] **Step 1: Write the failing tests** (fake grepService):

```ts
const grepMatch = {
  after: [], before: ['ctx'], chunkEndLine: 14, chunkId: 'c1', chunkStartLine: 10,
  line: 12, lineText: 'const needle = 1;', path: 'src/a.ts', rootId: 'r1', rootName: 'Alpha',
};

it('groups matches by (rootId, path) preserving service order', async () => {
  const grepService = { search: vi.fn().mockResolvedValue({
    candidatesTruncated: false, matches: [grepMatch, { ...grepMatch, line: 13 },
      { ...grepMatch, path: 'src/b.ts', chunkId: 'c2' }],
    scanLimited: false, skippedMissingLineMetadata: 0, totalMatches: 3, truncated: false,
  }) };
  const executor = new WorkspaceSearchExecutor({ grepService, ...stubRest });
  const results = await executor.searchText(baseReq);
  expect(results?.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  expect(results?.files[0]?.children).toHaveLength(2);
  expect(results?.files[0]?.children[0]).toMatchObject({ kind: 'match', chunkId: 'c1', line: 12 });
});

it('wholeWord wraps a literal in \\b after escaping', () => {
  expect(buildGrepPattern({ query: 'a.b', isRegex: false, wholeWord: true }))
    .toEqual({ pattern: '\\ba\\.b\\b', isRegex: true });
});

it('wholeWord wraps a regex without escaping', () => {
  expect(buildGrepPattern({ query: 'foo|bar', isRegex: true, wholeWord: true }))
    .toEqual({ pattern: '\\b(?:foo|bar)\\b', isRegex: true });
});

it('a superseded request resolves null and its results are discarded', async () => {
  let resolveFirst!: (v: unknown) => void;
  const grepService = { search: vi.fn()
    .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
    .mockResolvedValueOnce(emptyGrepResult) };
  const executor = new WorkspaceSearchExecutor({ grepService, ...stubRest });
  const first = executor.searchText(baseReq);
  const second = executor.searchText({ ...baseReq, query: 'newer' });
  resolveFirst({ ...emptyGrepResult, matches: [grepMatch], totalMatches: 1 });
  await expect(first).resolves.toBeNull();
  await expect(second).resolves.toMatchObject({ totalMatches: 0 });
});

it('propagates notices (scanLimited/truncated) verbatim', async () => { /* assert notices object */ });

it('matches with no chunk metadata are dropped and counted', async () => {
  // grep result whose match lacks chunkId → excluded from children,
  // notices.skippedMissingLineMetadata incremented (checkbox needs a chunk).
});
```

Run: `cd packages/workspace-search && pnpm vitest run core` → FAIL.

- [ ] **Step 2: Implement.**
- `escapeRegExpLiteral`: standard `s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`.
- `buildGrepPattern`: literal+wholeWord → `\b${escaped}\b` as regex; regex+wholeWord → `\b(?:${source})\b`; otherwise pass-through.
- `searchText`: bump an internal `requestSeq`; call `grepService.search({ pattern, isRegex, caseSensitive, embeddingSetId, rootIds, maxResults: req.maxResults ?? 200, contextLines: 1 })`; if a newer seq started since, return null; group matches into `WorkspaceSearchFileResult[]` keyed `${rootId} ${path}` (Map preserves first-seen order; service output is already root/path/line sorted); matches missing `chunkId`/`chunkStartLine`/`chunkEndLine` are skipped with `notices.skippedMissingLineMetadata += 1`; every child gets `provenance: 'index'`.

- [ ] **Step 3: Verify** — `pnpm vitest run && pnpm type-check` → PASS.

- [ ] **Step 4: Commit**

```bash
pnpm dlx ultracite fix && git add packages/workspace-search
git commit -m "feat(workspace-search): text-mode executor with grouping, whole-word, staleness

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: workspace-search — executor, Semantic mode

**Files:**
- Modify: `packages/workspace-search/src/core/workspace-search-executor.ts`
- Test: extend `packages/workspace-search/src/core/__tests__/workspace-search-executor.test.ts`

**Interfaces:**
- Consumes: `HybridSearchService.search` (Task 3 `rootIds`), `deps.embedQuery`, `deps.resolveFiles`.
- Produces:
```ts
export interface SemanticSearchRequest {
  query: string;
  embeddingSetId: string;
  rootIds: readonly string[];
  limit?: number; // default 50
}
// on WorkspaceSearchExecutor:
searchSemantic(req: SemanticSearchRequest): Promise<WorkspaceSearchResults | null>;
```

- [ ] **Step 1: Write the failing tests**:
  - calls `embedQuery(setId, query)` then `hybridService.search(query, embedding, { embeddingSetId, rootIds, includeHeadline: true, limit, vectorLimit/ftsLimit: max(50, limit) })` — assert options;
  - groups chunk hits by `fileRecordId`, files ordered by best (max) normalized score, children by score desc; chunk hits missing `startLine`/`endLine` counted in `skippedMissingLineMetadata` and dropped;
  - a file whose `resolveFiles` entry has `dbRootId: null` (legacy NULL-root) is EXCLUDED entirely (workspace-only rule) — assert it doesn't appear;
  - staleness: same superseded→null contract as text mode (shared seq — a text search supersedes a semantic one and vice versa);
  - `embedQuery` rejection propagates (no catch/swallow).

Run: `pnpm vitest run core` → new tests FAIL.

- [ ] **Step 2: Implement.** Normalize scores with `normalizeRRFScores` from `@brainstrike/db` exactly as `use-semantic-search-executor.ts` does (map ids → normalized `rrfScore`). Build children as `kind: 'chunk'` with `headline: result.headline ?? null`, `score` = normalized rrfScore, `content: result.chunk.content`, `tokenCount: result.chunk.tokenCount`. Resolve paths via one `deps.resolveFiles(uniqueFileRecordIds)` call.

- [ ] **Step 3: Verify** — `pnpm vitest run && pnpm type-check` → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/workspace-search && git commit -m "feat(workspace-search): semantic-mode executor (hybrid RRF, workspace-scoped)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: workspace-search — selection bridge (range math + store wiring)

The highest-risk logic in the feature. Pure functions first, hook second.

**Files:**
- Create: `packages/workspace-search/src/bridge/range-math.ts`
- Create: `packages/workspace-search/src/bridge/use-search-selection-bridge.ts`
- Test: `packages/workspace-search/src/bridge/__tests__/range-math.test.ts`
- Test: `packages/workspace-search/src/bridge/__tests__/use-search-selection-bridge.test.tsx`

**Interfaces:**
- Consumes: `TapestryRange` (`@brainstrike/file-explorer-ui` — endLine EXCLUSIVE), `useWorkspaceContextCurationStore` (`@brainstrike/file-explorer-ui/preview`), the file-explorer selection store via `useFileExplorerStoreSelector` (`@brainstrike/file-explorer-ui/shell`), `encodeFileSelection` (`@brainstrike/utils/selection-utils`), chunk bounds INCLUSIVE from the result model.
- Produces:
```ts
// range-math.ts — all pure; tapestry ranges are [startLine, endLine) EXCLUSIVE
export interface ChunkBounds { startLine: number; endLine: number } // INCLUSIVE
export function toTapestrySpan(chunk: ChunkBounds): { startLine: number; endLine: number }; // endLine+1
export function addChunkRange(existing: readonly TapestryRange[], chunk: ChunkBounds, makeId: () => string): TapestryRange[]; // insert + coalesce overlapping/adjacent ACTIVE ranges; userModified ranges are never merged INTO (kept verbatim)
export function removeChunkRange(existing: readonly TapestryRange[], chunk: ChunkBounds): TapestryRange[]; // remove/trim non-userModified active ranges within the chunk span; userModified untouched
export type CoverageState = 'checked' | 'unchecked' | 'indeterminate';
export function chunkCoverage(fileSelected: boolean, ranges: readonly TapestryRange[] | undefined, chunk: ChunkBounds): CoverageState;
export function fileCoverage(fileSelected: boolean, childStates: readonly CoverageState[]): CoverageState;

// use-search-selection-bridge.ts
export interface SearchSelectionBridge {
  isFileChecked: (compositeKey: string) => boolean;
  chunkState: (compositeKey: string, chunk: ChunkBounds) => CoverageState;
  toggleFile: (compositeKey: string, nextChecked: boolean) => void;
  toggleChunk: (compositeKey: string, chunk: ChunkBounds, nextChecked: boolean) => void;
}
export function useSearchSelectionBridge(): SearchSelectionBridge;
```

- [ ] **Step 1: Write the failing range-math tests** — the exhaustive set:

```ts
// toTapestrySpan: {10,14} → {10,15}
// addChunkRange: empty → one active range; overlapping active ranges coalesce
//   ([10,15) + chunk {13,20} → [10,21)); adjacent ranges ([10,15) + {15,18} → [10,19));
//   disjoint stay separate and sorted; a userModified range overlapping the chunk
//   is preserved verbatim and the new range still covers the chunk minus nothing
//   (add alongside; never mutate or absorb userModified).
// removeChunkRange: exact-covering non-userModified range removed; a wider range
//   [5,30) minus chunk {10,14} → trimmed to [5,10) + [15,30); userModified ranges
//   never removed or trimmed; inactive ranges untouched.
// chunkCoverage: file unselected → 'unchecked'; file selected + NO ranges for key
//   → 'checked' (whole-file); fully covered by active ranges → 'checked';
//   partial overlap → 'indeterminate'; no overlap (but other ranges exist) → 'unchecked'.
// fileCoverage: file unselected → 'unchecked'; all children checked → 'checked';
//   mixed → 'indeterminate'; file selected with zero children → 'checked'.
```
Write each as a concrete `expect` (≈15 cases). Run `pnpm vitest run bridge` → FAIL.

- [ ] **Step 2: Implement `range-math.ts`** until green. Coalescing: sort by startLine; merge `[a,b) [c,d)` when `c <= b`; only merge active, non-userModified ranges; new ranges get `color` from the first `TAPESTRY_COLORS` entry (`@brainstrike/types` `tapestry-colors.ts` — check the actual export name and pick deterministically, e.g. index by range count), `isActive: true`.

- [ ] **Step 3: Write the failing bridge-hook tests.** Render the hook inside the file-explorer store provider test harness (`packages/file-explorer-ui` exposes test utilities used by `file-explorer-panel.test.tsx` — reuse its provider wrapper). Cases:
  - `toggleFile(key, true)` adds the compositeKey to the selection store; `toggleFile(key, false)` removes it AND clears that key's ranges in the curation store;
  - `toggleChunk(key, chunk, true)` on an unselected file selects the file and writes the coalesced range via `setTapestryRangesForKey`;
  - `toggleChunk(key, chunk, false)` removes only the covered non-userModified ranges; a `userModified: true` range survives;
  - `chunkState` reflects the two stores live (subscribe → toggle in store → state updates).

- [ ] **Step 4: Implement the hook.** File membership: read `selectedFilePaths` and the add/remove actions via `useFileExplorerStoreSelector`; use the same actions the explorer checkboxes use (`addMultipleSelectedFiles` / the corresponding remove action — find the exact remove action name in `packages/file-explorer/src/actions/file-selection-actions.ts` and use it; do NOT hand-roll Set mutation). Ranges: `useWorkspaceContextCurationStore` `tapestryRangesByKey` + `setTapestryRangesForKey`. Run tests → PASS.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix && git add packages/workspace-search
git commit -m "feat(workspace-search): selection bridge — range math + explorer/tapestry store wiring

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: workspace-search — panel controls (input bar, mode toggle, picker, coverage banner)

**Files:**
- Create: `packages/workspace-search/src/panel/search-input-bar.tsx`
- Create: `packages/workspace-search/src/panel/search-mode-toggle.tsx`
- Create: `packages/workspace-search/src/panel/search-collection-picker.tsx`
- Create: `packages/workspace-search/src/panel/search-coverage-banner.tsx`
- Test: `packages/workspace-search/src/panel/__tests__/search-controls.test.tsx`

**Interfaces:**
- Consumes: `useWorkspaceSearchStore` (Task 5); `@brainstrike/ui` primitives (`Input`, `Button`, `Tooltip`, `cn`); `usePGliteLiveQuery` + `makeLiveQueryKey` (`@brainstrike/db`).
- Produces: `SearchInputBar` (props: `{ onSubmit: () => void }`), `SearchModeToggle` (no props — store-driven), `SearchCollectionPicker` (props: `{ onCollectionChange?: (id: string) => void }`), `SearchCoverageBanner` (props: `{ collectionId: string | null; rootIds: readonly string[] }`).

- [ ] **Step 1: Write the failing component tests** (testing-library, role-based queries):
  - Input bar: renders three toggle buttons `aria-label="Match case"`, `"Use regular expression"`, `"Match whole word"` with `aria-pressed` reflecting store state; typing updates `query`; when `isRegex` and the pattern is invalid (`new RegExp` throws), shows `role="alert"` with the parser message and `onSubmit` is NOT called on Enter; in semantic mode shows the "Press Enter to search" hint and Enter calls `onSubmit`.
  - Mode toggle: two buttons (`Text` / `Semantic`), switching calls `setMode` (results cleared — assert store).
  - Picker: with a mocked `usePGliteLiveQuery` returning ONE set (the workspace index) renders quiet text `Workspace Index` and NO combobox; with two sets renders a select whose options carry the set names and a `Managed` badge on the `system_role='workspace-index'` row; choosing calls `setCollectionId`.
  - Banner: pending>0 → renders `Indexing…` + counts; complete (pending 0, files>0) → renders nothing; partial → renders "N of M files indexed".

Run: `cd packages/workspace-search && pnpm vitest run panel` → FAIL.

- [ ] **Step 2: Implement the components.**
- `SearchInputBar`: `Input` + three icon `Button`s (VS Code order: case `Aa` / word `ab` underline / regex `.*` — use `CaseSensitive`, `WholeWord`, `Regex` from `lucide-react`, they exist). Regex validation on change when `isRegex`: `try { new RegExp(query) } catch (e) { setLocalError(message) }` — local component state, `role="alert"` beneath the input.
- `SearchModeToggle`: two-button segmented control writing `setMode`.
- `SearchCollectionPicker`: BEFORE writing, open `packages/vector-management/src/collection-select/collection-select.tsx` and copy its live-query SQL (embedding_sets JOIN collection_indexing_stats, ~line 86) verbatim into this component's `usePGliteLiveQuery` call — do not invent column names. One-set case renders `<span>` with the set name; multi-set renders the repo's select primitive (check `@brainstrike/ui` for the Select component used by collection-select and reuse it).
- `SearchCoverageBanner`: reuse the same stats row for the SELECTED set: `files_*`/`chunks_*`/`embedded_*`/`pending_*` counts as named in that SQL. Three states as tested. Total-workspace-files denominator: one `usePGliteLiveQuery` over `SELECT COUNT(*)::int AS total FROM file_records WHERE root_id = ANY($1::text[])` keyed by `rootIds`.

- [ ] **Step 3: Verify** — `pnpm vitest run && pnpm type-check` → PASS.

- [ ] **Step 4: Commit**

```bash
pnpm dlx ultracite fix && git add packages/workspace-search
git commit -m "feat(workspace-search): panel controls — input bar, mode toggle, picker, coverage banner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: workspace-search — results tree + panel assembly

**Files:**
- Create: `packages/workspace-search/src/panel/search-results-tree.tsx`
- Create: `packages/workspace-search/src/panel/build-tree-nodes.ts`
- Create: `packages/workspace-search/src/panel/workspace-search-panel.tsx`
- Test: `packages/workspace-search/src/panel/__tests__/build-tree-nodes.test.ts`
- Test: `packages/workspace-search/src/panel/__tests__/search-results-tree.test.tsx`

**Interfaces:**
- Consumes: `TreeTable`, `TreeNode<T>` (`@brainstrike/ui`), results model, bridge (Task 8), store.
- Produces:
```ts
// build-tree-nodes.ts (pure)
export type SearchNodeData =
  | { kind: 'file'; file: WorkspaceSearchFileResult; compositeKey: string | null }
  | { kind: 'child'; child: WorkspaceSearchChild; compositeKey: string | null; filePath: string };
export function buildSearchTreeNodes(args: {
  results: WorkspaceSearchResults;
  expandedIds: ReadonlySet<string>;
  /** DB rootId → adapter rootId; null = unmounted (file rendered non-actionable is WRONG — it must be omitted). */
  resolveAdapterRootId: (dbRootId: string) => string | null;
}): TreeNode<SearchNodeData>[]; // PRE-FLATTENED visible rows (respects expandedIds), file id = `f:${dbRootId}:${path}`, child id = `m:${chunkId}:${line?}`

// search-results-tree.tsx
export interface SearchResultsTreeProps {
  onOpenFile: (compositeKey: string, line?: number) => void;
}
export function SearchResultsTree(props: SearchResultsTreeProps): React.ReactNode;

// workspace-search-panel.tsx — the tab content
export interface WorkspaceSearchPanelProps {
  onOpenFile: (compositeKey: string, line?: number) => void;
  /** DB root ids of currently mounted, live workspace roots (query scope). */
  workspaceDbRootIds: readonly string[];
  resolveAdapterRootId: (dbRootId: string) => string | null;
  runTextSearch: () => void;      // wired by app-shell to the executor hook
  runSemanticSearch: () => void;
}
export function WorkspaceSearchPanel(props: WorkspaceSearchPanelProps): React.ReactNode;
```
(Executor instantiation needs repos/embedder hooks that live most naturally at the composition layer — Task 11 builds a `useWorkspaceSearchController` there and passes run callbacks down. The panel itself stays presentation + store.)

- [ ] **Step 1: Write the failing `buildSearchTreeNodes` tests** — files whose `resolveAdapterRootId` returns null are omitted entirely (workspace-only + quick-open precedent); expanded file emits its children as depth-1 rows; collapsed file emits only itself with `hasChildren: true`, `childCount`; ids stable as specified.

- [ ] **Step 2: Implement `build-tree-nodes.ts`**; run → PASS.

- [ ] **Step 3: Write the failing tree component tests**:
  - renders `TreeTable` with `windowingStrategy="auto"`, `autoWindowingContext="search"`, `nodesArePreFlattened`, `showCheckbox`, `ariaRole="treegrid"` (assert via role + rows);
  - file row shows path + match count + root badge only when >1 distinct root among results;
  - text-match row highlights the match substring in `<mark>`; chunk row renders headline html-as-text (dangerously set ONLY for `ts_headline`'s `<mark>` output — sanitize by splitting on the literal `<mark>`/`</mark>` tokens instead of `dangerouslySetInnerHTML`; write the splitter as a tiny pure function with a test: input `'a <mark>b</mark> c'` → `['a ', {mark:'b'}, ' c']`);
  - row click (not checkbox) calls `onOpenFile(compositeKey, line)` — chunk rows pass their `startLine`;
  - checkbox toggle calls the bridge (`toggleFile`/`toggleChunk`) — mock `useSearchSelectionBridge`;
  - notices render: `scanLimited` → "Broad pattern — results limited"; `truncated` → a "Show more" row; `skippedMissingLineMetadata > 0` → "N results need a rebuilt index".

- [ ] **Step 4: Implement `search-results-tree.tsx` + `workspace-search-panel.tsx`.** Panel layout (top→bottom): `SearchModeToggle` + `SearchCollectionPicker` row, `SearchInputBar` (onSubmit = mode-appropriate run callback), `SearchCoverageBanner`, results area (empty-state / error card with Retry / tree), footer with `~N tokens selected` from `useWorkspaceContextCurationStore((s) => s.contextSnapshot?.selectedSourceApproxTokens)` and the "Ranges apply in Tapestry ranges mode" note when any chunk-level ranges exist. Text-mode debounce lives here: `useEffect` on `[query, caseSensitive, isRegex, wholeWord, collectionId]` with a 250 ms timer calling `runTextSearch()` when `mode === 'text' && query.trim().length >= 3` (cleared on change/unmount); semantic runs only from `onSubmit`.

- [ ] **Step 5: Verify + commit**

```bash
cd packages/workspace-search && pnpm vitest run && pnpm type-check && cd ../.. && pnpm dlx ultracite fix
git add packages/workspace-search && git commit -m "feat(workspace-search): results tree and panel assembly

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: app-shell composition — tabs, controller, navigation, layout-store bump

**Files:**
- Create: `packages/app-shell/src/explorer-search-tabs.tsx`
- Create: `packages/app-shell/src/use-workspace-search-controller.ts`
- Modify: `packages/app-shell/src/root-layout-content.tsx` (~line 268: `contextExplorerPanelContent ?? <FileExplorerPanel />` → `contextExplorerPanelContent ?? <ExplorerSearchTabs />`)
- Modify: `packages/preferences/src/stores/context-explorer-layout-store.ts` (add `explorerActiveTab`, bump `STORE_VERSION` 2→3)
- Modify: `packages/app-shell/package.json` (dep on `@brainstrike/workspace-search`)
- Test: `packages/app-shell/src/__tests__/explorer-search-tabs.test.tsx`
- Test: extend `packages/preferences` store tests for the v3 migration

**Interfaces:**
- Consumes: `WorkspaceSearchPanel` (Task 10), `FileExplorerPanel`, `useIdeFileEditor().openFileInTab` (see `quick-open-host.tsx:56` for the canonical usage), `useOptionalRootIdentity` + `useRootsReconciliation`'s `dbRootIdByAdapterRootId` (invert for scope: the mounted roots' DB ids are `[...dbRootIdByAdapterRootId.values()]`), `useFileChunkRepository`/`useFileRecordRepository` (`@brainstrike/db`), `useSearchEmbedder` (Task 4), `createGrepSearchService`/`createHybridSearchService` (`@brainstrike/db`), `useWorkspaceSearchStore`.
- Produces: `ExplorerSearchTabs` — tab strip (`role="tablist"`, buttons `Explorer`/`Search`) + `aria-hidden` show/hide of both panels (keep Explorer MOUNTED when Search is active — the mountedTabs pattern from `RootLayoutContent`; unmounting would drop file-tree state). Search panel wrapped in `React.lazy` + `Suspense`.

- [ ] **Step 1: Preferences store first (RED/GREEN).** Test: persisted v2 state migrates to v3 with `explorerActiveTab: 'explorer'`; setter works; partialize includes it. Implement: add field + `setExplorerActiveTab` action, extend `PersistedContextExplorerLayoutState`, add `if (version < 3)` branch in `migrate`, bump `STORE_VERSION` to 3.

- [ ] **Step 2: Controller hook.** `useWorkspaceSearchController()` returns `{ runTextSearch, runSemanticSearch, workspaceDbRootIds, resolveAdapterRootId, onOpenFile }`:
  - builds the executor once (`useMemo`) from `createGrepSearchService(chunkRepository)`, `createHybridSearchService(chunkRepository)`, `resolveFiles` = batched `fileRepository.findById` mapping to `{ path, dbRootId: record.rootId ?? null, rootDisplayName }` (mirror `buildFileRecordsMap` in `use-semantic-search-executor.ts`; confirm the `FileRecord` model exposes `rootId` — it is a `file_records` column; if the mapper omits it, extend the mapper in `packages/db` with a test),
  - `embedQuery(setId, text)`: resolve model info with the same SQL as `use-semantic-search-executor.ts`'s `getEmbeddingSetModelInfo` (SELECT model_key, dimensions FROM embedding_sets WHERE id=$1) then `embedQueryWithRecovery`,
  - `runTextSearch`/`runSemanticSearch`: read the store, resolve `collectionId ?? workspace-index set id` (SELECT id FROM embedding_sets WHERE system_role='workspace-index' — via a small live query or one-shot), call the executor, `beginSearch()`/`resolveResults()`/`failSearch(message)`; a `null` (superseded) result is a no-op,
  - `onOpenFile(compositeKey, line)`: `openFileInTab(compositeKey)` exactly as `quick-open-host.tsx` does; the `line` parameter is accepted and forwarded IF `openFileInTab` supports an options argument — read `useIdeFileEditor`'s definition in `packages/ui/src/layout/ide-layout.tsx` first; if it takes only the key, open without the line and add `// TODO(#follow-up): line-targeted open` is FORBIDDEN by plan rules — instead file the gap in the PR description's Follow-Up section and pass only the key.
- Test with mocked repositories + store: `runTextSearch` populates store results; executor errors land in `failSearch` with the message; `workspaceDbRootIds` reflects the reconciliation map.

- [ ] **Step 3: `ExplorerSearchTabs`.** Tests: both tabs render; Explorer visible by default (`explorerActiveTab` from layout store); switching tabs flips `aria-hidden` and persists via the store; Explorer stays mounted while hidden (assert its testid still in DOM); Search content lazy-mounts on first activation only. Implement per the mounted-tabs pattern in `root-layout-content.tsx`. Wire `<WorkspaceSearchPanel {...controller} />`.

- [ ] **Step 4: Swap the mount point** in `root-layout-content.tsx:268` and run the app-shell suite: `cd packages/app-shell && pnpm test && pnpm type-check` — the existing `root-layout-content.test.tsx` is the regression net.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix
git add packages/app-shell packages/preferences packages/workspace-search pnpm-lock.yaml
git commit -m "feat(app-shell): Explorer|Search tab strip, search controller, layout-store v3

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: E2E smokes + full verification sweep

**Files:**
- Create: one web smoke spec (locate the existing web smoke directory first: `ls apps/web/e2e 2>/dev/null || find apps/web -name "*.spec.ts" -o -name "*.test.ts" | grep -i e2e | head`; place beside its peers, matching their naming + fixture conventions)
- Create: `apps/desktop/e2e/workspace-search.desktop.test.ts` (mirror the harness of `apps/desktop/e2e/file-explorer-selection.desktop.test.ts`)

- [ ] **Step 1: Web smoke.** Using the repo's existing seeded-workspace fixture pattern (see how the file-explorer web smoke seeds a root + indexed content — reuse its helpers verbatim): open the app → click `role=tab[name="Search"]` → type a term known to exist in the fixture → assert a `role=treegrid` result row appears with the file path → click the row's checkbox → switch to the Explorer/preview surface and assert the file shows as selected (reuse the selection assertions from the existing selection smoke). Selectors: role/text/data-testid only.

- [ ] **Step 2: Desktop smoke.** Same flow through the desktop harness. Run per that suite's documented invocation (see the script that runs `*.desktop.test.ts`; desktop E2E can be flaky headless — diagnose, don't bypass).

- [ ] **Step 3: Full verification sweep (exit bar — all in one run):**

```bash
pnpm dlx ultracite check
pnpm -r type-check
pnpm -r --filter '!./apps/*' test        # package unit suites
pnpm build                                # workspace build (allowed here: exit bar requires it)
cd packages/db && node scripts/test-lanes.mjs check && node scripts/coverage-lanes.mjs check
```
Expected: everything green in the same run. Fix and re-run until it is.

- [ ] **Step 4: Commit + wrap up**

```bash
git add apps && git commit -m "test(e2e): workspace search web + desktop smokes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Then follow superpowers:finishing-a-development-branch (PR against `main` from `feature/workspace-search`). PR body must include the AGENTS.md post-task summary (Files Changed / What Was Modified / Files Intentionally Not Touched / Follow-Up Needed — the Follow-Up list at minimum: desktop live-grep dual pass, line-targeted `openFileInTab` if not supported, foreground-gate coordination for visible-renderer query embeddings, include/exclude glob filters).

---

## Plan Self-Review (performed at write time)

- **Spec coverage:** §1 decisions → Tasks 6/7 (modes), 9 (picker/banner/gating), 10 (tree/affordances/notices), 11 (placement/persistence), 8 (bridge), 12 (tests). §8 out-of-scope items are absent from tasks and listed as PR follow-ups. Gap check: "semantic gating disabled-with-reason" is asserted in Task 9 tests via the banner/toggle states — the key-missing detection reuses `useSearchEmbedder` throw causes surfaced by the error card (Task 10) rather than pre-emptive gating; this is a deliberate simplification: the reason still surfaces, nothing is silent.
- **Placeholder scan:** no TBDs; the two read-before-write steps (collection-select SQL, `openFileInTab` signature) name the exact file to copy from and the decision rule for each outcome.
- **Type consistency:** `rootIds?: readonly string[]` everywhere; `GrepCandidate.chunkId/endLine` (Task 1) feed `GrepMatch.chunkId/chunkStartLine/chunkEndLine` (Task 1) feed `WorkspaceSearchTextMatch` (Task 5) feed `ChunkBounds` (Task 8, inclusive→exclusive conversion in `toTapestrySpan`). `SearchEmbedder`/`EmbeddingSetModelInfo` (Task 4) consumed in Task 11's `embedQuery`.
