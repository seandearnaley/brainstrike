# Canvas document versions — evidence

Supports `docs/agents/assistant-persistence.md` §
"CANVAS DOCUMENT VERSIONS". Read this before proposing to change the version table, its cleanup ownership, or the manageCanvas failure vocabulary.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Since BST-1980 the agent host owns every canvas as committed
`tool.state.updated` rows in the thread's run log, and migration 147 dropped
the PGlite table described below. The first two paragraphs are history.

Persisted Canvas HTML is application-owned, local-first state in
`brainstrike_canvas_versions` (migration 082 in BOTH runners, sole author since
BST-1651 retired the bootstrap mirror). Rows sharing `canvas_id` form one
document and the greatest integer `version` is current. Row ids and canvas ids
are app-side uuidv7 values; timestamps are read as `created_at::text`; and
`created_by` is CHECK-constrained to `assistant | user` and validated again on
repository reads. There are no foreign keys because the numbered runner uses a
bare schema.

`THREAD_DELETE_SIDECAR_TABLES` owns Canvas cleanup for all three thread-delete
implementations, while the reset registry owns all three table-enumerating
clear paths. The host's canvas store (`hostCanvasStore` in
`packages/host-capabilities/src/native-tools/host-stores.ts`) creates version 1,
lists latest versions, and writes a new version for every update or rewrite.
Exact updates require `oldString` to occur once: zero and multiple matches return `no_match` and
`ambiguous_match` structured failures, respectively; missing canvases return
`not_found`. Stored-vocabulary drift throws visibly as corruption.

`brainstrike.manageCanvas` exposes `create`, `update`, `rewrite`, and `list` to
the assistant. Runtime thread/resource identity is mandatory and missing
identity returns a structured failure. `create` requires content: an empty
document (`isEmptyCanvasDocument`) returns `empty_document` with a hint and
writes no version 1 — see the settled ruling in
`docs/agents/assistant-providers.md`. The Canvas panel's selected canvas is
`focusedCanvasId` on the Changes navigation store (written by its picker and
by the `canvas://<canvasId>` chip on the tool card); reset clears it.

Paired tests: `canvas-document-content.test.ts`, `manage-canvas-tool.test.ts`,
`host-thread-canvases.test.ts`, `canvas-read-repository.test.ts`,
`canvas-panel.test.tsx`, `migration-147-drop-pglite-chat-sidecars.test.ts` and
the `host-thread-canvas-live` desktop E2E.

