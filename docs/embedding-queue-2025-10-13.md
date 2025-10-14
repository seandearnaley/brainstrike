# Embedding Queue – 2025-10-13

## High-level flow

```
UI (browser / Electron renderer)
  └─▶ QueueAdapter
        ├─▶ workerpool pool (N workers)
        │     └─▶ embedding.worker.ts (Transformers.js)
        │            ├─▶ pipeline('feature-extraction', device=webgpu|wasm)
        │            ├─▶ normalize + truncate
        │            └─▶ post progress/result events
        └─▶ p-queue fallback (when Web Workers are unavailable)
              └─▶ inline embed() using WASM backend
```

## Queue state machine

```
[IDLE] --add--> [ENQUEUED] --worker-available--> [RUNNING]
   ^                   |                                |
   |--drain()<---------+--------complete/error----------+
   |--pause()--> [PAUSED] --resume()--------------------+
   |--error(batch)--> [BACKOFF] (halve batch, switch to WASM) -> [ENQUEUED]
```

## Integration notes

- Import `createBrowserEmbeddingQueue` from `@brainstrike/queue` inside browser/Electron renderer surfaces and keep the returned instance as a singleton. This factory auto-detects worker support and falls back to `p-queue` if CSP or legacy browsers block workers.
- Worker pool size is derived from `navigator.hardwareConcurrency`, clamped between 1 and 8 logical cores to mirror MDN guidance on sizing worker pools [1].
- Progress updates stream through `workerpool.workerEmit`, allowing UI components to show incremental progress and retry states without polling [2].
- The Transformers.js worker prefers WebGPU with `dtype: 'fp16'`; on GPU loss it halves the batch size and retries on the WASM backend per the Transformers WebGPU recommendations [3].
- Web builds (Vite) and the Electron renderer resolve the worker script via `new URL('./embedding.worker.js', import.meta.url)` so bundlers can create module workers without extra configuration [1].
- Unit tests mock workerpool/pipeline primitives; run `pnpm test --filter @brainstrike/queue` and `pnpm test --filter @brainstrike/embedding-worker` to keep coverage fast.
- For local profiling, run `pnpm --filter @brainstrike/queue tsx packages/queue/test/perf-harness.ts` (model downloads require network access).

## References

1. MDN – Worker construction and `navigator.hardwareConcurrency`: https://developer.mozilla.org/docs/Web/API/Worker/Worker & https://developer.mozilla.org/docs/Web/API/NavigatorConcurrentHardware/hardwareConcurrency
2. workerpool progress events: https://github.com/josdejong/workerpool#progress
3. Transformers.js WebGPU fallback guidance: https://huggingface.co/docs/transformers.js/en/integrations/webgpu
