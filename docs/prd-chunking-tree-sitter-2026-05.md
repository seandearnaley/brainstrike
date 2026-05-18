# PRD: Multi-language AST chunking via tree-sitter (WASM)

**Status**: Draft — awaiting §13 approval
**Owner**: Sean Dearnaley
**Created**: 2026-05-17
**Target packages**: `@brainstrike/chunking-worker` (new `treeSitterAdapter`), `apps/web` + `apps/desktop` (asset bundling)
**Rollout posture**: Aggressive (mirror oxc playbook — see §8)
**Predecessor**: [PRD: Native Rust parser in chunking pipeline (oxc, hybrid)](./prd-chunking-wasm-parser-2026-05.md) — established the `ParserAdapter` facade this PRD extends.

---

## Revision history

| Date | Change | Driven by |
|---|---|---|
| 2026-05-17 v1 | Initial draft. Phase 1 = Python only. Bundle grammars as static assets. | Project owner direction; oxc retrospective |

---

## 1. Goal & non-goals

### 1.1 Goal

Extend the `ParserAdapter` facade introduced in #988 with a `treeSitterAdapter` that produces function-aligned chunks for **Python files** (`.py`, `.pyi`). This makes Python chunking qualitatively equivalent to what oxc/Babel already provides for JS/TS: a `splitCodeByFunctions` path that returns chunks bounded by real function/class boundaries rather than the dumb character-count splits of the recursive baseline.

**Phase 1 deliverable**: Python-only AST chunking, behind a feature flag, with measurable chunk-quality improvement over the recursive baseline.

### 1.2 Explicit non-goals (Phase 1)

