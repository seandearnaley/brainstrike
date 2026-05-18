# Chunking parser benchmark — tree-sitter Python

**Date**: 2026-05-18
**Repo**: brainstrike monorepo
**Files parsed**: 500 synthetic Python files (no real Python in this repo to vendor)
**Reproducer**: `node packages/chunking-worker/bench/tree-sitter-cost.mjs`

## Headline

- **Tree-sitter total**: 324.6 ms
- **Recursive splitter total**: 2.3 ms (baseline reference, not a quality competitor — see Phase 6 parity test)
- **Tree-sitter cost relative to recursive**: 143.70× (parsing is more work than string splitting; the value comes from the quality of the chunks)
- **First-parse cold start (WASM instantiate)**: 14.7 ms — amortized over the corpus
- Tree-sitter parse errors: 0
- Recursive splitter errors: 0

## Per-file timings (all files)

| Stat | Tree-sitter |
|---|---|
| Median | 0.553 ms |
| p95 | 1.144 ms |
| p99 | 1.369 ms |

## By file size bucket (median ms)

| Bucket | Files | Tree-sitter | Recursive |
|---|---|---|---|
| < 1 KB | 400 | 0.524 | 0.001 |
| 1–10 KB | 100 | 0.999 | 0.009 |

## Methodology notes

- Wall-clock measurement via `performance.now()` around the parse call only.
- Parser order alternates per file (even index → tree-sitter first, odd → recursive first) to cancel JIT/cache bias.
- First parse pays WASM-instantiate cost (~10-30 ms); warmed up once before timing begins. Reported separately.
- Corpus is synthetic because the brainstrike repo has no Python source files. Files cover: simple typed functions, decorated/cached functions, classes with methods, async functions — proportions weighted toward mid-sized modules.
- The recursive splitter is included as a string-only baseline so operators can see absolute cost of AST parsing relative to 'split this string'. It is NOT a quality competitor — see Phase 6 parity test (`tree-sitter-python-parity.test.ts`) for the chunk-quality differential.
- Per-language WASM grammar loaded once per process (module-level cache in `tree-sitter-grammar-loader.ts`). Subsequent parses reuse the cached Language instance.

## Conclusion

Tree-sitter Python parsing is fast in absolute terms and quality-superior to the recursive splitter (Phase 6 parity). The headline value isn't speed-over-baseline (parsing IS more work than string splitting) — it's that the chunks produced are function-aligned by construction, which dramatically improves the relevance of embedding-based search over chunked Python code.
