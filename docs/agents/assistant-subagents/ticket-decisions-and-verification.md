# Project decisions and verification boundaries — evidence

Supports `docs/agents/assistant-subagents.md` § "Implementation decisions for the remaining tickets".
Supports `docs/agents/assistant-subagents.md` § "Verification boundaries".

The BST-1716..1728 design decisions as written, including the AgentController rejection and the per-ticket ownership split.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 175–230 at commit 7c3eb8f38.

---

- Keep native `Agent` delegation and the existing Brainstrike host services.
  Do not migrate to `AgentController` for this project: its beta Session host
  overlaps our permissions, thread/run ownership and workspace services, and
  its live grants/approvals are not automatically durable. The native tests
  already prove the recursion and suspension primitives we need. See the
  named background-lifetime exception in mastra-boundary.md.
- BST-1718 owns durable root/parent/invocation/child identities, server-owned
  resource access and usage attribution. Do not derive ancestry by parsing
  generated thread-id strings. Persist immutable invocation/config identity;
  follow-ups reuse the child thread but receive their own run identity.
- BST-1719 maps the nested stream into the same Brainstrike StreamChunk and
  transcript contracts as root conversations. Compact parent results are not
  a substitute for full child storage. Never expand parent prompt budgets to
  obtain richer UI data.
- BST-1720 must connect native nested approval/suspension to the production
  host and UI before BST-1721 exposes write/execute/general-worker tools.
- BST-1722 starts with **three descendant levels**, **two runnable children**
  and **eight total invocations per root turn**, with **`maxChildSteps` per
  child (user setting, default 32, ceiling 64)** including its reserved
  synthesis step. `DELEGATION_LIMITS` is the TREE source (depth 3, invocations
  8, two runnable, 131,072 output tokens per original turn); the per-child
  allocations — `maxChildOutputTokens` (default 32,768), `maxStepOutputTokens`
  (default 8,192) and the precharged `synthesisOutputTokens` (default 2,048) —
  are `RuntimeSubagentSettings` (`subagent-settings.ts`), copied into the
  turn's budget row at first admission.
  These output allocations are separate from each model's input context window.
  The host atomically admits invocations and reserves model steps before work,
  across descendants and resume legs. Unknown usage remains charged; reported
  overages are persisted before rejecting tool execution. A waiting native
  delegation holds no model/tool permit.
- Preserve read-only Explorer/Analyst definitions. A separate general worker
  completes deliverables using the root's eligible guarded capabilities and
  explicit task/context transfer. Profile narrowing never expands host
  authority. Child workspace writes need BST-1726 conflict/checkpoint rules.

### Verification boundaries

The native suite is **not desktop E2E coverage**. For production-path tests,
reuse `apps/desktop/e2e/utils/model-provider-shim.ts` with the isolated profile
and real host launch pattern in `mcp-packaged-core.desktop.test.ts`; script the
model endpoint, not the assistant stream. The shim accepts either one fixed script
or a per-request selector receiving parsed messages, advertised function-tool
names, and the request ordinal. Route parent and child scripts from those
request inputs; each selected script still derives its tool/final turn from
that request's own history. The existing renderer-only
`setupAssistantMock` is suitable for UI states, not execution/persistence proof.
Each runtime/UI ticket must extend these existing seams with its scenario;
BST-1728 runs the assembled matrix. No new mock-only lane can stand in for the
real host route. Renderer reconnect, reconstructed runtime/storage, and an
actual process restart are separate guarantees and must be reported separately.

Sources: [Mastra subagents](https://mastra.ai/docs/subagents),
[human-in-the-loop](https://mastra.ai/docs/agents/human-in-the-loop),
[background tasks](https://mastra.ai/docs/harness/background-tasks), and the
installed public Agent declarations. The file-based builder's documented
three-level discovery bound is not a universal runtime recursion guarantee.
