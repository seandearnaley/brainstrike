# Tool output artifact persistence — evidence

Supports `docs/agents/assistant-persistence.md` §
"TOOL OUTPUT ARTIFACT PERSISTENCE". Read this before proposing to change the artifact table, its scoping rules, retention, or the settlement thresholds.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Migration 068 and `ToolOutputArtifactRepository` own complete oversized tool
outputs; migration 129 adds native execution-thread identity to deduplication
within the same root resource/thread/run. Existing artifacts backfill their root
thread without changing references, bytes or expiry. A child cursor is readable
through the root-owned reader capability, never by supplying execution identity
as read authority. Exact same-execution replay remains byte-immutable. Native
sibling tests cover reused tool-call IDs, complete model paging, reconstructed
engine reads and hydrated child envelopes.

The table stores results independently of Mastra message rows:

- `brainstrike_assistant_tool_output_artifacts.content` is `BYTEA`, populated
  from exact UTF-8 bytes through hex text + PostgreSQL `decode`; this preserves
  U+0000 and avoids typed-array realm drift across browser workers and Electron
  IPC.
- The public id is an opaque uuidv7 token. Every read also requires the active
  `resource_id` and `thread_id`; a wrong scope is indistinguishable from a
  missing artifact. `run_id`, `execution_thread_id` and `tool_call_id` retain
  execution provenance,
  with one stored result per scoped tool call.
- Range reads are byte-addressed and capped by the shared 8000-byte page
  maximum. The repository returns bytes; the future reader/resolver owns
  UTF-8-boundary adjustment and signed/opaque cursor validation.
- Thread deletion clears artifacts when either their owning root or native execution
  thread is in the deleted subtree; unrelated and sibling execution artifacts remain.
- Retention is seven days. `purgeExpired` deletes an explicitly bounded batch
  in oldest-first order. Expired reads return metadata without content.
- Storage, reads, and purge failures use a typed visible error. Settlement must
  finish the complete write before publishing an artifact envelope; it must
  never substitute a reference after a failed write.
- Exact replay of `(resource, thread, run, execution thread, tool call)` returns
  the existing
  reference only when format and complete bytes match. A different replay
  returns no row and surfaces as a typed storage conflict; settlement never
  overwrites prior evidence.
- There are deliberately no Mastra FKs because the numbered migration runner
  operates on a bare schema. Both direct-PGlite reset paths and desktop
  `db:clearAll` delete artifacts explicitly; only a pre-068 missing relation is
  tolerated.

The desktop assistant now injects a trusted, request-scoped repository adapter
when resource, thread, and server-owned run ids are all present. The agent's
central settlement wrapper persists complete non-media native/MCP results above
12,000 UTF-8 bytes, caps one artifact at 16 MiB, and publishes a preview
envelope only after the repository returns coherent metadata. Display and
transcript store that envelope; a private in-process carrier lets model
projection consume the original result. MCP image/audio remains inline for
display/transcript rendering and keeps its media plus metadata ceilings in both
host modes. Hosts without the adapter additionally retain the temporary MCP
text/JSON inline ceiling. The artifact reader remains a separate later slice.
The wrapper also accepts stricter per-tool serialized-character thresholds.
Desktop sets `brainstrike.webExtract` to 2400 characters so complete small
extracts stay inline while larger page content, exact URLs, and failure reasons
are committed as one exact JSON artifact before any compact model view is
published. When that stored JSON fits one model page, display keeps the complete
raw result and the model page reports completion without an EOF cursor.
Paired tests:
`migration-068-tool-output-artifacts.test.ts`,
`tool-output-artifact-repository.test.ts`,
`tool-output-artifact-settlement.spec.ts`,
`mastra-tool-execution.integration.spec.ts`,
the desktop `assistant-server/run-persistence-http.integration.test.ts` and
`assistant-server/agent-stream-init-and-memory.integration.test.ts` (the
pre-BST-1028 `assistant-server.integration.test.ts` split),
`factory-reset.test.tsx`, and the desktop `ipc-handlers-db.test.ts`.

