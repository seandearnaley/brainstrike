# Chunking parser benchmark — Babel vs oxc

**Date**: 2026-05-17
**Repo**: brainstrike monorepo (this checkout)
**Files parsed**: 2094 of 2094 JS/TS source files
**Reproducer**: `node packages/chunking-worker/bench/parse-cost.mjs`

## Headline

- **Babel total**: 803 ms
- **oxc total**: 188 ms
- **Speedup**: **4.3×** (oxc faster than babel)
- Babel parse errors: 0
- oxc parse errors: 0

## Per-file timings (all files)

| Parser | Median (ms) | p99 (ms) |
|---|---|---|
| Babel | 0.20 | 2.23 |
| oxc | 0.06 | 0.47 |

## By file size bucket (median ms)

| Bucket | Files | Babel (med) | oxc (med) | Speedup |
|---|---|---|---|---|
| < 1 KB | 303 | 0.04 | 0.01 | 3.1× |
| 1–10 KB | 1299 | 0.17 | 0.05 | 3.5× |
| 10–100 KB | 490 | 0.66 | 0.18 | 3.7× |
| > 100 KB | 2 | 16.60 | 2.03 | 8.2× |

## Methodology notes

- Wall-clock measurement via `performance.now()` around the parse call only.
- Includes the cost of Babel’s lazy module load (first-call penalty); 
  amortizes over thousands of subsequent files. oxc-parser’s NAPI bindings 
  load eagerly at module-resolution time so they don’t carry a first-call hit.
- **Parser order alternates per file** (even index → Babel first, odd → oxc
  first). Without alternation the parser that always ran second would benefit
  from a warm FS cache for the same content and the first-running parser would
  pay more JIT warm-up cost — both biases skew the headline ratio. Alternating
  cancels them over the corpus. Deterministic (index parity) for reproducibility.
- **Async vs sync asymmetry**: `babelAdapter.parse` is async (returns a Promise);
  `oxc-parser.parseSync` is synchronous. We `await` Babel and don't await oxc, so
  Babel's timing includes one extra microtask per call (~1–10 µs on V8). Negligible
  against the parse work itself; explicitly noted so reviewers can rule it out.
- Excludes IPC roundtrip cost (Phase 4 architecture) — measures the underlying 
  parser engines, not the Electron transport. IPC overhead is a separate concern 
  evaluated at integration time.
- No warm-up runs; first file pays cold-cache cost. With thousands of files this 
  rounds out, but small samples may show distorted percentiles.
- Parses use `errorRecovery: true` for both parsers so neither bails out on 
  malformed code (the chunking pipeline’s production posture). Note: oxc's
  errorRecovery semantics differ from Babel's — oxc *always* recovers and
  reports errors via `result.errors` rather than throwing (P2 #993). The error
  counts above are catch-counts, so an oxc soft-failure won't register; if the
  bench reports zero oxc errors but you suspect parse problems, inspect
  `result.errors` directly on a sample.

## Conclusion

oxc is **4.3×** faster than Babel — meaningful but below the 
PRD §1 target of >=5x. Worth investigating whether IPC overhead would erode this
further (Phase 8 monitoring).
