# Multi-root tool resolution — evidence

Supports `docs/agents/assistant-providers.md` § "Context-window-scaled default budgets". Guarded failures, root selectors, and the LSP pool keying.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 4334-4370); append rather than
rewrite.

---

Guarded failures (`tool_timeout`, `tool_failed`, `tool_input_invalid`,
`tool_blocked_by_hook`) bypass domain projectors and retain the bounded
structured failure. Generic throws remain redacted as `tool_failed`; trusted
application-owned `ToolInputError` validation failures preserve their safe,
model-correctable message. Multi-root resolution uses that path when a
root-qualified tool misnames or ambiguously names `root`. An omitted selector
uses `boundWorkspaceRootId` only when request preparation has durably bound the
thread to a live DB root; without that binding, ordinary single-target tools
retain the visible ambiguity error. Search tools whose legacy omission meant
"all roots" narrow to the binding when one exists and retain all-root behavior
only for genuinely unbound requests. Their provider schemas state that omission
rule and direct a bound thread to call once per root id when it needs every
folder. An explicit selector for another live mounted root is an observable
cross-root call. A stale/disconnected binding returns the explicit
`bound_workspace_root_unavailable` HTTP 409 initialization failure and never
falls back to Main. Successful resolution logs the mode and
safe root id/name, and native results surface `rootName` in the tool card. The
default multi-root instruction includes
deferred `lspInspect`, so a newly activated semantic tool receives the same
root-qualification rule as reads and searches. Correctable multi-root errors
list complete `displayName (id rootId)` choices within an 800-character budget;
if the inventory exceeds that budget, they direct the model to
`listWorkspaceContext` rather than truncating an identifier.
`lspInspect` also brands its identifier/marker, line-range, missing-fragment, and
ambiguous-fragment rejections as trusted input errors. A markerless single
JavaScript/TypeScript identifier is the preferred model input and anchors the
cursor at its unique occurrence on the requested line; a repeated occurrence
still requires the exact `<<<` fragment form. A wrong-line markerless identifier
returns bounded candidate line numbers for an explicit retry and never silently
moves the request. Its catalog description spells out the `LSP` acronym so the
common `search_tools("lsp")` query finds it; `load_tool` then loads it by exact
name.
The desktop LSP pool is keyed by the durable database `roots.id` returned by
workspace-tool resolution. Root disconnect therefore evicts every LSP pool
entry using the durable ids returned by the path-keyed database transition,
never the renderer adapter id from `rootsList`; those identities can diverge
after remove/re-add reconciliation.
