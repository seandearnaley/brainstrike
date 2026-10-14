# Suspending-tool registry scan and storage fail-safe — evidence

Supports `docs/agents/assistant-runtime.md` § "PLAN MODE & TOOL SUSPENSION (ask-user / submit-plan)".
Read before changing `REGISTERED_SUSPEND_RESUME_TOOL_IDS`, the reverse-drift scan, or the suspend-tools storage fail-safe.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 4457-4503), extracted verbatim.

`AssistantToolSuspendNotice` dispatches through a total
`Record<RegisteredSuspendResumeToolId, …>`, so adding an id to the registry
without a typed branch is a COMPILE error. `SUSPENDING_NATIVE_TOOL_IDS`
(plan-mode-tool-gate.ts) is DERIVED from the same registry. The REVERSE drift (a
tool that can `suspend()` with no registered resume UI) has no compile-time
guard, so `scripts/__tests__/suspending-tool-registry-contract.test.mjs` scans
source RECURSIVELY, comment-stripped, on the loose token `\bsuspendSchema\b` so
the `{ suspendSchema }` shorthand and a spread of a shared config object both
count. Two scopes, because the token alone cannot tell a DECLARATION from a
consumer that merely reads the property:

- the two declaration roots — `packages/agent/src/tools` (defined) and
  `apps/desktop/src/assistant-server` (registered, and it defines tools of its
  own) — drive an exact match against `REGISTERED_SUSPENDING_TOOL_MODULES`;
- a repo-wide sweep of `apps` + `packages` must equal that set plus an explicit
  `ACKNOWLEDGED_NON_DECLARING_MODULES` list (today just `plan-mode-tool-gate.ts`,
  which READS the property to detect suspending tools structurally).

The sweep exists because the root list was itself unguarded: `walkTypeScriptFiles`
swallows a missing directory, so a suspending tool in a NEW package, or a renamed
root, would have silently stopped being covered while the exact match still passed
on whatever the other root contained. Every scan root is additionally asserted to
exist and be non-empty. Known limitation, deliberate: `stripComments` has no
string-literal awareness, so a `suspendSchema` token after a `//` inside a string
on the same line is missed. It is control-tested in the same file against
subdirectory, shorthand, desktop-root, outside-every-declaration-root,
renamed-root, comment-only, and test-file fixtures. It lives in `test:scripts`
rather than a package spec because a package-scoped vitest reading a foreign
package's source is an unhashed turbo input (stale-green cache landmine).

`DataStreamMapper.handleToolSuspendRequired`
emits the `brainstrike.tool-suspend` data part, honoring the text-part deferral
contract (flush pending run events + finalize open text first). The data part is
transient (aui-data, NOT persisted) — same as approval.

**Resume** (`streamMastraToolResumeAction`): REQUIRES Mastra workflow storage
(throws without it — no silent fallback), calls `resumeStream`, threads
`withRuntimeDerivedStreamOptions` so the rebuilt Agent keeps its native tools
(the same desktop write-on-approval fix), and does NOT pass `requireToolApproval`
(that is approval-specific). Stateless: it holds no in-memory runId, so a future
`listSuspendedRuns` rehydrator can call it with a discovered runId unchanged.

**Storage fail-safe** (`resolveSuspendToolsForRun`, plan-mode-tool-gate.ts): a
tool that can `suspend()` (detected structurally by an own `suspendSchema`) is
FAIL-SAFE omitted from the map when there is no storage to resume it — mirrors
the ask-tools omit in `resolveAskToolsForRun`. Web in-renderer LocalRuntimeChat
has no server/storage, so both suspend tools are omitted there (desktop-first, v1).
