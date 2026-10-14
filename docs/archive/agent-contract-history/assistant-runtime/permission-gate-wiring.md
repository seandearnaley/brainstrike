# Permission gate wiring — evidence

Supports `docs/agents/assistant-runtime.md` § "PERMISSION ENGINE (TOOL APPROVAL)".
Read before changing the policy snapshot producer, `filterToolsByPermissionWithMetadata`, the live approval gate clone, or the ask-tools storage fail-safe. BST-1233, BST-1652, BST-1097.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2970-3084), extracted verbatim.

Scope note: MCP elicitation (a server asking the user for input or link consent
DURING a tool call, BST-1584) is a separate consent channel from tool approval
and suspension. Approval/suspension ride the assistant stream and render as
thread cards; elicitation is host-scoped — desktop main's presenter authority
pushes it over IPC to an app-wide modal (`McpElicitationHost`) and receives the
settlement back over IPC. Neither channel resumes or approves the other; see
`docs/agents/assistant-providers.md` (client input / elicitation).

Renderer execution boundary (BST-1233): production desktop main does not import
or register `ipc-tools.ts`, the visible preload exposes no `tools.execute`, and
desktop Settings supplies no playground execution callback. The `window.tools`
bridge is selection-event-only. Consequently renderer code — including the
renderer-hosted local LLM adapter — receives no desktop executor and cannot
invoke native, assistant, shell, or MCP tools directly. The shared local-runtime
adapter remains executor-agnostic for explicit non-desktop embeddings/tests,
but local tool definitions are omitted when no executor is present. Tool
execution stays on the assistant server path below, where the
permission engine owns policy and per-call approvals; there is no compatibility
fallback that reconstructs approval state or accepts a renderer-supplied
workspace path. `ipc-tools.ts` is retained only as an unregistered legacy unit
harness: it preserves coverage of the former exploit path while production has
no import edge to it, and it throws before handler registration unless
`NODE_ENV === 'test'`. `tools-ipc-main-wiring.test.ts` pins the production seams
(main registration, preload/channel exposure, shared Window declaration, and
Settings callback) closed.

Mutation tools PROMPT for per-call approval by default. The permission policy
store (`packages/app-state/src/stores/permission-policy-store.ts`) defaults to
`enforce: true` with policies `{read:allow, mcp:allow, edit:ask, execute:ask}`,
so by default read/MCP tools run free while edits and shell commands suspend the
run for user approval. A user can turn `enforce` off (explicit opt-out), set a
category to `allow`/YOLO, or grant a session category. Its platform storage is
resolved through a local deferred state-storage proxy, so an optimized
chunk-evaluation cycle cannot make Zustand silently omit the `persist` API; a
later hydration retries resolution and genuine adapter failures remain visible.

