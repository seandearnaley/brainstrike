# Fused MiniLM worker profiles

Supports `local-inference.md` → **Fused MiniLM input and batching**.

The worker keeps the explicit model identity and runs inference in its renderer
worker. The fused export uses the vendor's tokenizer → model → `mean_pooling`
API so `max_length: 256` reaches actual model input. `FeatureExtractionPipeline`
4.3.0 ignores a `max_length` call option and only passes padding/truncation;
passing an unsupported pipeline option would therefore leave the cap ineffective.
Token-budget planning counts capped tokenizer outputs with special tokens and
accounts for padding as longest input × batch count. Input order and stream
acknowledgement backpressure remain intact.

## Vendor assets verified 2026-10-02

| Profile | Model ID | Device | Dtype | Dimensions | Input limit |
| --- | --- | --- | --- | --- | --- |
| Existing MiniLM | `Xenova/all-MiniLM-L6-v2` | WASM | fp32 | 384 | 512 including special tokens |
| Explicit quantized MiniLM | `Xenova/all-MiniLM-L6-v2` | WASM | q8 | 384 | 512 including special tokens |
| Fused MiniLM | `onnx-community/all-MiniLM-L6-v2-ONNX` | WebGPU | fp16 | 384 | 256 including special tokens |
| Fused MiniLM CPU | `onnx-community/all-MiniLM-L6-v2-ONNX` | WASM | fp32 | 384 | 256 including special tokens |

The q8 WASM profile uses `EmbeddingConfig.dtype: 'q8'` or an explicit worker
request dtype. The existing `quantized` boolean retains its original q4/fp32
behavior. The default device selection and model catalog remain unchanged.
Derived-store callers must rebuild with the chosen complete profile identity;
the worker does not migrate stored vectors or alias model IDs.

The fused repository at `aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f`
publishes fp32/fp16/q4/q4f16, and no q8 asset. A real Chromium worker request for
fused q8 failed with `Could not locate file` for its
`onnx/model_quantized.onnx`. This is an unsupported combination; no dtype or
model fallback is implemented. Xenova's repository at
`751bff37182d3f1213fa05d7196b954e230abad9` publishes that q8 asset.
Requests can pin these SHAs using `revision`; the loader, cache identity, and
completion correlation all retain it. The table's WebGPU fp16 row describes
published assets, not qualification on every adapter.

Primary vendor references:

- [MiniLM sentence-transformer input limit](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2).
- [Fused model usage and assets](https://huggingface.co/onnx-community/all-MiniLM-L6-v2-ONNX).
- [Xenova model assets](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/main/onnx).
- [Transformers.js dtype selection](https://huggingface.co/docs/transformers.js/guides/dtypes).
- [Vendor custom tokenizer/model/mean-pooling API](https://huggingface.co/docs/transformers.js/custom_usage).
- [Vendor fused attention explanation](https://huggingface.co/blog/transformersjs-v4).

## Local renderer worker verification

`packages/embedding-worker/bench/run-embedding-wave0.mjs` builds a browser
transport around the actual built worker and executes downloaded ONNX weights
inside Chromium. It validates dimensions, finite vectors, model/device/dtype,
no fallback, exact completion coverage, and equal vectors for changes beyond the
fused export's cap. It reports warm throughput and frame gaps on a fixed
128-input code corpus. Its numbers are diagnostic and do not meet the running
app's M2 exit by themselves.

Run after `pnpm exec turbo run build --filter @brainstrike/embedding-worker...`:
`pnpm exec node packages/embedding-worker/bench/run-embedding-wave0.mjs`.

### Chromium observations, 2026-10-02

The initial 128-input warmed WASM run measured Xenova fp32 at 4.06 chunks/s,
Xenova q8 at 3.96 chunks/s, and fused fp32 at 7.46 chunks/s. Batch sizes were
64/64 for Xenova and 32/32/32/32 for the capped fused path. Maximum renderer
frame gaps were 16.8 ms. q8 did not improve throughput in this run. A subsequent
four-input smoke pinned both repository SHAs and verified the completion
revision and zero cap-tail vector difference. These are browser worker
diagnostics, with a different corpus and backend from historical WebGPU app
benchmarks; they establish no M2 throughput or foreground-latency exit.

Headless Chromium 153 selected a fallback Google SwiftShader adapter without
`shader-f16`. Explicit fp16 failed with `The device (webgpu) does not support
fp16`; explicit fp32 failed with `WebGPU device lost: A valid external Instance
reference no longer exists`. Neither result identifies the physical host GPU's
capabilities. No dtype fallback was attempted.

### Actual Electron hidden-host qualification, 2026-10-02

The probe also launches this branch's built desktop app with a fresh isolated
profile, starts its real hidden embedding host, and loads the desktop build's
production worker asset there. The probe's client module provides transport;
inference remains entirely inside the renderer worker. This is a `test-built`
app launch with the application's production GPU switches, not packaged release
acceptance. Verified flags were `disable-features=MacWebContentsOcclusion,SpareRendererForSitePerProcess`;
`disable-gpu`, `enable-unsafe-webgpu`, `enable-gpu-rasterization`, and
`enable-zero-copy` were absent.

Electron 44.4.5 / Chromium 152.0.7977.130 selected vendor `apple`, architecture
`metal-3`, `isFallbackAdapter=false`, with `shader-f16` present. Both pinned fp16
profiles executed successfully and produced finite 384-dimensional vectors.
On the same warmed 128-input code corpus, Xenova fp16 measured 149.66 chunks/s
(64/64 batches), and fused fp16 measured 344.46 chunks/s (32/32/32/32 batches).
Both maximum hidden-host frame gaps were 17.5 ms, and cap-tail difference was 0.
These local numbers do not substitute for the historical corpus or the real
app's loaded visible-renderer, chat-write, tool-read, and index-build M2 gates.

Each comparison profile owns a fresh worker lifetime. Initially switching GPU
models inside one worker failed with `WebGPU device lost: Device was destroyed`
when disposing the prior GPU pipeline. The probe keeps this visible failure in
the record and makes no dtype fallback; production GPU model eviction/recovery
is governed by the existing pipeline lifecycle contract.

After building the desktop closure, run:
`EMBEDDING_PROBE_SURFACE=electron EMBEDDING_PROBE_DEVICE=webgpu pnpm exec node packages/embedding-worker/bench/run-embedding-wave0.mjs`.
