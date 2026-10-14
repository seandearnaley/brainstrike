# Workspace instructions injection — evidence

Supports `docs/agents/workspace-context.md` §
"WORKSPACE INSTRUCTIONS CONTEXT".
Read before changing AGENTS.md/AGENT.md/CLAUDE.md injection, its budgets, its read-failure discrimination, or its trust posture.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

Each mounted workspace root's top-level instructions file is auto-injected into
the assistant's system context as a PREPENDED `system` message every turn.
**Desktop-only** (needs fs + the assistant server; web has no injection path —
capability-gated, no `isElectron()` checks). Sibling to `referenced-files-context.ts`.

- **Injection** (`apps/desktop/src/assistant-server/workspace-instructions-context.ts`)
  wired at the SAME request boundary as `injectReferencedFilesContext`
  (`packages/assistant-service/src/stream-init.ts` `resolveInitialAgentStream`): referenced-files first,
  then workspace instructions LAST so the general conventions land FRONTMOST.
  Per root, first-match-wins over `AGENTS.md` → `AGENT.md` → `CLAUDE.md` at the
  root's top level, read through `readWorkspaceTextFile`'s existing
  containment/size/binary guards (NO new raw-fs read path). Headings are
  qualified by `root.displayName` (two roots that both ship `AGENTS.md` stay
  distinct). Budgets mirror referenced-files: `MAX_CONTEXT_FILE_CHARS` = 12_000
  per file, `MAX_CONTEXT_FILES_TOTAL_CHARS` = 48_000 aggregate — a HARD ceiling:
  a file that would OVERSHOOT the aggregate is counted as omitted (the injected
  total never exceeds 48_000), with an honest omission note. Truncation of an
  opted-in oversized file never splits a UTF-16 surrogate pair (a lone surrogate
  at the cut boundary is dropped). Skipped ENTIRELY for provider `'local'` (the
  built-in Gemma's whole context budget is 8,192 tokens — mirrors the
  personas/plan-mode local exclusions).
  - **Read-failure discrimination (no fabricated absence):** `findRootContextFile`
    returns a discriminated `{kind:'found'|'none'|'error'}`. Only a GENUINELY
    absent candidate (ENOENT) advances to the next name; a PRESENT-but-unreadable
    candidate (binary, over the 2 MB read cap, EACCES/EIO, containment violation,
    not-a-file) short-circuits to `'error'`. Injection LOGS a warn and omits that
    root (never a prompt note, never a silent "no file"); the Settings scan maps
    it to `status:'error'` → an "Unavailable" badge with the detail. A >2 MB
    `AGENTS.md` therefore shows as Unavailable, not silently dropped.
  - **Legacy fallback is fail-closed:** oversized opt-in is defined only for
    DB-backed roots. A DB-less legacy root (synthesized from `workspaceRootPath`,
    `rootId` = raw path) can never appear in the DB-driven Settings scan, so its
    opt-in is un-settable and its oversized file stays un-injected.

- **THRESHOLD-HYBRID policy** (product ruling — never a silent drop):
  - A file that FITS the per-file budget → auto-injected WHOLE by default (no note).
  - An OVERSIZED file (> per-file budget) → NOT injected by default; requires an
    explicit per-root opt-in. When opted in, injected TRUNCATED at the budget with
    an honest note. When NOT opted in, it is NOT injected and NO skip-note goes in
    the prompt — it is surfaced in the Settings UI as "detected but not injected
    (too large — N KB / ~M tokens)" instead.
  - A master enable toggle (default ON) covers the whole feature.
  - Dogfooding reality: this repo's own `AGENTS.md` was ~30KB (OVERSIZED) until
    the 2026-07-12 modernization split it into `docs/agents/*`; it now fits the
    per-file budget and auto-injects whole. The opt-in path remains the modal
    case for other large repos.

- **Preference** (`packages/app-state/src/stores/workspace-instructions-preferences-store.ts`) —
  persisted `{ masterEnabled: true, oversizedOptInByRootId: Record<rootId, boolean> }`
  keyed by durable DB `roots.id` (NEVER a raw path); only `true` opt-ins are
  stored. Reset via the direct-call seam in `factory-reset-helpers.ts` (mirrors
  `notification-preferences-store`, per the FACTORY RESET CONTRACT). The renderer
  attaches a plain-JSON snapshot to the request `runtimeData.workspaceInstructionsPreference`
  (contract type `WorkspaceInstructionsContextRequest`), gated to the desktop
  data-stream transport like `permissionPolicyRequest` — but this is a
  PREFERENCE, not a security boundary: the server reads it directly (no
  server-side re-derivation, unlike the permission gate). It is still parsed
  strictly — `readWorkspaceInstructionsPreference` DROPS a malformed field (a
  non-object preference, non-boolean `masterEnabled`, non-object opt-in map) with
  a warn rather than silently coercing it, then applies the fail-safe default
  (master ON, no oversized opt-ins).

- **Settings UI** (`packages/settings-ui/src/settings/system/workspace-instructions-settings-{section,category}.tsx`,
  registered in the DESKTOP page-content only) lists each mounted root's detected
  file with name, size, ~token estimate (chars/4, consistent with
  `countTokensHeuristic`), injection status, and the oversized opt-in toggle. It
  reads a per-root scan from `window.contextFiles.scan()` — IPC
  (`ipc-context-files{,-handlers}.ts`, channel `context-files:scan`, preload
  `contextFiles` bridge, capability-gated) whose main-process handler loads roots
  from the DB (`loadWorkspaceRootsFromDatabase`) and reuses the injection path's
  `findRootContextFile` (`workspace-instructions-scan.ts`) so status/oversized
  decisions are byte-identical to injection. A rejected `scan()` (DB unavailable,
  IPC failure) renders a DISTINCT, logged error state with a Retry button — NEVER
  the empty "no folders" state (which would falsely claim the workspace is empty).

- **Trust posture (accepted risk — conscious ruling):** injection is
  default-ON with NO per-root trust gate, unlike the Tool-Lifecycle Hooks
  feature (SHA-256 per-root approval). A mounted repo's instructions file
  becomes a high-authority `system` message automatically on mount — accepted
  because (a) content injection is already ungated here (`referenced-files-context.ts`),
  so this is not a new class of exposure, only default-on + automatic; and
  (b) the permission engine defaults mutation tools to `ask`, so injected text
  cannot silently drive edits/exec. The master toggle (and per-root oversized
  opt-in) are the user's off-switches. A future per-root acknowledgment of
  newly-detected files is a possible hardening, not a v1 requirement.

- **Deferred**: web (no workspace-tool bridge); prompt caching. (Mastra skills
  adoption LANDED as its own feature — see AGENT SKILLS below; the old blocker
  was resolved by wiring the skill tools through the pipeline rather than the
  Agent-level auto-add.)

When changing this flow, update this section and the paired tests
(`packages/app-state` store + factory-reset tests and `packages/settings-ui` settings-section tests;
`apps/desktop/src/assistant-server/__tests__/workspace-instructions-{context,scan}.test.ts`;
`apps/desktop/src/__tests__/ipc-context-files-handlers.test.ts`;
`packages/app-shell` request-builder test).

