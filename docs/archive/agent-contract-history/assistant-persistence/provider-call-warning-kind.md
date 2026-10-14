# Provider call-warning kind — evidence

Supports `docs/agents/assistant-persistence.md` §
"PROVIDER CALL-WARNING KIND". Read this before proposing to change its drain point, dedupe scope, or always-visible membership.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`provider.request.warned` is an additive `ASSISTANT_RUN_EVENT_KINDS` member
recording that the provider did NOT carry a request out as written — every AI
SDK adapter answers a setting the model rejects by DROPPING it and listing it on
the call's `warnings` array instead of returning 400, so a user-set
`temperature` from the Prompt Workbench is simply ignored on a model that
refuses one.

Rows identify the configured provider/model in the detail prefix and metadata.
Identical warnings deduplicate per model within a run; a distinct pinned model
retains its own warning. Origin fields use the same bounded redaction contract.

Like `mcp.tools.unavailable` it comes from the AGENT STREAM, not a main-process
writer, and reaches persistence through the ordinary run-event chunk path. It is
NOT a prelude: a call warning does not exist until the request has gone out, so
`streamAttemptChunks` drains it per part
(`drainProviderCallWarningChunks`), which lands the row as soon as the adapter
opens its stream and never after the finish chunk that stops the consumer
pulling. Status is always `'failed'`, never `'running'`, so it declares no
terminal and cannot leave a row spinning; it is filed under `NEVER_RUNNING` in
`assistant-run-event-pairing-contract.test.ts`, and the emitted status is
asserted directly by
`packages/agent/src/mastra/__tests__/provider-warning-run-events.spec.ts`.

It is in `isAlwaysVisibleRunEvent`, LOAD-BEARING for the same reason: the turn
completes normally, so there is no failed tool, no error bubble and no card of
any kind — this row is the only evidence the setting was dropped, and a row
hidden at default detail would leave the silent degradation exactly as it was
found.

One row per DISTINCT bounded warning: the same rejection recurs on every step of a
multi-step turn (it is a property of the request), and the sink dedupes it to
one fact, one row across supervisor and persona calls. Provider-controlled
fields are bounded/redacted before the sink retains them, and metadata and
no-detail prose are bounded at presentation too. Exceptional termination drains
captured warnings before propagating the original failure (BST-1745).
The capture-side contract — including why the warnings are
read at the MODEL rather than off a Mastra chunk — is in
`docs/agents/assistant-providers.md`.

