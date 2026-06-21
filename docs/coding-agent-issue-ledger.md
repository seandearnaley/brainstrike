<!--
  AUTHORITATIVE BURN-DOWN LIST for the coding-agent phase 1-8 workflow.
  Phases 1-8 are NOT considered finished until every §2 Blocker (mustFixBeforeDone) is resolved.
  Generated 2026-06-20 by a 23-agent audit workflow (11 discovery dimensions -> adversarial verify -> synthesis):
    115 candidates -> 79 verified-real, 16 already-fixed, 20 dropped -> 29 must-fix blockers.
  Audited at HEAD dc06a8611; the two in-flight fixes (#1283 @file, #1284 hidden-host launch-mode) have since
  merged (HEAD 263c2aa65). Keep this file updated as items are resolved (check them off / move to Recently Resolved).
-->

# Coding Agent (Phase 1-8) Issue Ledger

> Branch: `feat/coding-agent` · HEAD `dc06a8611` (39 commits ahead of `main`) · Audit date 2026-06-20
> Source: 79 verified-real findings + 16 recently-resolved, deduped across 6 audit dimensions (P1-approval, P2-edit-security, P3-search-shell, P4-diff-terminal-git, P5-om-cost, P6-slash, P7-subagents, P8-notifications/hooks/oauth, infra/CI, web-desktop-parity, tests/live-loop).

## 0. Burn-down progress (live)

Blockers cleared since the audit (merged to `feat/coding-agent`):

- **P3** Regex grep patterns validated at schema parse (fail-fast) — **#1285**.
- **P2** `executeCommand` description honesty — fixed all **4** stale copies (model-facing `default-instructions.ts` + `tool-schemas-display.ts` + `tool-descriptions.ts` + comment), not just the flagged one — **#1285**.
- **P5** Durable-usage capability shape-guard (non-string `bridge.url`) — **#1286**.
- **P5** Root `display_name` byte-cap (SQL `SUBSTR` + mapper) — **#1286**.
- **P5** OM negative-token rejection test (DB-CHECK premise was wrong; the parser already guards) — **#1286**.
- **P4** Git untracked-diff symlink containment — **#1287** + **#1288** (refined after a Codex review: validate the parent chain, allow safe leaf symlinks which git renders as `120000` link-text, not content).
- **P4** Git diff state keyed by `activeRootId` (cross-root stale diff) — **#1290**.
- **Infra** Web E2E GREEN on `feat/coding-agent` — **#1292**: (a) node-pty (desktop-only native) can't compile in the toolchain-less Playwright container → scope the 3 containerized installs `--filter '!@brainstrike/desktop'`; (b) the BUILT web renderer's `#root` stayed empty from a circular chunk-init TDZ (`defineContextAction` split from its module-init callers) → co-locate the context-action system into one chunk. **This CORRECTS the audit's "Infra `NODE_ENV` define" item — that was a MISDIAGNOSIS**: React already builds production and the Radix Title/Description warning is unconditional, so the real ⌘K/⌘P fix was DialogTitle/Description on the cmdk dialogs (**#1291**), not a NODE_ENV define. `task_dd059475` dismissed.
- **P1** Web per-call tool-approval resume (501 → real resume) + "ask" tools SUSPEND instead of silently omitting — **#1293** (in-process in-memory PGlite Mastra store in the Vite Node server; both turn + resume routed through `buildWebAssistantStream`; real-PGlite integration test + flipped route/middleware unit tests). **The two P1 approval TEST-gap items in the audit are STALE**: `assistant-tool-approval-notice.test.tsx` already covers approve/decline→mutation, and `mastra-tool-approval-suspend.spec.ts` already proves real-loop suspend→approve→execute→continue.

**Open blockers remaining: ~16 of 29.** Next up: P3 Windows execute-cwd containment (needs Windows CI to verify escapes), P4 terminal/git E2E (zero coverage), P2 web FS-Access write, then **P7 subagents** (the big build, not started). P8/OAuth parked behind the legal gate.

## 1. Definition of Done

Phases 1-8 are **DONE** when every item in **§2 Blockers (`mustFixBeforeDone`)** is resolved, verified by real **LIVE-loop** tests (per the AGENTS.md invariant — mocked tests once stayed green while real Mastra tool calling broke), and with security-critical edit/shell/diff paths proven path-contained by executing escape attempts, not just reading code.

**Current high-level status:**
- **P0** (event-seam ADR + pricing): DONE.
- **P1** (permissions engine, allow/ask/deny, enforce-on-by-default, YOLO, session grants, per-call approval suspend/resume): DONE on desktop AND web (**#1293** — web resume + ask-suspend via an in-process PGlite Mastra store in the Vite Node server; dev/preview-only). Approval-UI + real-loop resume coverage already present (`assistant-tool-approval-notice.test.tsx` + `mastra-tool-approval-suspend.spec.ts`).
- **P2** (edit tools, fuzzy string_replace, re-index-on-edit, path containment): DONE on desktop; **web FS-Access write NOT implemented** despite phase description claiming it. Schema/byte-cap drift + write-symlink test gaps.
- **P3** (shell/glob/grep superset, web_search): DONE; regex-validation, Windows-cwd containment test, live-grep cap, stale tool description gaps.
- **P4** (diff/terminal/git, desktop-only): DONE; git untracked `--no-index` symlink containment bypass, diff-state-not-keyed-to-root bug, zero E2E coverage.
- **P5** (OM meter + token/cost, durable usage): DONE; several validation/honesty gaps (zero-token rows, OM token-sum, displayName byte cap, BigInt overflow, capability type-guard).
- **P6** (slash/CmdK/CmdP/@file): IN PROGRESS — `!shell` macro intentionally deferred pending the P1 suspended-run seam (now landed); web tool-availability falsely advertised.
- **P7** (subagents): NOT STARTED — zero implementation across all registries.
- **P8** (notifications/hooks/MCP[SKIP]/OAuth[LEGAL GATE]): NOT STARTED.

---

## 2. Blockers (must-fix before phase 1-8 is finished)

### P1 — Permissions & Approval

**[P1][incomplete-feature] Web has no per-call approval resume — returns HTTP 501.**
Evidence: `apps/web/src/app/api/assistant/route.ts:107-135` `resolveToolApprovalResponse` returns `501 tool_approval_resume_unsupported`; mirrored in `apps/web/src/assistant-stream-helpers.ts:174-199`. The UI (`assistant-tool-approval-notice.tsx:182-228`) collects decisions and posts them, but the web route never calls `streamMastraToolApprovalAction` (desktop `apps/desktop/src/assistant-server.ts` does). VERIFIED.
Action: Implement web resume: call `streamMastraToolApprovalAction` with the same runtime/memory/storage context as a normal request; stream the result through the data-stream response, not a JSON error.

**[P1][incomplete-feature] Web "ask" decisions silently degrade to omit (no workflow storage to suspend).**
Evidence: `apps/web/src/app/api/assistant/route.ts:59-62` forwards the policy; `permission-policy-request.ts:91-107` builds the trusted snapshot server-side. But web passes no `MastraCompositeStore` to `toAiSdkStyleStream`, so `agent-runtime.ts:229-247` fail-safe OMITS ask tools (vs desktop keeps + suspends). Safe but a parity gap that violates UX expectations; dedupe with the resume blocker above.
Action: With web resume (above), add IndexedDB-backed workflow storage so ask tools suspend rather than omit; OR explicitly document the web limitation in the permission UI (no-silent-fallbacks: the omission must be surfaced). Recommend the former.

**[P1][test-gap] No test that the approval-request UI panel renders and the approve/decline buttons fire the mutation.**
Evidence: `packages/app-shell/src/__tests__` — only `root-registry.test.ts` / `use-roots-reconciliation.test.tsx` mention "permission"; none test the approval panel or button → `streamMastraToolApprovalAction` routing.
Action: Add `packages/app-shell/src/__tests__/use-tool-approval.test.ts` (mock stream emits `tool-approval-required`, assert panel renders, approve/decline calls the action with correct params) + a desktop E2E `apps/desktop/e2e/tool-approval-flow.desktop.test.ts` driving a real agent stream and UI click.

**[P1][test-gap] Approval mutation path not exercised end-to-end (existing test mocks the resume).**
Evidence: `packages/agent/src/__tests__/mastra-streaming.spec.ts:1108-1165` sets mock stream parts and calls `streamMastraToolApprovalAction` directly, asserting the mock was invoked — it never drives the real `requireToolApproval:true` → pause → `approveToolCall` → resume continuation. (Note: `mastra-tool-approval-suspend.spec.ts` DOES prove suspend/skip via a real loop — see §6 — but the *resume-continues-the-real-agent* leg is still mocked.)
Action: Add a non-mocked agent test (or desktop E2E) that drives the real loop with a real Memory store through resume.

### P2 — Edit Tools & Path Containment

**[P1][gap] Web FS-Access write is unimplemented — but the phase claims it DONE.**
Evidence: `packages/types/src/file-system.ts:249-360` (`FileSystemAdapter`) declares no `writeFile`/`writeFileByPath`; `packages/file-system/src/adapters/web-adapter.ts:517-634` is read-only. No `apps/web` write tool, no `createWritable` integration.
Action: Implement `webAdapter.writeFile`/`writeFileByPath` via `FileSystemFileHandle.createWritable()`, byte-cap to the 2MB desktop limit, document that the browser sandbox replaces desktop path-containment, and add the paired web write tests (next item). OR re-scope: move web write to P3/future and correct AGENTS.md phase status.

**[P1][test-gap] No web write tests (P2 platform parity blocked on the unimplemented write).**
Evidence: all write tests (`write-workspace-file-live-loop.test.ts`, `reindex-on-edit.integration.test.ts`) are Node/desktop-only; `packages/file-system/src/__tests__/web-adapter.test.ts:1-200` is read-only.
Action: After web write lands, add web-adapter tests: new-file write, overwrite, `writeFileByPath` handle-resolve, maxFileSize reject, permission-denied — mirroring desktop structure.

**[P2][docs] executeCommand tool description is stale — claims "no interactive approval prompt yet".**
Evidence: `packages/assistant-contract/src/tool-schemas-display.ts:711` still reads *"Permission gating is available but OFF... there is no interactive approval prompt yet"* — but `apps/desktop/src/assistant-server/assistant-tools.ts:2143-2147` documents the real suspend-for-approval flow. VERIFIED (the false text ships to the model). Marked `mustFixBeforeDone:true` in source dimension — model-facing guidance must not lie.
Action: Replace the stale sentence with: *"When enforcement is enabled and execute resolves to ask (the default), the tool suspends for per-call approval before execution: approve runs the command, decline skips it."*

### P3 — Search, Shell, Glob

**[P1][bug] Regex grep patterns are not validated at schema parse — fail-late at execution.**
Evidence: `packages/agent/src/tools/schemas.ts:465-518` `GrepSearchInputSchema` has `pattern.min(2)` but no regex validity check; failure surfaces only at runtime in `packages/db/src/search/grep-search-service.ts:91-102`. Violates fail-fast / no-silent-fallbacks.
Action: Add a `.refine()` that `new RegExp(pattern)` inside try/catch when `isRegex===true`, rejecting invalid patterns at parse.

**[P1][security] No path-containment test for Windows execute-command cwd (case-insensitive / UNC / junction).**
Evidence: `apps/desktop/src/assistant-server/execute-command-tool.ts:190-195` uses `path.relative()` + `startsWith('..')`; no handling/tests for Windows case-insensitive FS, UNC `\\server\share`, or junctions-to-junctions. Security-critical containment must be proven by executing escapes.
Action: Lowercase both canonical paths before compare on Windows; after `realpath`, assert resolved == root (case-insensitive) or proper child with no `..`; add a Windows containment suite (UNC/junction/case-mismatch escapes).

**[P2][incomplete-feature] Live-grep candidate cap (1500) can silently drop fresh edits on large repos.**
Evidence: `apps/desktop/src/assistant-server/live-grep.ts:47-50` `DEFAULT_MAX_LIVE_CANDIDATE_FILES=1500`; `capHit` surfaced in `liveNote` but a just-edited file beyond the cap won't appear fresh — the "live finds fresh edits" contract is violated silently for broad patterns. (Source flags `mustFixBeforeDone:true`.)
Action: Either raise the cap (e.g. 5000) with perf/memory test coverage, OR document in the grep schema + default-instructions that broad patterns on large repos may exceed the live cap and recommend scoping `filePaths`.

### P4 — Diff / Terminal / Git (desktop-only)

**[P1][security] Git untracked `--no-index` diff follows symlinks outside the root (containment bypass).**
Evidence: `git-service.ts:443-452` — `resolveContainedPathArg()` (`:346-364`) accepts relative paths but for `untracked=true` runs `git diff --no-index -- /dev/null pathArg`, which does NOT respect cwd scope; a relative symlink inside the root pointing elsewhere is diffed against an arbitrary file. Security-critical.
Action: For untracked diffs, `lstat`+`readlink` the resolved absolute path and reject if it's a symlink or its real target escapes cwd (safest: reject symlinks at `resolveContainedPathArg`).

**[P2][bug] Resolved diff state not keyed to `activeRootId` — wrong-root diff can render on root switch.**
Evidence: `git-panel.tsx:42-45,251-269,282` — `ResolvedDiff.key` is `path:staged:untracked` only (no rootId); switching root mid-load can match same-path diff across roots, bypassing root-scoped containment.
Action: Add `rootId` to `ResolvedDiff`, include `activeRootId` in the request key and gating check.

**[P1][test-gap] Zero E2E coverage for terminal and git panels.**
Evidence: `apps/desktop/e2e` has no `*.desktop.test.ts` for git/terminal (only unit/component + IPC-handler tests); `preload-runtime-contract.test.ts` covers channel constants, not flows.
Action: Add `git-panel.desktop.test.ts` (status/diff/stage/unstage/commit/push/pull in a temp repo, multi-root switch during diff load) and `terminal-panel.desktop.test.ts` (create/write/output/resize/exit, orphan cleanup on window close).

### P5 — OM Meter & Token / Cost

**[P1][incomplete-feature] No byte-cap on root `display_name` in cross-root aggregation.**
Evidence: `packages/app-shell/src/assistant-memory-repository.ts:153-166` `CROSS_ROOT_USAGE_AGGREGATION_SQL` reads `r.display_name` with no `SUBSTR`/`CAST`; `mapCrossRootUsageRow`→`nullableString` (`:556`) imposes no length bound — an arbitrarily large name renders in the cost panel.
Action: `SUBSTR(r.display_name,1,512)` in SQL, length guard in the mapper, and a DB `CHECK (octet_length(display_name) <= 512)`.

**[P1][bug] Durable-usage capability accepts a non-string `bridge.url`.**
Evidence: `packages/app-shell/src/assistant-durable-usage-capability.ts:19-26` returns `Boolean(bridge && (bridge.url || bridge.getUrl))` — `bridge.url = {}` passes, then downstream URL use throws. Capability-gating failure (gate on the real capability, not a truthy proxy).
Action: `Boolean(bridge && ((typeof bridge.url==='string' && bridge.url.length>0) || typeof bridge.getUrl==='function'))`.

**[P1][test-gap] OM schema-projection test doesn't assert the `value >= 0` CHECK constraint is enforced.**
Evidence: `packages/db/__tests__/mastra-om-schema-projection.test.ts:88-133` checks column names/nullability only; never inserts a negative-token row to prove rejection. If `@mastra/memory` drops the CHECK, negative tokens pass silently.
Action: Add `it()` asserting INSERT of `observationTokenCount:-1` / `totalTokensObserved:-1` rejects with a constraint violation.

### P6 — Slash / Palette / Macros

**[P1][incomplete-feature] `!shell` macro not built (P6 deliverable) — deferred pending the now-landed P1 suspended-run seam.**
Evidence: `packages/ui/src/assistant-ui-panel/slash-commands.ts:1-61` has the slash machinery but no `!shell` parser/executor; deferral recorded in `docs/mastra-code-port-synthesis-2026-06-19.md:451`. The blocking P1 approval-suspend seam has now landed, so the deferral reason is resolved.
Action: Decide P6 completion criteria. If `!shell` is in P6 scope, implement the macro parser → `executeCommand` invocation gated through the approval flow, with a live-loop test. If deferred, add an explicit TODO in `slash-commands.ts`/`slash-command-source.ts` referencing the synthesis doc and mark P6 "complete except !shell (intentional)". Dedupe: same root issue reported under P6 and tests dimensions.

**[P1][incomplete-feature] Web native tools all hardcoded `isLocalRuntimeRunnable:true` — falsely advertise desktop-only tools.**
Evidence: `packages/app-shell/src/assistant-ui-panel-wrapper.tsx:707-729` (line 724) maps every native tool runnable; `updateWorkspaceContextSelection` + `updateWorkspaceTapestrySelections` are desktop IPC-only (`assistant-tools.ts`) with no web backend. `buildLocalToolDefinitions` (`local-runtime-tool-definitions.ts:92-119`) fails gracefully at exec time, but the menu lies about availability (capability-gating violation).
Action: Add `webAvailable?: boolean` to `NativeToolDefaultMetadata`; mark the two selection-mutation tools `webAvailable:false`; filter the map to set `isLocalRuntimeRunnable:false` on web for them. Dedupe with the parity-doc item below.

**[P1][docs/test] No documented or tested web-vs-desktop native-tool parity boundary.**
Evidence: `packages/assistant-contract/src/tool-categories.ts:113-188` has no platform metadata; no test validates which tools execute on web.
Action: Add the `webAvailable` field + `packages/ui/src/__tests__/assistant-tool-parity.test.ts` asserting capability-gated tools are `isLocalRuntimeRunnable:false` on web. (Resolved jointly with the previous item.)

### P7 — Subagents (NOT STARTED — entire phase is a blocker)

> All P7 items share one root: zero implementation. `grep -r subagent` across `packages/`+`apps/` returns nothing; `ASSISTANT_RUN_EVENT_KINDS` (run-events.ts:3-26) has 23 kinds, none `subagent.*` (VERIFIED); `NATIVE_TOOL_DEFAULTS` has no `spawnSubagent`. Sequenced PRs 7.1-7.4.

**[P1][incomplete-feature] PR-7.1: Run-event taxonomy lacks `subagent.*` kinds + `parentToolCallId`/`parentRunId` metadata + hydration.**
Evidence: `packages/assistant-contract/src/run-events.ts:3-26` (VERIFIED) and metadata type (~`:48`) have no parent fields.
Action: Add `subagent.started/step.started/step.finished/tool.completed/tool.failed/finished`; extend `AssistantRunEventMetadata` with optional `parentToolCallId`/`parentRunId`; add a real PGlite `mastra_messages` hydration fixture; wire through `DataStreamMapper`.

**[P1][incomplete-feature] PR-7.2: No `brainstrike.spawnSubagent` tool, no PersonaConfig registry, multi-registry wiring absent.**
Evidence: `tool-categories.ts:136-253` (14 entries, no spawner); no schema in `schemas.ts`, no display entry, no factory in `assistant-tools.ts`, no guidance in `default-instructions.ts`; no PersonaConfig in preferences.
Action: Full multi-registry wiring (schemas.ts → tool-categories.ts → tool-schemas-display.ts → assistant-tools.ts → default-instructions.ts) for `spawnSubagent` (`{prompt, personaId?, maxSteps?, tokenBudgetLimit?}`, category action, requiresApproval, risk execute); add PersonaConfig store + depth/concurrency caps; run knip + both lane checks.

**[P1][incomplete-feature] PR-7.3: No RAG-native explore persona (queryEmbeddingSpace + grepSearch + hybrid, keyless local).**
Evidence: read-only tools exist (`tool-categories.ts:206-226`) but no persona wires them in a constrained local-LLM context.
Action: Define BuiltinPersona enum; explore persona whitelists read-only tools, defaults to keyless local-llm-host ($0 cost, no silent fallback); integration test asserts it calls query+grep and never write/edit/execute.

**[P1][incomplete-feature] PR-7.4: No subagent activity UI cards / nested run-event grouping.**
Evidence: `tool-activity.ts` + `assistant-activity-group.tsx` have no `parentToolCallId` grouping or subagent card.
Action: Add `SubagentActivityCard` (grouped by `parentToolCallId`, persona/prompt/nested calls/summary, failure reasons); route subagent groups in `assistant-activity-group.tsx`; hydration fixture proves reload parity; CDT-verify.

**[P1][test-gap] No LIVE-loop test for subagent spawn/suspend/resume/multi-step (mandated by the AGENTS.md invariant).**
Evidence: `packages/agent/src/__tests__` has no `*subagent*` file.
Action: Add `mastra-subagent-spawning.spec.ts` (real Mastra child agent via `createMastraAgentRuntime` with filtered tools): events bubble to parent; depth cap throws on 4th level; concurrency cap; tool-filter excludes execute even when policy allows; child timeout → `subagent.failed`.

**[P1][incomplete-feature] PR-7.2 multi-registry wiring is the documented silent-break class — partial registration must be caught by knip + both lane checks.**
Evidence: same gaps as PR-7.2; this is the #1101-pattern restated as a release gate.
Action: Treat as the acceptance gate on PR-7.2 (all 5 registries + knip + `test-lanes.mjs`/`coverage-lanes.mjs` green). Dedupe with PR-7.2.

### P8 — Approval/Run-Event Producers (the one P8 item gating earlier phases)

**[P2→blocker][incomplete-feature] No `approval.*` run-event kinds emitted (cross P1/P8).**
Evidence: `run-events.ts:3-26` has no `approval.requested/approved/declined`; `data-stream-mapper.ts handleToolApprovalRequired` and `agent-runtime.ts streamMastraToolApprovalAction` emit no run-events. Marked `mustFixBeforeDone:true` — approval decisions are invisible to persistence/notification consumers.
Action: Add the three kinds; emit `approval.requested` after the UI chunk and `approval.approved/declined` after the decision; add a transient hydration fixture (no replay on reload).

### Infra / CI

**[P1][bug] Desktop renderer build ships dev-mode React/Radix — no `NODE_ENV=production` define.**
Evidence: `apps/desktop/vite.config.mts:388-392` defines only `EMBED_QUEUE_ENABLED` + `process.versions`, NOT `process.env.NODE_ENV` (VERIFIED); the Build job (`test.yml:272`) runs `TAILWIND_DEBUG=1 pnpm run build` with no `NODE_ENV`, defaulting to development. Dedupe with the next item (same root: build-job env).
Action: Set `NODE_ENV=production` in the Build job AND add `'process.env.NODE_ENV': JSON.stringify('production')` to the desktop Vite `define` block.

**[P1][infra] Build job artifacts built in `development`, consumed by web-E2E running in `production` (env mismatch).**
Evidence: `test.yml` coverage(:208)=test, web-e2e(:323)=production, desktop-e2e(:369)=test; Build(:272) sets none. Web E2E consumes dev-built artifacts under production runtime.
Action: Set `NODE_ENV=production` on the Build job so downstream jobs get consistent artifacts. (Resolved jointly with the item above.)

**[P2][infra] Desktop file logging is unbounded — no rotation/cap (potential multi-GB log growth).**
Evidence: `apps/desktop/src/main.ts:150` single fixed `brainstrike.log` with `append:true`; `packages/utils/src/logger.ts:581-595 createFileTransportTarget` sets no `maxsize`/`maxFiles`. Source flags `mustFixBeforeDone:true`.
Action: Configure rotation (pino-roll or maxBytes/maxFiles, e.g. 50MB × 5), document the policy.

---

## 3. Nice-to-have / post-1-8 polish

- **[P2][P2 tech-debt] Schema byte-cap drift:** `schemas.ts:159-164` allows 8M UTF-16 code units while desktop enforces 2MB UTF-8 (`assistant-tools.ts:118`); worst-case emoji → 32MB before the byte check. Tighten schema max to ~2.5M and add a boundary test.
- **[P2][P2 test-gap] No write-with-symlink-parent escape test** (read has one at `assistant-tools.test.ts:135-167`); add a writeWorkspaceFile mkdir-intermediate symlink TOCTOU test.
- **[P2][P2 test-gap] `MAX_FILES_WALKED_PER_ROOT=50000` (`workspace-file-walk.ts:17`) has no `scanLimited` integration test.**
- **[P2][P3] globWorkspace scan-cap hint lacks a concrete narrowing example** (`glob-workspace-tool.ts:125-131`).
- **[P3][P3] execute-command cwd error message doesn't mention symlink resolution** (`execute-command-tool.ts:190-199`).
- **[P2][P3 bug] Windows `ComSpec` used without existence validation** (`execute-command-tool.ts:46-52`) — validate the path, fall back to `cmd.exe` only if unset/invalid.
- **[P2][P3 bug] Glob root-anchor stripping untested for negation patterns** (`glob-workspace-tool.ts:55-60`) — add `!/src/**` etc. unit tests.
- **[P2][P3 test-gap] No shell-injection assertions** (`$()`, backticks, `|`, `>`) in `execute-command-tool.test.ts` (uses `-c command` verbatim — confirm args aren't shell-reinterpreted).
- **[P2][P4 test-gap] Add git/terminal to `startup-bridge-contract.test.ts` REQUIRED_METHODS or log clearly when optional bridges are absent** (`preload.ts:1058,1082`).
- **[P2][P5 bug] `recordRunUsage` permits a zero/zero usage row** (`assistant-memory-repository.ts:1533-1553`) — reject `inputTokens===0 && outputTokens===0`.
- **[P2][P5 bug] OM parser doesn't assert `totalTokensObserved >= observationTokenCount`** (`assistant-om-segment.ts:71-77`).
- **[P2][P5 bug] Cross-root cost may cache the first (NULL) displayName for a rootId** (`assistant-cross-root-cost.ts:62-108`) — re-resolve best name after aggregation.
- **[P2][P5 bug] `requireNonNegativeInteger` lacks a `MAX_SAFE_INTEGER` overflow guard for `SUM(...)::bigint`** (`assistant-memory-repository.ts:159-160,431`).
- **[P2][P5 bug] Usage-write failures logged but not surfaced** (`assistant-ui-panel-wrapper.tsx:1285-1289`) — toast on `recordRunUsage` reject.
- **[P2][P5 docs] `buildContextBudgetNote` doesn't clarify the figure is the effective (post-output-reservation) budget** (`default-instructions.ts:3-8`).
- **[P2][P5 test-gap] No Mastra schema-drift / backward-compat hydration test** for old-version persisted rows (`mastra-memory-persistence.spec.ts`).
- **[P2][P4 tech-debt] BST-493: local-LLM manifest integrity verification disabled** (`local-llm-backend.ts:40-52`, `verifyModelIntegrity` throws `integrity_verification_disabled` — VERIFIED). Restore SHA-256 manifest verification "before next release" per the TODO.
- **[P2][P1 test-gap] Mocked Mastra streaming tests dominate; add gated real-provider integration tests** (`mastra-streaming.spec.ts:48-69` mocks `createProvider` for all providers).
- **[P3][P1 test-gap] Guard-timeout tests use fake timers only** (`guard-tool-execution.spec.ts:25-80`) — add real-timer variants.
- **[P3][P1 test-gap] Tool-loader has no critical-vs-conditional budget-exhaustion parity test** (`tool-loader.spec.ts:79-224`).
- **[P2][P1-P6 test-gap] No end-to-end coding-agent flow E2E** (read file → return excerpt → context selection → approval UI → shell exec); `apps/desktop/e2e` lacks it.
- **[P2][P1 test-gap] No built-mode (production bundle) E2E for approval/permission UI** — catches bundler regressions like #1280/#1281 that only surface in built mode.
- **[P2][web-parity] Local-runtime tool gap surfaces only at generation time on web** (`local-runtime-tool-definitions.ts:92-119,178-180`) — surface the "local models on web don't support tools" limitation before generation.
- **[P2][P7 incomplete] Subagent runs have no DB schema / parent-run tracking** (migrations 046/047 lack `parentRunId`/depth) — defer until PR-7.2; needed for cost honesty (no double-counting).
- **[P2][P7 gap] Web local-chat has no subagent seam** (LocalRuntimeChat, no server loop) — capability-gate `spawnSubagent` off on web local with an explicit error; document as known limitation.
- **[P3][P6 tech-debt] Migration 048 trigram index unverified by EXPLAIN/usage test** (`048-file-records-name-trgm.ts`).
- **[P3][P6/infra tech-debt] Vite source-alias (src) vs dist contract (TDZ avoidance + worker-bundling) is comment-only, not centralized in AGENTS.md.**
- **[P2-P3][infra] Misc CI hygiene:** web full-regression nightly-only (document the gate split + add a nightly-health dashboard); desktop-E2E `NODE_ENV=test` vs web `production` divergence; desktop has no perf E2E lane; lane-registry validation is db-only; no build-warning monitoring; `--concurrency=4` undocumented; optimizeDeps `transform.define` web-only.

---

## 4. Process gates (human decision required)

- **[P8.4 OAuth — LEGAL GATE]** `docs/coding-agent-pr-plan-2026-06-19.md:128`; zero OAuth implementation; no `LEGAL.md`/sign-off file. **DO NOT START without explicit legal sign-off** (ToS review). Create `docs/OAUTH_LEGAL_REVIEW_GATE.md`, add a `legal-gate::oauth` blocking label, and only on sign-off proceed (safeStorage credential type, provider-factory `credentialResolver`, PKCE, anthropic-beta header-merge test, SECURITY.md update).
- **[P6 scope decision]** Decide whether `!shell` is in-scope for declaring P6 DONE (now-unblocked) or explicitly deferred — see the P6 blocker.
- **[P2 scope decision]** Decide whether web FS-Access write is P2-DONE scope or moves to a later phase; correct AGENTS.md/phase status either way (it currently claims DONE while unimplemented).
- **[P8.1/P8.2 not started]** Notifications and Hooks are unstarted (`run-events.ts` has no notification/hook kinds; no hook files). Not phase-1-8 blockers per the roadmap but require a go/no-go before P8 is declared.
- **[P8.3 MCP — intentionally SKIP]** Confirmed sound: brainstrike's MCP (`mcp-loader.ts`, `ipc-mcp.ts`, `mcp-banner.tsx`) is already strong; defer/skip is a decision, not a defect.

---

## 5. Recently resolved (this session)

- **#1280** — slash-command Fast-Refresh "Rendered fewer hooks" dev-server crash (hook aliasing).
- **#1281** — built-renderer chunk-init TDZ.
- **#1283** — empty `@file` mentions (RootIdentityProvider absent → verified-membership fallback).
- **#1284** — hidden hosts loaded the dev URL in built mode (`loadWindow` now resolves by launch mode) — VERIFIED at HEAD `dc06a8611`.
- **P1 PASS** — "ask" suspends for approval via the real Mastra loop (`mastra-streaming.spec.ts:972-1019`, `mastra-tool-approval-suspend.spec.ts:331-404`).
- **P1 PASS** — server-side risk classification is not client-spoofable (`permission-policy-request.ts:101` builds `riskByTool` server-side; snapshot never carries it).
- **P1 PASS** — "deny" tools omitted from the runtime map (`permission-tool-gate.ts:212-220`).
- **P1 PASS** — fail-safe omission when no workflow storage to suspend (`agent-runtime.ts:217-261`).
- **P1 PASS** — per-tool `requireApproval` so allowed tools run free (`permission-tool-gate.ts:228-230`).
- **P1 PASS** — enforce-on-by-default security fix shipped (`permission-policy-store.ts:155`, STORE_VERSION 2).
- **P1 PASS** — enforce-off → no snapshot sent (opt-in gating proven in `permission-policy-request.spec.ts:302-326`).
- **Non-issue** — git-panel `loadDiff` rejection IS caught (try/catch `use-git-panel.ts:252-264`).
- **Non-issue** — cost panel reads `useCrossRootCost()` directly by design (`cost-aggregation-panel.tsx:135-137`).
- **Non-issue** — context meter stays silent until budget available (`context-usage-meter.tsx:187-200`).
- **Non-issue** — quick-open `rootLabel` fallback present (`use-quick-open-files.ts:98`).
- **Non-issue** — command-palette/quick-open hotkey cleanup correct (no HMR listener leaks).
- **Non-issue** — turbo tsconfig glob + coverage-lane double-registration already covered/documented.

---

## 6. Maintainer addendum (2026-06-20 session)

Items tracked via background-task chips this session (one-click spin-off to their own worktree):
- **`task_dd059475`** — desktop renderer `NODE_ENV=production` define (same root as the §2 Infra blocker "Desktop renderer build ships dev-mode React/Radix"). The audit additionally tied it to the CI Build-job env mismatch (`test.yml:272`) — fix both together.
- **`task_dc83b2dc`** — lift `RootIdentityProvider` to wrap the assistant subtree, deleting the `@file` verified-membership fallback and its KNOWN LIMITATION (a MOUNTED desktop root whose `roots.id != adapter rootId`, path-matched by `reconcileRoots`, is dropped — logged once-per-id but unresolved). Not a §2 blocker (the current profile has no such divergence, verified live), but the durable correctness fix.

Known web parity limitation (related to the §2 P1 web-approval blockers): **WEB built-in local-LLM turns** still run through the in-renderer `LocalRuntimeChat` (session-only — no Mastra loop, no history adapter, no durable usage), while **desktop** local runs through the real loop. This is the documented `LOCAL LLM ARCHITECTURE` gap in CLAUDE.md; surface/close it when the web-approval-resume work lands.
