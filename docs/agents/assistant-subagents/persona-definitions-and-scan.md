# Persona definitions, user-persona scan and Settings scope — evidence

Supports `docs/agents/assistant-subagents.md` § "SUBAGENTS (PERSONA DELEGATION)".

Read before changing `personas.ts`, `user-personas.ts`, the persona loader, or the Subagents settings panel.

CORRECTION (2026-09-21): `MAX_USER_PERSONA_MAX_STEPS` is 32, not 16 (`packages/assistant-contract/src/user-personas.ts:45`), so a user persona may declare `maxSteps` up to 32. Built-in caps today: Explorer 32, Analyst 32, Worker 16 (`personas.ts`). The reasoning below (a built-in must not declare a budget a user persona cannot) still holds; only the number moved.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 234–382 at commit 7c3eb8f38.

---

The supervisor assistant can delegate to read-only specialists and a capable Worker
using **Mastra's native supervisor pattern**: child `Agent`s passed via the
parent's `agents: {...}` config become `agent-<key>` delegation tools
automatically. We do NOT build a bespoke `subagent` tool — we ride Mastra's
delegation machinery (hooks, memory isolation, nested-chunk forwarding,
`subAgentToolResults`) and layer brainstrike's rules on top.

- **Personas as data:** `packages/assistant-contract/src/personas.ts`
  (`BUILT_IN_PERSONAS` = `explore`, `analyze`, `worker`) plus USER-DEFINED personas.
  Absent `mode` preserves read-only behavior; `assertReadOnlyPersona` rejects
  non-read/unknown native tools. Explicit `mode: worker` accepts original native
  and MCP ids; a sole `*` inherits the eligible host catalog. Mixed wildcards
  and parent-owned `manageTaskList` are rejected. `assertPersonaToolScope`
  validates the declared mode before runtime permission filtering. `id` is `string`
  (`AssistantBuiltInPersonaId` narrows the built-ins); optional `source:
  'built-in' | 'user'` (absent = built-in).

  **THE STEP CAP IS DERIVED INTO THE DESCRIPTION, NOT WRITTEN INTO PROSE — do
  not relitigate.** `delegationDescriptionForPersona` (personas.ts) appends
  "Runs at most N steps…" from `persona.maxSteps`. Both places a description
  reaches a model call it: the child `Agent` config in
  `build-persona-subagents.ts` (which Mastra turns into the `agent-<id>` tool)
  and the supervisor's own instructions via `persona-assembly.ts`. That
  description is the only thing the supervisor reads when sizing a delegation;
  it used to say just "use when a question needs surveying many files", with
  the cap revealed only AFTER a failed delegation (the no-answer message) — the
  supervisor was invited to over-scope and then told off for it.

  Deriving beats restating for two reasons. There is no second copy to drift,
  and a substring test guarding one would be leaky by construction ("16"
  contains "1" and "6"). And USER-defined personas are covered for free: their
  description comes from markdown frontmatter, which can never mention a cap,
  so hardcoding the sentence in the built-ins would have left every user
  persona with the original bug.

  Built-ins declare `MAX_USER_PERSONA_MAX_STEPS` (16) rather than a private
  larger number: a budget users cannot themselves declare would make the
  shipped Explorer unreplicable by a user persona and would leave that constant
  describing a limit the app ignores. The previous value of 8 left seven usable
  tool steps once the reserved wrap-up step is subtracted.

  **Personas report PROVENANCE, and never author the deliverable.** Child
  instructions require `path:line` for anything read in code and an explicit
  marker when a fact came from documentation or a comment instead — the two go
  out of sync, and the caller cannot tell them apart afterwards. An `explore`
  child reported `FOREGROUND_GATE_REOPEN_MS=250` as a code constant when it
  exists only in `docs/agents/local-inference.md`, and the supervisor wrote it
  into durable working memory under the heading "Verified architecture survey".
  EVERY built-in is told not to produce the caller's final deliverable: one
  asked to survey the repo "for a developer-onboarding document" spent its
  budget returning a complete HTML page that the supervisor discarded, and the
  Analyst takes the same delegations.
