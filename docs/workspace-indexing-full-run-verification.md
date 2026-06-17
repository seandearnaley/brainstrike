# Workspace Index Full-Run Verification

This verifier is the acceptance harness for large Workspace Index runs. It is not a smoke test. A passing unit suite does not prove the indexing pipeline is reliable or fast enough.

## Opt-In Real Roots

The desktop verifier is opt-in because it indexes real local folders:

```bash
BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_ROOTS="/abs/root-a:/abs/root-b:/abs/root-c" \
BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_DEVICE=webgpu \
BRAINSTRIKE_E2E_ALLOW_GPU=1 \
BRAINSTRIKE_E2E_USER_DATA_DIR="$(mktemp -d /tmp/brainstrike-full-index.XXXXXX)" \
pnpm --filter @brainstrike/desktop exec playwright test e2e/full-workspace-index.desktop.test.ts --workers=1 --reporter=line
```

`BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_ROOTS` uses the platform path delimiter (`:` on macOS/Linux). For a single root, `BRAINSTRIKE_E2E_REAL_ROOT_PATH=/abs/root` is also supported.

## What The Harness Checks

- Seeds desktop `rootsList` with the configured real roots and reloads the app through normal restore paths.
- Sets Workspace Index policy to `full-root`.
- Requires `window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__` to be available.
- Counts expected files through app traversal and app policy, not shell `find`.
- Fails immediately on blocked/error sync status, debug access issues, selected-device mismatch, actual backend mismatch once worker metadata exists, `fallbackApplied=true`, DB host timeout text, local embedding execution failure text, uncaught/unhandled log text, or a long no-progress window.
- Requires two stable terminal polls where expected files equal DB `file_records`, all records are chunked, all chunks are embedded, and no queued/running/failed `embed_chunk` jobs remain.
- Emits `full-workspace-index-evidence.json` in the Playwright output directory with timestamped samples, terminal counts, actual worker metadata, memory samples, and fatal log matches.

## Backend Proof Rule

If the target is WebGPU, a run that used WASM is invalid. Set `BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_DEVICE=webgpu`; the verifier requires terminal `embeddingHost.status.embeddingRuntime.actualWorkerMetadata.device === "webgpu"` and `fallbackApplied === false`.

Analyze the emitted artifact with:

```bash
node apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs --require-device webgpu
```

## Focused Development Checks

```bash
pnpm --filter @brainstrike/app-shell run type-check
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/ipc-domains/file-system-ipc.test.ts
pnpm --filter @brainstrike/desktop run type-check:e2e
pnpm --filter @brainstrike/desktop exec playwright test e2e/full-workspace-index.desktop.test.ts --workers=1 --reporter=line
```
