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

The verifier artifact records timestamped debug snapshots, terminal file/chunk counts, selected device preference, actual embedding worker metadata, memory samples, and fatal log matches.

## Validation Command

Analyze the most recent verifier artifact:

```bash
node apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs --require-device webgpu
```

Analyze a specific artifact:

```bash
node apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs \
  --evidence apps/desktop/test-results/path/full-workspace-index-evidence.json \
  --require-device webgpu
```

The analyzer fails if:

- the run did not reach terminal file/chunk/embedding completion,
- queued, running, or failed `embed_chunk` jobs remain,
- the actual embedding worker backend is not the required backend,
- `fallbackApplied` is true,
- fatal log patterns include DB host timeouts, local embedding execution failure, uncaught, or unhandled errors,
- retained heap exceeds `--max-retained-heap-mb` when provided,
- integrated throughput is below `--min-ratio` when stage ceilings are provided.

## Throughput Ratio

The acceptance ratio is:

```text
integratedToBottleneckRatio =
  integratedChunksPerSecond / min(stageCeilings)
```

Stage ceilings must be measured on the same machine and backend as the integrated run. Until dedicated stage modes exist, pass measured values explicitly:

```bash
node apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs \
  --require-device webgpu \
  --stage-ceiling embeddingCeilingChunksPerSecond=25 \
  --stage-ceiling dbCompletionCeilingChunksPerSecond=40 \
  --stage-ceiling chunkingCeilingChunksPerSecond=60 \
  --stage-ceiling importCeilingEquivalentChunksPerSecond=80
```

Do not publish a ratio with guessed ceilings. If ceilings are not supplied, the analyzer reports integrated throughput and terminal evidence only.
