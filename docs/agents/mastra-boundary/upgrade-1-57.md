# 1.51 → 1.57 upgrade record — evidence

Supports `docs/agents/mastra-boundary.md` § "1.51 → 1.57 UPGRADE NOTES"
(2026-08-06/07). Read this before changing run_python's approval gates or when a
similar approval-semantics break lands in a future upgrade.


Re-verified on `@mastra/core@1.57.0` + `@mastra/memory@1.26.0`: the R1 no-server
guard (`scripts/__tests__/mastra-boundary-contract.test.mjs`, 6/6) and both
stream-contract guards (`mastra-stream-chunk-contract.mjs`,
`verify-mastra-schema-init-order.mjs`) pass unchanged. Compile-time surface
changes hit and fixed in this range:

- `ToolExecutionContext.observe` became REQUIRED (observability helpers, always
  provided by the runtime) while `createTool`'s execute callback context is
  statically typed as only `{ requestContext }` — `mcp-runtime-client.ts` now
  types its inbound context as the `McpExecuteContext` slice it actually reads.
- `ToolsInput[string]` widened with execute-less members (provider-defined
  tools, web-search placeholders) — property probes for `.execute` must narrow
  with `'execute' in tool` first (`apps/desktop/src/ipc-tools.ts`,
  `capture-on-edit.integration.test.ts`).

**The 1.56 approval rework and the BST-1097 adaptation.** 1.56 made the
framework consume `{approved}` resumes of ANY approval-gated call before the
tool can read them, which killed the old self-raised in-tool Gate A (approve
looped forever re-asking; decline became Mastra's generic denial). Rather than
holding below 1.56, the repo adopted the new idiom (settled with the user,
2026-08-07): run_python's Gate A is now the permission gate's ordinary
`requireApproval` clone (pre-execution approval), its Gate B plain suspension
stays resumable because the suspend-resume transport attaches the
`approved: true` rider Mastra's per-leg re-check demands, declines streamed no
tool result at 1.56/1.57 (the approval card's Declined state owned the UX, like
every other ask tool — **superseded at 1.59, see below**), and the
direct-invocation guard stays in-tool. The old
self-approving registry (`SELF_APPROVING_NATIVE_TOOL_IDS`) is deleted. Full
narrative + test map: docs/dependency-updates-breaking-changes.md (Mastra
section) and docs/agents/code-execution.md (Gate A section). The 15-test
`mastra-tool-suspend-resume.integration.spec.ts` remains the canary for any
future approval-semantics drift.