Flow (desktop assistant server → agent runtime):
1. The renderer attaches the persisted policy snapshot to the request only when
   `enforce` is true. **ONE producer, at request-composition time (BST-1652 — do
   not add a second):** `prepareRequestData`
   (`packages/app-shell/src/hooks/use-assistant-request-lifecycle.ts`) calls
   `getPermissionToolGateSnapshotInput()` against the LIVE store and sets
   `permissionPolicyRequest` unconditionally — to the snapshot when
   `permissionEnforceable` (the desktop data-stream transport) and `enforce`,
   otherwise to `undefined`, which `JSON.stringify` drops. That fresh read is
   what closes the grant→resume race ("Always allow" flips the store and
   approves the pending call in the SAME synchronous handler, with no re-render
   in between). Consequently `buildAssistantRequestData` deliberately does NOT
   take or emit the field and `assistant-ui-panel-wrapper.tsx` deliberately does
   NOT subscribe to the permission-policy store during render: a render-time
   value could only be overwritten, while the subscription re-rendered the whole
   assistant panel on every grant. Pinned from both sides by
   `use-assistant-request-lifecycle.test.ts` ("permission-policy freshness at the
   request-composition seam"), the "never attaches permissionPolicyRequest" case
   in `assistant-ui-panel-wrapper-runtime.test.ts`, and the commit counters in
   `assistant-ui-panel-wrapper-store-subscription.test.tsx`.
   `resolveRequestPermissionPolicy` (agent) builds the trusted
   `PermissionToolGateSnapshot` with a SERVER-built `riskByTool`
   (`buildNativeToolRiskMap`) — the client never classifies tool risk.

   WIRE SHAPE — the field's disappearance for an opted-out request is a
   JSON-BOUNDARY ASSUMPTION, NOT the presence-means-non-default rule that a
   neighbouring opt-in field (`subagentPersonasRequest`) uses by genuinely
   omitting its key. Here the key is always present on the producer's object
   and only serialization removes it; `planMode` is written the same way. Read
   the VALUE — pass it to `resolveRequestPermissionPolicy`, which treats an
   absent key and an explicit `undefined` identically. Full rationale
   (including why `exactOptionalPropertyTypes` never catches drift here) is on
   the field declaration in `packages/agent/src/types.ts`. Pinned from both
   ends: "leaves the opt-in keys PRESENT with undefined values"
   (`use-assistant-request-lifecycle.test.ts`) fixes the producer's shape, and
   the "wire-shape contract" cases
   (`packages/agent/src/__tests__/permission-policy-request.spec.ts`) fix the
   resolver's indifference to it. The unconditional write is load-bearing and
   must NOT be simplified to conditional spread: it has to clobber a stale
   snapshot inherited from `requestData`, not skip it.
2. `filterToolsByPermissionWithMetadata` (`packages/agent/src/mastra/permission-tool-gate.ts`)
   gates the tool map BEFORE the immutable `Agent` is built: `'deny'`→omit;
   `'allow'`→keep unchanged; `'ask'`→keep unchanged and record in
   `askToolIds`/`askTools`; the composition site (`resolveGatedToolMap` for
   the root, `buildPersonaSubAgents` for each child) then clones every kept
   ask tool through `applyLiveApprovalGate` (`approval-gate.ts`) with the
   FUNCTION form of Mastra's PER-TOOL `requireApproval`, evaluated by Mastra
   on every call against the runtime's live gate (the agent's own ask set +
   the leg's remembered session grant). Never a static `true` (settled
   2026-09-15: Mastra copies that boolean once per stream call, so a
   remembered session grant could never lift it — see assistant-subagents.md
   SESSION GRANT STOPS ASKING).
   SUSPENDING tools included (`brainstrike.runPython`; BST-1097, mechanism
   re-based at the @mastra/core ^1.57 adoption — the old SELF-APPROVING
   exception and its registry are gone): an `'ask'` decision takes the SAME
   function-form clone as every other ask tool — the framework's
   pre-execution approval is Gate A. The 1.56 approval rework made the old
   self-raised in-tool suspension unworkable (the framework consumes the
   `{approved}` resume before the tool can read it — an unfinishable loop)
   and simultaneously made the clone safe: the suspend-resume transport
   attaches the `approved: true` rider Mastra's per-leg re-check demands, so
   the tool's OWN `suspend()` pause (Gate B) stays resumable under the flag.
   `resolveSelfApprovalDecision` (exported beside the gate — same resolver,
   same risk lookup, cannot drift) is still injected at the composition root,
   now ONLY for the direct-invocation guard: an `'ask'` call outside an agent
   run refuses rather than running unprompted.
3. PER-TOOL, not global: marking each ask tool with the per-tool flag makes
   Mastra suspend ONLY when that tool is actually called and its per-call
   `needsApprovalFn` answers true — allowed `read`/`mcp` tools in the same run
   still run free, and a tool a remembered session grant allows runs free from
   its next call on. We deliberately do NOT force the run-wide
   `requireToolApproval` (it would suspend EVERY tool call, breaking the
   read-only default, and any truthy value forces sequential steps).
   `resolveAskToolsForRun` (in the tool pipeline,
   `runtime-assembly/tool-pipeline.ts`)
   only decides whether ask tools may STAY: WITH Mastra workflow storage they stay
   (their per-tool flag suspends + the resume path can restore the run); WITHOUT
   storage (`streamMastraToolApprovalAction` throws) they are fail-safe OMITTED
   (never run an approval-required tool unprompted — no-silent-fallbacks).
