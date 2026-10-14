# Hidden embedding host: execution boundary and capability manifest — evidence

Supports `docs/agents/local-inference.md` § "Hidden host execution boundary".
Read before changing the hidden-preload manifest, the host window mode, or the
main/renderer split for embeddings. The contract holds the rules; this file is
the original flow description, verbatim.

## Rules, reasons, and the host flow (original text)

Rules:
- Embedding worker MUST run in renderer (browser context).
- MUST NOT run in Electron main process.

Reasons:
- Transformers.js requires Web Workers (renderer only).
- In main/Node, it degrades to synchronous WASM → freezes UI.

Flow:
1. Hidden host renderer
   - Files:
     - apps/desktop/src/embedding-host-manager.ts
     - apps/desktop/src/hidden-preload.ts
     - apps/desktop/src/renderer/components/embedding-host-app.tsx
     - apps/desktop/src/renderer/components/embedding-host-runtime.tsx
   - Main creates a hidden BrowserWindow with `?mode=embedding-host`.
   - The window loads `hidden-preload.js` with the server-owned
     `embedding-host` role argument. That manifest exposes only the embedding
     report/request bridge, power snapshot/events, logging ingest, the database
     capabilities the current renderer-owned queue needs, and the scoped
     vector-preferences capability below. It never exposes provider secrets,
     assistant-server credentials, or the visible UI's unrestricted `storage`
     key-value bridge.


   - The host renderer mounts `DbProvider` with `useElectronIPC=true`.
   - The host renderer uses `startEmbeddingWorker()` from `@brainstrike/embeddings`.
   - It pulls jobs from the PGlite-backed `job_queue`.
   - Local models still execute in browser/Web Worker context only.
2. Visible renderer
   - File: packages/vector-management/src/vector-status/use-embedding-worker-controls.ts
   - Does NOT start the embedding worker directly in desktop mode.
   - Talks to the hidden host over the preload bridge (`window.embeddingHost`).
   - Keeps UI controls/status in sync with host lifecycle.
3. Main
   - File: apps/desktop/src/main.ts
   - Does NOT run embeddings in-process.
   - Owns host-window lifecycle, IPC, DB init, and power lifecycle.
   - Visible window uses default background throttling; only the hidden host disables throttling.
   - On macOS, `powerSaveBlocker` is allowed only while the hidden host reports active embedding
     work. Non-Darwin platforms never start one.
