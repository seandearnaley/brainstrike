# Workspace Indexing Performance Methodology

This document defines the evidence required before claiming Workspace Index performance is acceptable.

## Evidence Source

The primary evidence artifact is produced by:

```bash
BRAINSTRIKE_E2E_ALLOW_GPU=1 \
BRAINSTRIKE_E2E_USER_DATA_DIR="$PROFILE" \
BRAINSTRIKE_DB_ROOT_PATH="$PROFILE" \
BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_ROOTS="/absolute/root/a:/absolute/root/b" \
BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_DEVICE=webgpu \
BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_TIMEOUT_MS=21600000 \
pnpm --filter @brainstrike/desktop exec playwright test e2e/full-workspace-index.desktop.test.ts --workers=1 --reporter=line
```

The verifier artifact records timestamped samples of the native index's per-root file/chunk/vector counts and scan receipts, the query plan's device, the actual embedding worker metadata, renderer heap and embedding host working set, and fatal log matches.
The verifier writes the same artifact to Playwright's output directory and to the stable ignored path `apps/desktop/test-results/full-workspace-index-evidence.json` unless `BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_EVIDENCE_PATH` is set.

## Validation Command

Analyze a verifier artifact (without `--evidence`, `--mode integrated` runs the
loaded foreground-latency benchmark instead; see
`docs/performance/foreground-latency-under-index-build.md`):

```bash
node apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs \
  --evidence apps/desktop/test-results/path/full-workspace-index-evidence.json \
  --require-device webgpu
```

The analyzer fails if:

- the run did not complete, or a configured root has no complete-scan receipt,
- a chunk has no vector,
- the actual embedding worker or the query plan runs on another backend than the required one,
- `fallbackApplied` is true,
- fatal log patterns include DB host timeouts, local embedding execution failure, uncaught, or unhandled errors,
- the renderer's retained heap exceeds `--max-retained-heap-mb` when provided.

## Stage Throughput

The analyzer reports integrated throughput and terminal evidence. The stage
ceiling ratio is retired with the desktop stage benchmark, which measured PGlite
stages the native index no longer runs (BST-2012). The loaded native build
benchmark records when each stage's committed receipts completed instead
(`build.stageMilestonesMs` in `docs/performance/foreground-latency-under-index-build.md`).
