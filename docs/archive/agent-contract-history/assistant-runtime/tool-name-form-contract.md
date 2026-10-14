# Tool name-form contract — evidence

Supports `docs/agents/assistant-runtime.md` § "PERMISSION ENGINE (TOOL APPROVAL)".
Read before changing sanitized/original tool-name resolution on any approval surface, or the permission-policy store migration. Settled on PR #1987 review.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 3630-3723), extracted verbatim.

NAME-FORM CONTRACT (settled — the rediscovery live bug class): Mastra registers
tools under SANITIZED ids (`brainstrike.executeCommand` → `brainstrike_executeCommand`,
see `tool-sanitizer.ts`) and its stream parts + suspended-run snapshots carry
that registered id. Every CLIENT-FACING approval surface, though, is keyed by
the ORIGINAL dotted name: `riskByTool` (`buildNativeToolRiskMap`), per-tool
overrides (`setToolOverride` from "Always allow"), and the notice label. The
bridges:
- `askTools` stays SINGLE-keyed by sanitized id (dual-keying would inflate
  `askTools.size`, corrupting the empty-ask-set posture check in
  `resolveRequireToolApproval` — disambiguated by `permissionEnforced`, see above —
  and duplicate the gate's per-tool logs — do not
  relitigate). `resolveAskToolMetadata(askTools, name)` (permission-tool-gate.ts)
  resolves metadata under EITHER form: `get(name)` first, else a scan over
  `meta.originalName`.
- `makeApprovalRequiredChunks` uses that lookup; the emitted chunk's `toolName`
  is always the ORIGINAL name — resolved as
  `sanitizedNameMap?.get(raw) ?? denormalizeNativeToolName(raw)`, the SAME
  MAP-WINS order as `resolveDiscoveredApprovalToolName`,
  `listSuspendedMastraRuns` (below) and `ProjectionSafeToolCallFilter`
  (`projection-safe-tool-call-filter.ts`). The runtime `toolNameMap` is
  AUTHORITATIVE — it is the only layer that can bridge MCP names — and the
  static native reverse map is only the fallback for a route whose runtime
  registered no natives: `apps/desktop/src/ipc-agent.ts` streams with NO
  `tools`, so a native pause there has no map entry and would otherwise label
  the notice `brainstrike_executeCommand`.
  **ORDER IS LOAD-BEARING, do not "simplify" it to
  `denormalizeNativeToolName(map.get(raw) ?? raw)`** (settled on #1987 review):
  `sanitizeTools` records `map.set(uniqueName, name)` UNCONDITIONALLY, including
  the identity case, so a tool registered under the literal underscored id
  `brainstrike_executeCommand` maps to ITSELF — denormalizing a successful hit
  would rewrite that authoritative original to `brainstrike.executeCommand`,
  mislabelling the notice and submitting the wrong id to per-tool grant
  handling. (A colon/dot original like `brainstrike:executeCommand` is NOT
  affected either way: the map VALUE is not a key of the reverse map.)
  `makeUnsupportedApprovalChunks` (the malformed-pause termination, whose
  tool-event `name` + `run.failed` `toolName` are the only names the user sees)
  resolves identically. Proof in `mastra-tool-approval-chunks.spec.ts`: the two
  "denormalizes a native … no sanitized name map entry exists" cases pin the
  FALLBACK half, "keeps a MAPPED approval tool name authoritative even when it
  looks like a sanitized native id" pins the ORDER, and "passes an underscored
  NON-native approval tool name through unchanged" pins that the fallback never
  fabricates a dotted name by blind `_`→`.` swap.
  A policy-driven
  pause (non-empty `askTools`) whose tool resolves under NEITHER form still
  surfaces the pause but omits `riskCategory`/`policyDecision` (never
  fabricated) and logs `logger.error` code
  `mastra_agent_approval_metadata_unresolved`.
- `listSuspendedMastraRuns` maps each discovered `toolCall.toolName` back to the
  original: the discovery runtime's `toolNameMap` first (tools registered), else
  the static native reverse map (`denormalizeNativeToolName` — this is what
  makes the desktop KEYLESS discovery route resolve natives), else the
  registered id passes through with `logger.warn` code
  `mastra_agent_suspended_tool_name_unmapped`. The desktop route then warns with
  `assistant_suspended_approval_risk_unresolved` when a rediscovered approval
  still has no risk category (honest degradation: no reason line, no grant
  buttons). Live proof: the dotted-id cases in
  `mastra-suspended-runs-discovery.integration.spec.ts` and
  `mastra-tool-approval-suspend.integration.spec.ts`.
  KNOWN DISPLAY GAP (documented follow-up, NOT a bug): on the KEYLESS discovery
  route (empty `toolNameMap`) an MCP tool falls through BOTH maps —
  `denormalizeNativeToolName` only reverses KNOWN NATIVE ids, and MCP sanitization
  is not safely reversible (an underscore in an MCP server/tool name could be
  original, so a blind `_`→`.` swap would FABRICATE a wrong dotted name — a
  no-silent-fallbacks violation). So a rediscovered MCP approval displays its
  sanitized id (`someServer_someTool`, not `someServer.someTool`). Display-only:
  MCP is absent from the native risk map, so grant actions are correctly absent
  anyway, and the pause still surfaces for approve/decline. A future fix would
  persist the MCP name map alongside the suspended run.

Migration (enforce-on is a SECURITY fix): the store bumps to v2. Under v1,
`false` was the default AND always persisted, so a pre-v2 `false` slice is
indistinguishable from an opt-out — `migrate` adopts the secure default (`true`)
for ANY pre-v2 slice (a genuine v1 opt-out gets re-prompted once, the safe
direction). Only a v2+ persisted boolean is honored verbatim. Skipping this would
leave upgrading `enforce:false` users with the now-always-registered, ungated
`executeCommand` — the regression this guards against.
The store also sanitizes every current-version hydration through the shared
persist merge: malformed `enforce`/`yolo` values take secure defaults, invalid
policy and override entries are dropped/defaulted, and persisted action-shaped
keys or `sessionGrants` never enter live state. The merge returns live state
unchanged when no persisted snapshot exists and preserves the session-only grant
set across a late hydration.

Web: the in-renderer LocalRuntimeChat never reaches `streamMastraAgent` (no
assistant server / storage), so ask tools are fail-safe-omitted there and web
local chat is unaffected (desktop-first).

Live-loop proof (real Agent + real PGlite workflow storage, no agent mock):
`packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts` —
suspend→approve→execute, suspend→decline→skip, AND an allowed read tool runs
FREE while an ask tool is in the map (the per-tool-not-global guard). NOTE: the
scripted model's synchronous stream starves the event loop during the
PGlite-backed resume; the test drains with a per-chunk `setImmediate` yield
(mirrors real streaming) — a harness concern, not a production bug.
