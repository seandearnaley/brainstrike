# Embeddings integration lane serialization — evidence

Supports `docs/agents/ci-quality.md` § "The embeddings integration lane is
serialized" (BST-1072, settled 2026-08-01). Read this before removing
`--maxWorkers=1 --no-file-parallelism` from `packages/embeddings`
`test:integration`, or when re-measuring its memory. The contract holds the
rule; this file is the record of why.

`packages/embeddings`'s `test:integration` runs
`--maxWorkers=1 --no-file-parallelism`, following the `apps/desktop` precedent.
It is NOT an instance of the "don't serialize every package" rule above: that
rule is about CPU contention, this is about **memory**.

The before-state, corrected (the first version of this section claimed the lane
ran with "no cap of any kind" on "the 2-vCPU runner"; review caught both): the
integration config inherits `pool: 'forks'` and `maxWorkers: '50%'` from
`vitest.config.mts`, and `Unit (rest)` runs on the 4-vCPU/16-GB Ubicloud class
(see the `unit-shard` comment in `test.yml`), so the lane ran **2 workers** and
the serialization is 2 → 1. The 2-vCPU figure belongs to `coverage.yml`'s
`ubicloud-standard-2` host in the section above, a different workflow.

The in-lane flag is also not the only concurrency knob: `test.yml` invokes
`pnpm turbo run test:integration … --concurrency=2`, so a SECOND integration
lane from the SAME `rest` partition (agent, web, file-import…) can share the
box with embeddings — desktop/ui/file-explorer-ui/app-shell cannot, they run
in the separate `heavy` matrix row. The memory accounting is therefore 2 × the
measured **~1.9 GB RSS per worker** (real PGlite plus WASM embedding heaps)
PLUS the co-scheduled rest-partition lane's peak, against 16 GB. Anyone
re-measuring must hold that cross-package factor constant.

**What is proven vs. plausible.** Proven: the crash is concurrency-dependent
and not a bug in one test — the victim VARIES (across two failing runs on
PR #2213 the file that never reported was `embedding-worker-model-resolution`
once and `embedding-worker-batch` the other time), and the serialized lane
passes. The worker died with `[vitest-pool]: Worker exited unexpectedly` and
the job reported `Test Files 11 passed (12)` — the twelfth file never reported
at all. Supporting the MEMORY account specifically: the crash never reproduced
on a developer Mac (74/74) even though a Mac runs `maxWorkers: '100%'` —
strictly MORE concurrent workers than CI's 2 — with far more RAM, so worker
count alone does not produce the crash; available memory does. NOT directly
observed: the precise ceiling that killed the worker. Memory pressure from two
workers plus a co-scheduled lane is the best-supported account, not a captured
OOM kill.

It surfaced on any PR marking embeddings as AFFECTED — which includes editing a
widely-depended-on package such as `assistant-contract`, not just root config —
so it repeatedly failed the required `Unit` check for changes that touch no
embeddings code (5 of 6 observed runs).

Do not remove these flags to speed the lane up without first re-measuring peak
RSS against the runner's 16 GB with the turbo `--concurrency=2` co-lane held
constant.
