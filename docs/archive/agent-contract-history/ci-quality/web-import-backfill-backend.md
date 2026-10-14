# Web import backfill backend

The import/backfill regression selects WASM explicitly before hydration and
requires real complete embedding coverage without a document reload. It does
not qualify GPU execution.

## 2026-10-03 bounded regression correction

The unchanged Linux full-web run at
`92cb6baa8908897bd7260a124417184be7b0dd0a` failed the first import-indexing
case: two files and two chunks remained at zero embedded chunks. Its actual
worker error was `The device (webgpu) does not support fp16.` The independent
adapter probe with canonical CI launch arguments returned `navigator.gpu`
present and `requestAdapter()` null. Model tokenizer responses were 200/206.

The fixture previously cleared all vector preferences and therefore exercised
the unconfigured WebGPU default. The supported explicit CPU selection is the
canonical `vector-preferences.v1` version-3 record with `devicePref: 'wasm'`
and `devicePrefConfigured: true`. The production backend resolves WASM to fp32
for this unquantized collection. Only the test's persisted configuration and
title change; the worker, model, backfill, and assertions remain real.

RED evidence, environment fingerprints and original traces are retained in
`/Users/seandearnaley/Documents/brainstrike-linux-e2e/bst-1964-2026-10-03`.
After explicitly selecting WASM, the focused case passed on macOS in 14.8s
(10.5s test) and in the pinned Linux arm64 image in 14.8s (13.5s test), with
one worker, zero retries, canonical CI arguments and built Vite preview.
Linux uses Playwright 1.63.0, Chrome for Testing 153.0.8010.12 and Node 26.8.2.
The fixture file alone was mounted over the already qualified immutable
92cb6baa source/build volume; no product source or browser pin changed.

The complete changed Linux import-indexing lane then passed all four cases in
51.6s with zero retries: complete backfill, the 80-file/240-chunk import memory
case, adaptive code routing, and markdown preset import. The heap diagnostic
reported 9.3 MB retained growth; it is not full-app responsiveness proof.

This is a fixture capability correction, not evidence that default GPU
backfill works without a qualified adapter. Do not introduce automatic
fallback or a fake GPU. The separately reproduced OPFS-to-IndexedDB native
SIGTRAP remains an open full-regression blocker; no browser-crash investigation
or quarantine changes are part of this correction.

## Integration fixture replay

The fixture replay starts from integration `b621cb8494818d7320685bc25aa31101876a5419` and preserves the accepted `aece580ca` Clear Database helper and `79d47c4ce` explicit WASM seed/title. The original quarantine change `488592f22` describes the import serial group's three later cases as never run after the first failure, rather than separately diagnosed failures. The subsequent four-case Linux lane is supporting evidence for restoring that group's coverage. Only the two clear-database BST-1962 annotations and the import/backfill BST-1963 group annotation are removed. All six bodies and assertions are retained; other quarantines and BST-1964 remain unchanged.

The recorded Mac/Linux runs above qualify the earlier source/build environment only. Fresh focused validation on this integration-based branch is recorded below. The replay does not claim an OPFS/IDB SIGTRAP correction; the final full Linux regression remains a separate gate.

## Current integration-based local validation

On parent `b621cb8494818d7320685bc25aa31101876a5419`, the final fixture blobs are `4c508a104169265aafa1cf924e823d180e3cde22` (clear database) and `aa2c75bb8f3efc9384f02aac06cb7ce287a8fdeb` (import/indexing), identical to the accepted fixture commits. Production source and browser/runtime versions are unchanged.

- `pnpm turbo run build type-check --filter=@brainstrike/web --output-logs=errors-only`: all 49 required tasks passed, 47 cached. The current built web preview was used.
- Local macOS arm64, pnpm-managed Node 26.8.2, Playwright 1.63.0 and pinned Chromium 153.0.8010.12: two clear-database cases and all four import/indexing cases passed, six total, zero skipped and zero retries, 52.6s total. Complete embedding coverage and same-document checks executed. The 80-file/240-chunk memory case measured 25.7 MB retained growth within its existing bound; this is not a full-app performance claim.
- Explicit WASM selects real CPU inference; no GPU fallback, runtime change, OPFS workaround, assertion removal or new quarantine was introduced.

Command from the checkout root (the local `CI=true` flag selects canonical browser launch settings; it does not enable hosted Actions):

```sh
CI=true COVERAGE=false PORT=19181 BASE_URL=http://127.0.0.1:19181 \
pnpm --filter @brainstrike/web exec playwright test \
  e2e/clear-database-rows.test.ts e2e/database-import-backfill.test.ts \
  --project=functional --workers=1 --retries=0 --max-failures=0 --global-timeout=600000
```

Prior Linux receipts remain supporting evidence only. No new Linux run or full-regression claim is made here. CI is disabled due to cost; validation must run locally.
