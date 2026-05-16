# Chunking parser benchmark — Babel vs oxc

**Date**: 2026-05-16
**Repo**: brainstrike monorepo (this checkout)
**Files parsed**: 2094 of 2094 JS/TS source files
**Reproducer**: `node packages/chunking-worker/bench/parse-cost.mjs`

## Headline

- **Babel total**: 903 ms
- **oxc total**: 210 ms
- **Speedup**: **4.3×** (oxc faster than babel)
- Babel parse errors: 0
- oxc parse errors: 0

## Per-file timings (all files)

| Parser | Median (ms) | p99 (ms) |
|---|---|---|
| Babel | 0.24 | 2.63 |
| oxc | 0.07 | 0.55 |

## By file size bucket (median ms)

| Bucket | Files | Babel (med) | oxc (med) | Speedup |
|---|---|---|---|---|
| < 1 KB | 303 | 0.05 | 0.02 | 3.2× |
| 1–10 KB | 1300 | 0.21 | 0.06 | 3.7× |
| 10–100 KB | 489 | 0.76 | 0.20 | 3.7× |
| > 100 KB | 2 | 17.59 | 2.09 | 8.4× |

## Methodology notes

- Wall-clock measurement via `performance.now()` around the parse call only.
- Includes the cost of Babel’s lazy module load (first-call penalty); 
  amortizes over thousands of subsequent files. oxc-parser’s NAPI bindings 
  load eagerly at module-resolution time so they don’t carry a first-call hit.
- Excludes IPC roundtrip cost (Phase 4 architecture) — measures the underlying 
  parser engines, not the Electron transport. IPC overhead is a separate concern 
  evaluated at integration time.
- No warm-up runs; first file pays cold-cache cost. With thousands of files this 
  rounds out, but small samples may show distorted percentiles.
- Parses use `errorRecovery: true` for both parsers so neither bails out on 
  malformed code (the chunking pipeline’s production posture).

## Conclusion

oxc is **4.3×** faster than Babel — meaningful but below the 
PRD §1 target of >=5x. Worth investigating whether IPC overhead would erode this
further (Phase 8 monitoring).
