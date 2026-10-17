# Workspace Index Full-Run Verification

This verifier is the acceptance harness for large Workspace Index runs. It is not a smoke test. A passing unit suite does not prove the indexing pipeline is reliable or fast enough.

## Opt-In Real Roots

The desktop verifier is opt-in because it indexes real local folders:

```bash
BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_ROOTS="/abs/root-a:/abs/root-b:/abs/root-c" \
BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_DEVICE=webgpu \
BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_MAX_IDLE_MS=600000 \
BRAINSTRIKE_E2E_ALLOW_GPU=1 \
BRAINSTRIKE_E2E_USER_DATA_DIR="$(mktemp -d /tmp/brainstrike-full-index.XXXXXX)" \
pnpm --filter @brainstrike/desktop exec playwright test e2e/full-workspace-index.desktop.test.ts --workers=1 --reporter=line
```

`BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_ROOTS` uses the platform path delimiter (`:` on macOS/Linux). For a single root, `BRAINSTRIKE_E2E_REAL_ROOT_PATH=/abs/root` is also supported.

## What The Harness Checks

Every check reads the native Workspace Index's own observation: counts, scan receipts and the query plan from the renderer's `indexSearch` capability, and the hidden embedding host's actual worker metadata.

- Seeds desktop `rootsList` with the configured real roots, the `full-root` policy and paused indexing, and reloads the app through normal restore paths.
- Chooses BGE Small, Text and semantic search and the required device's Local model execution in Search & Indexing, then resumes the index.
- Fails immediately when the index authorizes a different number of roots than configured, coverage is blocked, the query plan or the actual worker runs on another device, the worker reports `fallbackApplied=true`, a log line matches DB host timeout, local embedding execution failure or uncaught/unhandled text, or no count changes for `BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_MAX_IDLE_MS` (default 120 s).
- Requires two consecutive terminal polls: every configured root has its complete-scan receipt, files and chunks are indexed, every chunk has its vector (`missingVectors` 0, `vectorCoverageComplete`), and the query plan runs on the required device.
- Emits `full-workspace-index-evidence.json` (schema `brainstrike.full-workspace-index.v2`) in the Playwright output directory with timestamped samples of native counts per root, the query plan, the actual worker metadata, renderer heap and embedding host working set, plus fatal log matches.

## Backend Proof Rule

If the target is WebGPU, a run that used WASM is invalid. Set `BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_DEVICE=webgpu` (the default; `wasm` is the other choice); the verifier requires the native query plan's device and the hidden embedding host's `embeddingRuntime.actualWorkerMetadata.device` to equal it, with `fallbackApplied === false`.

Analyze the emitted artifact with:

```bash
node apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs \
  --evidence apps/desktop/test-results/full-workspace-index-evidence.json \
  --require-device webgpu
```

## Focused Development Checks

```bash
pnpm --filter @brainstrike/app-shell run type-check
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/ipc-domains/file-system-ipc.test.ts
pnpm --filter @brainstrike/desktop run type-check:e2e
pnpm --filter @brainstrike/desktop exec playwright test e2e/full-workspace-index.desktop.test.ts --workers=1 --reporter=line
```
