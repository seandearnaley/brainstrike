# @brainstrike/workers

Adapter-backed file-content reading with bounded concurrency. The exported
`/file-content-worker` is an asynchronous queue function; it does not spawn a
Web Worker or expose a `runQueue` object. Report/context generation lives in
`@brainstrike/file-explorer-hooks` and the explorer's context projection.

## Call the actual interface

```ts
import { createFileContentWorker } from '@brainstrike/workers/file-content-worker';
import type { FileReadRequest } from '@brainstrike/workers/file-content-worker';
import type { FileSystemAdapter } from '@brainstrike/file-system';

export async function readSelection(
  fileSystemAdapter: FileSystemAdapter,
  requests: FileReadRequest[],
  abortSignal: AbortSignal
) {
  const readFiles = createFileContentWorker({ fileSystemAdapter });
  return await readFiles(requests, undefined, { abortSignal });
}
```

Results are keyed by the original composite key and discriminate
`{ status: 'accessible', content }` from `{ status: 'inaccessible', message }`.
Binary, oversized and unreadable files remain explicit per-file failures; they
are not content strings containing an error. Other file requests may still finish.
See [`file-content-worker.ts`](file-content-worker.ts) for the full contract.

## Authority and lifetime

Prefer admitted adapter handles. A handleless absolute read requires a durable
root ID and fully qualified root/file paths, plus the explicit absolute-read
capability. Missing authority refuses before I/O; it never falls back to a generic
path reader. Adapter-defined relative reads remain a separate capability.

Cancellation rejects the batch and stops new scheduling; the underlying adapter
owns already-admitted I/O. A rejected queue promise does not prove physical reads
stopped. Provider/reset retirement must retain and join its actual resource owners.
Keep limits and progress separate from publication/selection authority; do not
infer concurrency values from platform names.

[`package.json`](package.json) owns exports and scripts. Local consumers use
`workspace:*`. Select
checks with [validation guidance](../../docs/agents/ci-quality.md).
