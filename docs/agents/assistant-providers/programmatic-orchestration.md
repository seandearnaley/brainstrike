# Programmatic orchestration — evidence

Supports `docs/agents/assistant-providers.md` § "Programmatic orchestration decision". The measured no-go, the closed adapter gaps, and the candidate allowlist if the gates ever clear.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5466-5506); append rather than
rewrite.

---

Do not add a production programmatic-orchestration mode yet. GPT-5.6 Luna's
hosted Programmatic Tool Calling cut input tokens by 71–94% and estimated cost
by 56–89% on three bounded fan-out workloads, but it was strictly correct on
only one of three first runs; direct calling passed all three. The installed
Mastra 1.51.0 / AI SDK OpenAI 4.0.8 path also cannot express the hosted tool,
`allowed_callers`, function `output_schema`, nested `caller`, or `program` /
`program_output` continuation items. Do not add casts or a raw parallel
Responses loop around Mastra's provider-history, persistence, suspension,
telemetry, and processor contracts.

**Adapter-gap update (BST-1284, 2026-08-15).** The adapter half of that second
sentence is now stale: `@ai-sdk/openai` 4.0.42 ships
`openai.tools.programmaticToolCalling()` (`openai.programmatic_tool_calling`,
provider-executed) plus `allowedCallers`, function `outputSchema`, nested
`caller`, and `program` / `program_output` continuation items — all five
recorded gaps have closed, and
`provider-native-programmatic-tool-calling-compat.spec.ts` now pins that
surface. **The no-go itself stands.** Its other ground is the measured
correctness result (strictly correct on one of three first runs, against three
of three for direct calling), which a dependency bump cannot move. Adoption
still requires a fresh measured re-run against the gates recorded above; the
version bump deliberately did not adopt it.

OpenCode Code Mode validates the local architecture shape: a confined
interpreter over a permission-filtered catalog can reduce fixed read-only
programs without ambient filesystem, process, network, or module authority.
Its host must still reauthorize every nested call and set explicit timeout,
call-count, concurrency, and output budgets. The measured fixed programs were
correct and kept 98–99% of raw intermediate characters out of their final
results, but they were hand-authored and therefore do not establish
model-authored-program quality.

If upstream support and model quality later clear the recorded gates, the exact
program-visible candidate allowlist is `readWorkspaceFile`,
`readWorkspaceDirectory`, `globWorkspace`, `grepSearch`, and
`findWorkspaceSymbol`, intersected after capability, user-enabled, and
permission admission. Keep semantic/adaptive retrieval, web/citation work,
artifact continuation, MCP discovery, LSP diagnostics, command sessions,
shell, approvals, writes, task/plan state, external actions, and unknown tools
direct. There is no silent route switch. Full evidence is in
`docs/agents/research/bst-616-programmatic-orchestration-spike.md`.
