# Token-cache transaction retry — adoption evidence

Supports `docs/agents/effect-boundary.md` § "Shared helpers" and ADR-0004.
Baseline: `origin/main` at `38abc99d0841f128bd5cb9c11a952ab6c336fda1`.

`TokenCacheStore.setBatch` still validates paths before writes and runs one
`BEGIN` / upsert sequence / `COMMIT` per attempt. A post-`BEGIN` failure runs
`ROLLBACK`; a failed rollback logs its own warning without replacing the original
failure. The public method remains Promise-based. The Effect boundary wraps the
original rejection value only internally, then returns that same value through
`runAtPromiseBoundary`. `Schedule.exponential` supplies the former 25/50 ms
default delays; `Schedule.upTo` limits three total attempts, and the schedule
checks transient status before logging a retry. Tests cover custom attempt and
delay settings, permanent failures, exhausted retries, rollback failure,
single-attempt configuration, and rejection identity.

A bounded wall-clock check of the existing three-attempt exhausted-retry test
reported 80 ms on the baseline loop and 81 ms on Effect retry (one local run
each, 25+50 ms configured sleeps). This checks that the schedule actually waits;
it is not a performance benchmark.

The previous native `setTimeout` call coerced overlarge delays differently from
Effect's clock, which can wait indefinitely for an infinite delay. Construction
now rejects a retry configuration when its largest exponential delay exceeds
the 2,147,483,647 ms native timer range. A one-attempt configuration needs no
timer and remains valid with any finite base. This is an explicit behavior
change for extreme configurations; normal delays are uncapped and unchanged.

## Focused bundle comparison

Built the same `TokenCacheStore` source entry with Vite 8's browser bundler,
minified ESM, then gzip -9. The baseline source was taken from the commit above;
the working version used pinned `effect@4.0.0-rc.117`. These numbers include the
entry's reachable shared imports, not a whole desktop/web app and not a claim
about app-level marginal cost.

| Store entry | Minified bytes | Gzip -9 bytes |
| --- | ---: | ---: |
| Baseline | 29,656 | 9,575 |
| Effect retry | 77,051 | 22,760 |
| Increase | 47,395 | 13,185 |

The token-cache tsup build still externalizes `effect` and `effect-kit` from its
shared package chunk; its own emitted chunk size is not the browser cost.
The focused Vite measurement is the appropriate local cost signal for this
renderer-reachable source. No Effect version changed.

Validation: 39 `token-cache-store` tests (182 package tests), token-cache `tsc --noEmit`, strict
`effect-tsgo` diagnostics (20 files checked, zero warnings), and the package
build passed. The out-of-range timer test was observed red before the constructor
guard and green after it. The contract guard was observed red before this
evidence file existed.
