# @brainstrike/workers

Adapter-backed file-content reading with bounded concurrency. `/file-content-worker` exports an async queue function; it spawns no Web Worker. Report and context generation live in `@brainstrike/file-explorer-hooks`.

```ts
import { createFileContentWorker } from '@brainstrike/workers/file-content-worker';

const readFiles = createFileContentWorker({ fileSystemAdapter });
const results = await readFiles(requests, undefined, { abortSignal });
```

- Results are keyed by the original composite key: `{ status: 'accessible', content }` or `{ status: 'inaccessible', message }`.
  - Binary, oversized and unreadable files are explicit per-file failures, never content strings; other files may still finish.
  - Full contract: [`file-content-worker.ts`](file-content-worker.ts).
- Authority:
  - Prefer admitted adapter handles.
  - A handleless absolute read needs a durable root ID, fully qualified root/file paths and the explicit absolute-read capability. Missing authority refuses before I/O, with no generic path-reader fallback.
- Cancellation rejects the batch and stops scheduling; the adapter owns already-admitted I/O, so a rejected promise doesn't prove reads stopped.
- Don't infer concurrency limits from platform names.