- Rust, Go, Markdown, or any other language. Each adds a grammar bundle + chunk-extraction query; we ship them in follow-on PRDs once the architecture proves out on Python.
- Replacing oxc/Babel for JS/TS. Tree-sitter's JS/TS grammars exist but oxc is faster on the JS/TS path and already shipped.
- Incremental re-parsing on edit (tree-sitter's superpower). Phase 1 parses each file from scratch; the incremental-diff project is a separate PRD downstream.
- Changing the existing recursive splitter. It stays as the universal fallback for unsupported languages.

## 2. Why tree-sitter, why now

### 2.1 Why tree-sitter

- **Battle-tested WASM**: `web-tree-sitter` (≈25 KB JS runtime + grammar `.wasm` per language) powers VS Code, GitHub Code Search, Zed, and Neovim. The library handles parser instantiation, query execution, and grammar dynamic-loading.
- **Per-language grammar files** (~150–300 KB each, lazy-loaded) decouple bundle growth from language coverage.
- **Query language is portable**: S-expression patterns like `(function_definition name: (identifier) @name) @function` let us define "what counts as a function-like chunk" per language without hand-walking AST node types.
- **Direct fit for the facade**: `treeSitterAdapter` implements the same `ParserAdapter` contract as `babelAdapter` and `oxcIpcAdapter`. The dispatcher (`selectAdapter`) extends from "env → adapter" to "(env, filename) → adapter".

### 2.2 Why now

- The `ParserAdapter` facade just landed (PR #988). The cost of slotting a third adapter in is small and the architecture's value compounds.
- The oxc speedup was real but small in absolute terms (4.3×, 803→188 ms across 2094 files). The bigger win is the **qualitative** improvement for non-JS/TS files, which today get character-count splits with zero AST awareness.
- Phase 1 = Python only keeps the risk surface tiny while proving the architecture end-to-end (load WASM grammar → instantiate parser → extract chunks via query → integrate with chunking pipeline → measure quality).

## 3. Architecture

### 3.1 Adapter layout

```
packages/chunking-worker/src/parsers/
├── babel-adapter.ts          (existing, unchanged)
├── oxc-ipc-adapter.ts        (existing, unchanged)
├── tree-sitter-adapter.ts    (NEW)
├── tree-sitter-grammar-loader.ts  (NEW — lazy fetch + cache per language)
├── tree-sitter-queries/
│   └── python.scm            (NEW — function/class extraction query)
├── select-adapter.ts         (MODIFIED — takes filename, dispatches by extension)
├── environment.ts            (unchanged)
└── types.ts                  (MODIFIED — adapter contract extended if needed)
```

### 3.2 Dispatch flow (after Phase 1)

```
splitCodeByFunctions(content, { fileName, jsx })
        │
        ▼
selectAdapter(fileName)
        │
        ├── .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs ──► oxcIpcAdapter or babelAdapter (per env)
        ├── .py/.pyi ─────────────────────────────► treeSitterAdapter('python')
        └── (any other extension) ─────────────────► return null → caller falls back to recursiveChunker
```

`selectAdapter` returning `null` for unsupported extensions is the explicit "no AST help — use recursive splitting" signal. Today the caller already handles parser failures by falling back to recursive; `null` is the cleaner version of that path for languages we don't claim to support.

### 3.3 Grammar loading

- `tree-sitter-grammar-loader.ts` exposes `loadGrammar(language: 'python'): Promise<Parser.Language>`.
- Cached per-language so the WASM is parsed once per worker lifetime.
- Resolves grammar URL via Vite-friendly import: `new URL('./grammars/python.wasm', import.meta.url)`.
- The adapter's `parse()` is `async` (already supported by the contract — `babelAdapter.parse` is async); first call per language pays the WASM-instantiate cost (~10–30 ms), subsequent calls reuse the cached `Parser.Language`.

### 3.4 Chunk extraction

- `python.scm` defines what counts as a function-like top-level chunk:
  ```scheme
  (module
    (function_definition) @chunk)
  (module
    (decorated_definition) @chunk)
  (module
    (class_definition) @chunk)
  ```
- The adapter walks query matches, emits one chunk per match with `{ start, end, type, name }` matching the existing chunk shape from `portable-chunking.ts`.
- Classes are emitted as **single chunks** in Phase 1 (matches the existing oxc behavior of treating classes as units; per-method splitting is a Phase-N decision once the baseline is stable).

## 4. Phase 1 scope (Python)

### 4.1 In scope

- `treeSitterAdapter` implementation conforming to `ParserAdapter`
- Lazy grammar loader for `tree-sitter-python.wasm`
- `python.scm` query covering: `function_definition`, `decorated_definition`, `class_definition`
- `selectAdapter(fileName)` signature extension; routes `.py`/`.pyi` to tree-sitter
- Vite asset-bundling config in `apps/web` and `apps/desktop` so the grammar `.wasm` ships under `/assets/grammars/`
- Functional alignment metric implementation (§6) + tests
- Differential parity test: tree-sitter vs recursive on a Python fixture corpus, asserting alignment ratio uplift
- Bench script: measure parse cost on a Python corpus
- Feature flag: `__BRAINSTRIKE_TREE_SITTER_LANGUAGES__: 'python'[]` (defaults to `[]`; rollout PR sets it to `['python']`)
- Operator kill switch: `?treeSitterLanguages=` URL param overrides default (empty string disables)

### 4.2 Out of scope (deferred to follow-on PRDs)

- Languages other than Python
- Incremental re-parse on file edit
- Per-method chunking inside classes
- Treesitter for the recursive fallback inside oversized chunks
- Documentation extraction (docstrings as separate searchable units)

## 5. TDD rules

Carry forward the rules from the oxc PRD §5, including the §5.2 relaxation: RED commits remain test-first **where the stub state can be lint-clean**; when Biome rejects the stub state (e.g., `useReadonlyClassProperties` on an empty `#field`), consolidate RED+GREEN into one commit and rely on diff order to preserve the test-first principle.

### 5.1 Phase-to-PR mapping

| Phase | PR | RED commits | GREEN commits | Refactor commits |
|---|---|---|---|---|
| 1 (this PRD) | this PR | — | — | docs only |
| 2 (adapter) | PR-N+1 | `test: tree-sitter adapter contract` | `feat: tree-sitter adapter skeleton (returns empty)` | `chore: extract grammar URL resolution helper` |
| 3 (Python grammar) | PR-N+2 | `test: python function/class extraction` | `feat: load python.wasm + extract via query` | per-PR |
| 4 (asset bundling) | PR-N+3 | `test: grammar URL resolves under bundler` | `feat: vite copy plugin for grammars` | per-PR |
| 5 (selectAdapter routing) | PR-N+4 | `test: selectAdapter(.py) returns tree-sitter` | `feat: extend selectAdapter signature` | per-PR |
| 6 (parity) | PR-N+5 | `test: alignment ratio > baseline` | (already passing if 2–5 done correctly) | per-PR |
| 7 (bench) | PR-N+6 | — | `chore: bench script + report` | per-PR |
| 8 (rollout) | PR-N+7 | `test: flag-driven routing matrix` | `feat: default-enable python` | per-PR |

## 6. Functional alignment ratio

### 6.1 Definition

For a corpus of files, the **functional alignment ratio** is:

```
chunks_aligned_to_function_boundary / total_chunks_produced
```

where "aligned" means **both** of:
- the chunk's start byte falls on a `function_definition` / `class_definition` / `decorated_definition` opening byte, AND
- the chunk's end byte falls on the corresponding closing byte (or end-of-file for the last chunk)

### 6.2 Baseline (recursive splitter)

The recursive splitter chunks at character/token boundaries with no AST awareness. Expected alignment ratio on a Python corpus: **< 5%** (incidental alignment when a function happens to end near a chunk boundary).

### 6.3 Target (tree-sitter)

> **100%** by construction — every chunk the tree-sitter adapter emits comes from a query match on a function/class node, so both bounds are aligned by definition.

The interesting number is the **delta vs baseline** on the same corpus, which is the headline metric for the rollout PR.

### 6.4 Why this metric

- **Cheap to measure**: re-parse the file with tree-sitter, check each emitted chunk's bounds.
- **Cheap to fail**: if a refactor breaks the adapter's chunk extraction, the ratio drops, the parity test fails, CI catches it.
- **Honest**: doesn't claim downstream search quality without measuring it (separate Phase-N project). Measures the upstream invariant that downstream improvements would build on.

## 7. Grammar delivery

### 7.1 Bundle as static assets (chosen)

- Grammar `.wasm` files live under `packages/chunking-worker/grammars/` (vendored copy of the `tree-sitter-python` release artifact).
- A Vite plugin (`vite-plugin-static-copy`, already in use in `apps/web`) copies them to `/assets/grammars/` at build time.
- The adapter resolves URLs via `new URL('./grammars/python.wasm', import.meta.url)` so Vite tracks them as assets and produces correct hashed paths for production.
- Same `.wasm` bytes ship to both desktop and web (no fork).

### 7.2 What we considered and rejected

- **CDN (jsdelivr/unpkg)**: third-party uptime dependency; CORS/CSP work; offline desktop breaks.
- **Per-platform delivery** (desktop = on-disk, web = CDN): more complexity for marginal initial-bundle savings; lazy-loading means the cost is paid at first parse, not at boot.

### 7.3 Bundle size impact

- `tree-sitter-python.wasm`: ~250 KB unzipped, ~80 KB gzipped over wire.
- `web-tree-sitter` JS runtime: ~25 KB.
- Total Phase-1 impact: **~105 KB gzipped**, lazy-loaded on first Python parse. Zero impact on JS-only workflows.

## 8. Rollout posture

### 8.1 Aggressive (same as oxc)

- **Phases 2–7 land disabled by default.** The `treeSitterAdapter` exists in the codebase, the grammar ships in the build, but `selectAdapter(.py)` returns the existing `null` (→ recursive fallback) until Phase 8 flips the flag.
- **Phase 8 is the flip.** A single PR enables `python` in `__BRAINSTRIKE_TREE_SITTER_LANGUAGES__` defaults.
- **Kill switch**: `?treeSitterLanguages=` URL param. Operator can disable in the field without a redeploy. Mirrors `?parserFlag=babel` from PR #994.

### 8.2 Failure mode if tree-sitter mis-chunks

- The adapter contract throws on failure; the call site (`splitCodeByFunctions`) already catches and falls back to recursive splitting with a warn-level log (`AST parsing failed; falling back to recursive splitting`). Same failure mode as oxc errors today.
- **No per-file silent fallback wrapper.** Per the post-oxc retrospective (project owner direction, 2026-05-17): silent fallback hides bugs exactly when they matter most. Tree-sitter failures degrade loudly to recursive splitting with the same warn we use for oxc/Babel failures today.

## 9. Selector routing rules

### 9.1 `selectAdapter(filename: string | undefined): ParserAdapter | null`

```
fileName ends with .ts/.tsx/.mts/.cts            ──► oxcIpcAdapter (Electron) or babelAdapter (browser)
fileName ends with .js/.jsx/.mjs/.cjs            ──► oxcIpcAdapter (Electron) or babelAdapter (browser)
fileName ends with .py/.pyi AND
  globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ includes 'python'
                                                  ──► treeSitterAdapter('python')
fileName is undefined OR no match                ──► null
```

`null` is a deliberate "no AST help" return; the caller already handles it by calling the recursive splitter. The previous oxc PRD's `selectAdapter` never returned null because every supported call site was JS/TS; tree-sitter is the first adapter that wants to opt OUT for unsupported extensions.

### 9.2 Caller adaptation

`splitCodeByFunctions` in `portable-chunking.ts` (line ~727 today) already handles `parser.parse() throws → recursive fallback`. The new pre-check is: `if (selectAdapter(fileName) === null) return recursiveChunker.splitText(content)` BEFORE attempting AST parse. Saves the (now meaningless) attempt + catch round-trip for known-unsupported extensions.

## 10. Test strategy

### 10.1 Unit tests (per phase)

- `tree-sitter-adapter.test.ts` — contract conformance, lazy grammar loading, error propagation
- `tree-sitter-grammar-loader.test.ts` — URL resolution, per-language caching
- `select-adapter.test.ts` — extended routing matrix including `.py` with flag on/off
- `python.scm` extraction — fixture Python files, assert chunk bounds match query matches

### 10.2 Differential parity test (Phase 6)

- Corpus: 50–100 real Python files (vendor from a popular open-source Python project, e.g., `requests` or `flask`)
- Run both `treeSitterAdapter` and `recursiveChunker`
- Compute functional alignment ratio for each
- Assert: tree-sitter ratio > 0.90 (most chunks aligned; some tolerance for edge cases like trailing comments)
- Assert: recursive baseline ratio < 0.10 (sanity check that the metric discriminates)
- Assert: tree-sitter ratio > baseline ratio (the delta is the value)

### 10.3 Benchmark (Phase 7)

- `packages/chunking-worker/bench/tree-sitter-cost.mjs` — wall-clock parse + extract per file on the same corpus
- Headline: tree-sitter ms/file vs recursive ms/file (recursive is faster but produces unaligned chunks; the comparison is honesty, not a claim)
- Report at: `docs/bench-chunking-tree-sitter-2026-05.md`

## 11. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | `web-tree-sitter` WASM instantiation in a Web Worker context (chunking-worker is a Worker, not main thread) — Emscripten module loading has known quirks here | High | Phase 2 spike: prove instantiation in chunking-worker before building the adapter. If blocked, fall back to instantiating in the renderer and proxying via the existing IPC bridge (same pattern as oxc-ipc-adapter for Electron). |
| R2 | Vite asset-resolution for `.wasm` under `new URL(..., import.meta.url)` differs subtly between dev and prod builds | Medium | E2E test that loads the actual built artifact in CI; don't trust dev-server-only manual tests. |
| R3 | Python decorators wrap function bodies in `decorated_definition` nodes — naive query that only matches `function_definition` misses decorated functions entirely | Medium | Query explicitly includes `decorated_definition`. Parity test asserts decorated functions appear as chunks. |
| R4 | Bundle size growth as we add languages in follow-on PRDs (Rust + Go + Markdown ≈ 600 KB more) | Low | Lazy load per language; users only pay for languages they actually parse. Reassess if total exceeds 1.5 MB across all languages. |
| R5 | Tree-sitter query syntax errors silently match nothing | Low | Query validation: at module load, assert each query produces ≥1 match on a known-good fixture. Fail fast if a grammar update breaks the query. |
| R6 | Python grammar version skew (we ship N; grammar evolves to N+1) | Low | Pin grammar version in `package.json` + lockfile. Renovate/dependabot PRs trigger the differential parity suite. |

## 12. Open questions

1. **Vendor grammars into the repo or treat as npm deps?** `tree-sitter-python` is published on npm as an npm package containing the `.wasm` artifact. We can either depend on it via `pnpm add tree-sitter-python` and read the wasm out of `node_modules`, or vendor the `.wasm` into `packages/chunking-worker/grammars/` directly. Vendoring gives reproducibility + smaller dep graph; npm dep gives easier upgrades. **Phase 2 decision; default toward npm dep for upgrade ergonomics.**
2. **Class extraction granularity** — Phase 1 emits whole classes as single chunks. Some users may want per-method chunking for large classes. **Phase N decision; out of scope here.**

## 13. Approval

- [ ] Architecture (§3) reviewed
- [ ] Phase 1 scope (§4) approved
- [ ] Functional alignment metric (§6) accepted as the headline quality measure
- [ ] Static-asset grammar delivery (§7) approved
- [ ] Aggressive rollout (§8) acknowledged with the kill-switch contract
- [ ] Per-PRD stacked-PR + TDD playbook (§5) approved (mirror oxc PRD §5)

---

## Appendix A — Why tree-sitter and not (alternatives)

- **Hand-written Python parser in Rust → WASM**: weeks of work for one language; tree-sitter ships ~50 maintained grammars for ~free.
- **Pyodide**: 10+ MB WASM for a full Python runtime; we don't need to *execute* Python, just parse it.
- **ANTLR4 with a Python grammar**: heavyweight JS runtime, slower parse, less battle-tested in WASM than tree-sitter.
- **`@oxc-parser` for Python**: doesn't exist. oxc is JS/TS only.

Tree-sitter is the standard choice for multi-language source-code parsing in editor-class tooling. No serious alternative for our use case.