- **User-defined personas (v2):** markdown files with frontmatter
  (`description` required; optional `name`, `tools`, `model:
  provider::modelId`, `mode: read-only|worker`, `maxSteps` ≤ 16; body = child instructions), scanned
  FLAT (no recursive directory scan — the id becomes the `agent-<id>` tool name, and provider
  tool-name charsets forbid `:` namespacing) from (1) `<root>/.brainstrike/agents/`
  per mounted root, (2) `~/.brainstrike/agents/`, first-id-wins with warn-once;
  a built-in id collision is an INVALID file, not an override. Parse/validate:
  `packages/assistant-contract/src/user-personas.ts` (`buildUserPersona` —
  fail-closed; omitted mode retains legacy behavior and omitted `tools` =
  `DEFAULT_USER_PERSONA_TOOL_IDS`, the curated
  read-only exploration set WITHOUT webSearch/askUser/submitPlan/manageTaskList;
  explicit askUser/submitPlan declarations are allowed only with the complete
  durable child-control capability at runtime; manageTaskList remains rejected
  because its state belongs to the parent; bare tool names get
  the `brainstrike.` prefix; out-of-range `maxSteps` is an ERROR, never a
  clamp; ids are capped at 58 chars so `agent-<id>` fits the 64-char provider
  tool-name limit). Scan: `apps/desktop/src/assistant-server/user-personas-loader.ts`
  (bounded: 64K chars/file, `MAX_USER_PERSONAS` 50; INVALID files become
  visible `entries` with their error, consumed by Settings → Subagents via the
  `assistantPersonas:list` IPC / `window.assistantPersonas` bridge —
  capability-gated, absent on web). Explicit worker mode defaults omitted tools
  to `*`; known short native ids normalize through the native registry and
  opaque MCP ids retain their exact spelling. Legacy personas stay read-only.

  **Scan invariants (BST-936) — do not regress these.** The full rules and
  rationale, shared with the lens loader, are in
  `docs/agents/workspace-context.md` § `.brainstrike/` SCAN CONVENTIONS;
  persona-specific facts:
  - The id is RESERVED before the file is read, through
    `resolveUserPersonaId` (filename derivation **+** the built-in-collision
    check — the SAME gate `buildUserPersona` uses). Reserving pre-parse is
    what stops a BROKEN `<root>/.brainstrike/agents/x.md` from silently
    handing its name to `~/.brainstrike/agents/x.md`, which would swap in
    entirely different child instructions under the id the project author
    controls. Reserving through only `deriveUserPersonaId` would be wrong:
    a built-in-owned name can never load in any tier, so it must NOT
    reserve, and every same-named file gets the accurate
    `collides with a built-in persona` error instead of a bogus "shadowed".
  - `MAX_USER_PERSONAS` counts scan ENTRIES (valid + invalid), so a
    directory of malformed files consumes the bound instead of extending
    the scan across roots — and because that can starve a later tier, an
    exhausted cap is REPORTED per directory in `incompleteDirs`
    (`reason: 'cap-reached'`), never only logged.
  - The directory-listing bound is `MAX_USER_PERSONAS * 2 + 1`, decoupled
    from the cap because `listDir`'s `maxEntries` counts every entry
    (READMEs, subdirs); a truncated listing lands in `incompleteDirs`
    (`reason: 'listing-truncated'`).
  - A duplicate id yields a `status: 'shadowed'` ENTRY carrying
    `shadowedBy: { absPath, sourceRootId? }` — the shape
    `packages/agent/src/skills/skill-scan.ts` already uses — so the panel
    names the file that WON. Shadowed is NOT an error state: it renders
    muted (precedence, not an authoring mistake), and `incompleteDirs`
    renders amber, with destructive red reserved for "you must fix a file".

  Paired tests: `apps/desktop/src/__tests__/assistant-server/user-personas-loader.test.ts`,
  `apps/desktop/src/__tests__/ipc-domains/ipc-user-personas-handlers.test.ts`,
  `packages/settings-ui/src/__tests__/subagent-personas-settings-section.test.tsx`.
- **Per-request resolution:** `apps/desktop/src/assistant-server/request-personas.ts`
  (`resolveRequestPersonas`) merges built-ins + scanned user personas, applies
  the renderer's `subagentPersonasRequest` availability preference
  (presence-means-non-default wire field from the `subagent-personas.v1`
  preferences store — master `delegationEnabled` + per-persona disables; it can
  only REDUCE the persona set), and resolves API keys for cross-provider model
  pins via the secrets bridge onto `runtime.personaProviderApiKeys`
  (server-set; a client-supplied value is STRIPPED, same posture as
  `permissionPolicy`). A scan failure degrades to built-ins with a warn — a
  broken agents dir must not take down chat. Settings UI:
  `packages/settings-ui/src/settings/system/subagent-personas-settings-section.tsx`;
  the store is factory-reset-registered in `packages/app-state/src/factory-reset.ts`.
- **Settings states what the host enforces (BST-1727):** every loadable list
  item (`AssistantPersonaListItem`, status `'ok'`) carries `personaScope`
  of the SAME definition the child is built from — `allowedToolIds`
  (`['*']` = the host catalog permitted by its mode), declared `maxSteps`, and the
  effective `mode` (no explicit mode ⇒ `'read-only'`) — populated by
  `apps/desktop/src/ipc-user-personas-handlers.ts` for built-ins and user
  personas alike, and by the panel's own built-in fallback on web. The panel
  renders each persona's scope line in plain terms ("Read-only" / "Worker
  mode" — the mode only PERMITS edit/run tools to be declared, the declared
  list decides — "Up to N steps", with "(1 reserved for its summary)" only
  when N ≥ 2 because `buildChildIterationPolicy` reserves nothing for a
  one-step child, then the tool count with the first ids or "every tool the
  host permits, including edit and run tools" for a worker `*`; a read-only
  wildcard represented by the bridge says "every read-only tool the host
  permits"). Persona files still reject read-only and mixed wildcards; a
  description-only file keeps its curated read-only defaults. `personaScope`
  copies the declared tool ids so list consumers do not share the source
  definition's array. N is `effectiveChildStepBudget` — the one helper `delegationDescriptionForPersona`
  also uses, so the number a user reads is the number the model is told and
  the host applies. The tree-wide block ("Limits on every turn") reads
  `DELEGATION_LIMITS` directly. Paired tests:
  `subagent-personas-delegation-limits.test.tsx` mocks the constant and the
  helper with distinct values no build uses (the helper returns 3 while the
  cap is 7), so a panel that repeats the arithmetic or types the numbers
  fails; `ipc-user-personas-handlers.test.ts` pins the scope
  fields on built-in and user items; `personas.test.ts` pins the helper
  against the model-facing description. An older bridge that omits the fields
  renders no scope line rather than a guess.
