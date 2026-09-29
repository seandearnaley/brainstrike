# Hook settings, root identity and convergence — evidence

Supports `docs/agents/assistant-runtime.md` § "TOOL-LIFECYCLE HOOKS (Claude-Code-style)".
Read before changing the hooks settings panel, DB-root keying of trust, or `WorkspaceRootRegistry` convergence. The fail-open closed in #1570.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 4060-4144), extracted verbatim.

**Settings + review IPC:** `hooks-settings-section.tsx` (per-root
trusted/untrusted/changed/parse-error + approve/revoke) via
`hooks:getProjectHooksForReview` IPC (`ipc-hooks.ts`) + `window.hooks` preload
bridge (capability-gated). The LIVE mounted roots are threaded from the desktop
settings page (`apps/desktop/.../settings/page-content.tsx`): it reads
`activeRootIds` + `rootDescriptors` from the file-explorer zustand store (reactive
to mount/unmount, no restart) and maps them to `HookReviewRoot`
(`{rootId, absPath, displayName}`, sidebar order) for `createHooksSettingsCategory`.
Capability-gated by construction — the WEB settings page never constructs the Hooks
category, so it needs no roots. Each row's review is fetched independently; a
transport-level bridge failure for one root renders THAT row `Unavailable` (a
structured `error` review), never a stale/empty "no hooks" lie.

**Trust is keyed by the DB `roots.id`, NOT the adapter rootId (SECURITY).** The
adapter rootId is the durable identity of a persisted mount and is reused when
the same canonical folder is picked again, while the DB id identifies the
retained indexed row. They are separate identity domains and MUST NOT be assumed
equal. The server keys trust by the DB id (its roots come from the DB
`roots` table), so the panel MUST too or revoke/approve target a dead id while the
server keeps trusting a live grant (the fail-OPEN #1570 closed). Mechanism:
- The review IPC runs in MAIN (DB access): it CONTAINMENT-checks the reviewed path
  against the mounted DB roots (realpath'd — `resolveDbRootForPath`; an arbitrary
  or symlink-escaping path is refused, fixing the old "any absolute path" read) and
  returns the resolved `dbRootId`. The panel keys status/approve/revoke by THAT id.
- `buildHookTrustRequest` (hook-trust store) is SCOPED to the currently-mounted
  roots' DB ids. The assistant wrapper resolves them via
  `window.hooks.resolveTrustedRootIds(mountedPaths)` (same main DB-id seam) and
  attests NOTHING until resolved / if the resolver is absent (fail closed). A
  disconnected root's grant is therefore never presented to the server → its hooks
  fail closed. The disconnect-severs property is additionally SERVER-ENFORCED:
  `fs:removeRoot` asks the main-process `WorkspaceRootRegistry` to remove the
  mount and converge the DB to the complete remaining mounted-path set. The
  persisted registry write happens first, but a DB failure rolls it back before
  the IPC rejects; the capability and renderer projection remain mounted. Every
  server-side consumer of `loadWorkspaceRootsFromDatabase` (workspace tools,
  hooks review containment, context-files scan, user /commands, checkpoint
  revert) serves only `status='live'` rows. `reconcileRoots` (app-shell)
  restores `status='live'` on remount — it path-matches the KEPT row, so
  disconnect ≠ delete and a re-add resumes without re-indexing
  (`workspace-roots.integration.test.ts` proves the full cycle). The renderer
  attestation scoping above remains as defense-in-depth: a renderer that skips
  scoping can at most re-run byte-identical already-approved hooks, never new
  content (same-process trust model + the server's authoritative disk re-hash).
- CONVERGENCE (do not relitigate): `WorkspaceRootRegistry` serializes add,
  restore, preference, and disconnect transitions. `rootsList` is its persisted
  mount inventory; only successfully mounted, persisted presentation paths are
  supplied to `markRootsDisconnectedExcept`. An EMPTY mounted set is meaningful
  and demotes every comparable path-backed row. Web FSA rows remain outside this
  desktop comparison.
- Restore never guesses. Malformed `rootsList` JSON or shape THROWS before DB
  convergence. A missing or transiently unmountable folder remains persisted,
  is returned as `permissionState:'unknown'`, and is excluded from the mounted
  DB authorization set until a later restore succeeds. Boot-time DB convergence
  remains allow-on-fault with an ERROR log so a transient DB failure does not
  erase the Explorer restore; explicit disconnect remains fail-closed with
  storage rollback.
- Renderer state is a projection. `removeRootDirectory` awaits the authoritative
  IPC transition and changes no renderer/store state when it rejects. The old
  best-effort compensation loop and independent `lastFolderPath` root writer no
  longer exist. `lastFolderPath` is only a preference for an already-persisted,
  mounted root.
- The store bumped to v2: pre-v2 adapter-keyed approvals are DROPPED at migration
  (unremappable without DB access → re-approval is the safe direction; mirrors the
  permission-policy v2 security bump). Factory reset clears the store unchanged.

Live-loop proofs (real Agent + real `applyToolHooks`, no stream mocks):
`packages/agent/src/__tests__/mastra-tool-execution.integration.spec.ts` (block / allow +
PostToolUse context / runtime-threaded / no-runner regression / runner-fault).
Server composition: `apps/desktop/src/__tests__/assistant-server/hooks/`.
Run-verdict protocol: `hooks/run-verdict.test.ts` (strict parse + bounded scan),
the verdict cases in `hooks/server-composition.integration.test.ts` (real Stop
hooks: record-before-finish ordering, finally-path, malformed→notice,
recorder-fault, non-Stop guard, last-hook-wins), and
`apps/desktop/src/__tests__/assistant-server/hook-run-outcome.integration.test.ts`
(real-PGlite precedence: hook lands / never over user / user over hook /
unknown-run throws).

**Deferred (documented follow-ups):** SessionStart/SessionEnd/Notification
wiring; Stop auto-continue; full hooks.json
editor UI; rendering the fetched `content` in-panel (approval is hash-only today);
a refetch on approve/revoke/refocus (a disk edit after the fetch shows a stale
badge until reopen — fail closed server-side); `<userData>` vs home-dotfile
decision.

When changing this flow, update this section and the paired tests.
