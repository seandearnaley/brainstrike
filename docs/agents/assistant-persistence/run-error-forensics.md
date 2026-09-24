# Run error provider forensics — evidence

Supports `docs/agents/assistant-persistence.md` §
"RUN ERROR PROVIDER FORENSICS". Read this before proposing to change the FK-less parent link, the first-terminal-wins conflict rule, or the row shape.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`brainstrike_assistant_run_errors` is the durable one-row-per-run provider
failure summary (migration 076, registered in both runners and sole author
since BST-1651 retired the bootstrap mirror). It is deliberately
separate from both the run-event timeline and app-wide diagnostic events:
`run_events` describes lifecycle presentation, while `run_errors` retains the
terminal classification and bounded provider response evidence needed for
forensics.

The table is FK-less, a shape inherited from when the parent was created at
runtime and NOT revisited by BST-1651. Migration 118 now creates
`brainstrike_assistant_thread_runs`, so an FK has become expressible — but none
is declared, and nothing is scheduled to declare one. The parent link is
enforced in code, not by the schema, and the paragraph below is that
enforcement; do not read the FK's absence as an oversight. The canonical
`AssistantRunErrorRepository.record` therefore derives `thread_id` and
`resource_id` from the durable renderer-minted parent run; callers provide
neither. A missing parent returns no row and THROWS. A conflict on `run_id`
returns the existing row only while the parent still exists, so independent
terminal writers are first-terminal-wins and can never overwrite the original
classification. An already-stored orphan is not accepted as a successful
duplicate.

Desktop catches that loud repository failure at the stream integration boundary
and records `Failed to persist assistant provider failure forensics` with the
run and event ids. The failure MUST remain observable, but it MUST NOT replace
the original provider-failure stream (for example when a thread is deleted
mid-run). The run-event timeline write immediately before it retains its
existing flush semantics.

The row contains `code`, nullable `message`, nullable array-shaped
`cause_chain`, nullable `http_status`, nullable `provider_request_id`, nullable
object-shaped allowlisted `response_headers`, and `occurred_at`. It has NO
`attempts` field: current Mastra error processors expose neither the complete
attempt sequence nor the actual rate-limit wait, so an attempts array would be
fabricated/incomplete data. The application extraction boundary owns content
bounds and the literal response-header allowlist; the database independently
CHECKs JSON shape and HTTP status.

With no FK, lifecycle is explicit: `deleteThread` / `deleteThreads` remove run
errors before their parent runs, and all three table-enumerating reset paths
(desktop `db:clearAll`, renderer direct clear, renderer factory-reset purge)
clear the table before Mastra threads. Paired tests:
`packages/db/__tests__/migration-076-assistant-run-errors.test.ts`,
`packages/db/__tests__/assistant-run-error-repository.test.ts`,
the thread-deletion cases in
`packages/assistant-data/src/__tests__/assistant-memory-repository.integration.test.ts`,
and the desktop/renderer clear integration suites.

