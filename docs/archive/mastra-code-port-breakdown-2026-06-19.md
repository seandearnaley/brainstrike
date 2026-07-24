# Reverse-Engineering Mastra Code → BrainStrike: Complete Porting Breakdown

> Source: `https://github.com/mastra-ai/mastra-code-ui` (cloned + analyzed 2026-06-19).
> Produced by a 14-domain multi-agent reverse-engineering workflow; every claim traced to
> real files in both repos. This doc is the canonical plan for turning BrainStrike's
> read-only RAG assistant into a full coding agent by selectively porting mastra-code patterns.
>
> **Companion:** `docs/mastra-code-port-synthesis-2026-06-19.md` holds the full RE playbook,
> the refined **8-phase** dependency-ordered roadmap (supersedes the 6-phase sketch in §3
> below), the effort/risk/value matrix, the web/desktop split, and the differentiation
> strategy. Read that for execution sequencing.

---

## 0. The one decision everything hinges on

**mastra-code-ui is a thin Electron shell. The agent intelligence is bought wholesale**
from `mastracode@0.5.1` + `@mastra/core@1.9.0`'s `/harness` export.
`createMastraCode({cwd, extraTools})` (called once at `main.ts:82`) returns a fully-wired
`{ harness, mcpManager, hookManager, resolveModel, authStorage }`. The app's ~37 React
components + 14 IPC handlers just *drive* it. **BrainStrike already has its own equivalent
engine** (`createMastraAgentRuntime`, its own OM via `createPgliteMastraMemory`, its own tool
guards) and imports none of the Harness/mastracode/libsql.

### Strategic verdict: STAY BESPOKE. Replicate selectively. Do NOT adopt the Harness.

- The Harness is **LibSQL-coupled** (incompatible with PGlite/pgvector RAG) and its IPC event
  bus is **desktop-only** — BrainStrike's HTTP/SSE `DataStreamMapper` already works on **web
  AND desktop**, which mastra-code can never do.
- Adopting it inherits its **0.x upstream gaps** (no `deleteThread`, no `hookManager`/
  `mcpManager` passthrough, a hand-patched `anthropic-beta` header bug in
  `patches/mastracode.patch`).
- BrainStrike's **resilience layer** (per-tool guard + inactivity watchdog + renderer error
  boundary) already gives new dangerous tools timeout/failure containment the Harness leaves
  to the app.

Every feature below is **"learn the pattern, build it into BrainStrike's existing systems,"**
not copy-paste. Two buckets:
- **Bucket A — App-owned UI/IPC lifts** (directly transferable): OAuth, LSP+edit tools,
  grep/glob/shell/web, terminal/diff/git, slash commands, notifications, hooks.
- **Bucket B — Harness-native capabilities BrainStrike replicates** (permissions, OM,
  subagents, token/cost) — several of which it *already partly has*.

---

## 1. The Reverse-Engineering Workflow (repeatable playbook)

**Step 1 — Layer-separate first.** Classify each `src/` file as *app-owned* vs
*Harness-delegated*. App-owned files use `createTool(...)` / React / `ipcMain`;
Harness-delegated code is a one-line `harness.*` call. Grep `main.ts` + `src/electron/ipc/*`
for `harness.` / `mcpManager.` / `hookManager.` call sites — that list *is* the dependency
surface (`UPSTREAM_HARNESS_GAPS.md` is their own version of this map).

**Step 2 — Trace one feature end-to-end on the canonical seam:**
`Renderer component → window.api.invoke({type}) → src/electron/ipc/<x>-handlers.ts →
harness/tool → model`. The renderer has *zero* Node/Harness deps, so every feature crosses
that one bridge.

**Step 3 — Map onto BrainStrike's equivalent seam:**
`assistant-ui panel → HTTP/SSE → assistant-server → createMastraAgentRuntime →
DataStreamMapper → AssistantRunEvent`.

**Step 4 — Classify the port:** `port-wholesale` / `adapt` / `build-fresh` / `skip`.
Decide **web+desktop applicability** up front — capability-gate per the CONTEXT ACTION SYSTEM
rule (web simply never constructs desktop-only tools; **no disabled "desktop only" stubs**).

**Step 5 — Per-feature porting checklist:**
1. Spike the mechanism in isolation.
2. Register through BrainStrike's **multi-registry tool contract** (schemas.ts →
   tool-categories.ts → assistant-tools.ts → default-instructions.ts).
3. Wire resilience (guard + watchdog) + **no-silent-fallbacks** (malformed config THROWS).
4. **LIVE-loop test** with a real agent + real tool `execute` (per the CLAUDE.md warning that
   mocked tests once stayed green while real Mastra tool calling broke).
5. Verify clean-build/lint/type/test in one run.

---

## 2. Feature Breakdown (multi-level, all 14 domains)

Legend: **Verdict · Effort(S/M/L/XL) · Web|Desktop**

### 2.1 Permission System — `adapt · L · both` ⭐ FOUNDATION — build first
*Mechanism:* `src/permissions.ts` defines 4 risk categories (`read|edit|execute|mcp`), a
`TOOL_CATEGORY_MAP`, `ALWAYS_ALLOW_TOOLS`, `DEFAULT_POLICIES` (read:allow, rest:ask),
`YOLO_POLICIES`. Enforcement is Harness-native (`setPermissionForCategory` /
`grantSessionCategory` / `getPermissionRules`).
*BrainStrike today:* a per-`toolCallId` approve/decline **resume path exists but is DORMANT** —
`requiresApproval` metadata is never wired to Mastra's `requireApproval` flag; no category/
policy/YOLO/session-grant model.

- 2.1.1 Risk taxonomy (separate from the existing load-ordering `ToolCategory`!) — derive
  `read/edit/execute/mcp` risk from the same `UnifiedToolMetadata.requiresApproval` already
  declared (one source of truth, no drift-prone second map).
- 2.1.2 Policy model — allow/ask/deny per category + master YOLO toggle + per-tool override.
- 2.1.3 Wire the dormant gate — set Mastra `requireApproval` on the live registry;
  **highest regression risk** → extend `mastra-tool-execution.spec.ts` with a real ask-gated
  tool (not mocks).
- 2.1.4 Persistence + reset — policy store routed through `clearPersistentUiState()`
  (FACTORY RESET CONTRACT); session-grant key discipline mirroring the context-usage store.
- **Better:** strict-parse (throw on unknown policy vs mastra's silent `?? 'ask'`); rich
  approval dialog with riskLevel + **diff preview** for edits; permission **audit log** via
  `createLogger`; works on web local-runtime too.

### 2.2 Coding Tools — Search / Shell / Web — `adapt · XL · desktop-mostly`
*Mechanism:* `grep.ts` → ripgrep (`execa("rg")`, grep fallback); `glob.ts`; `shell.ts`
(node-pty/execa, detached + tree-kill teardown); `web-search.ts` (Tavily + provider-native
cascade); `computer-use`/`navigate-browser` (Playwright). Canonical versions live inside
`mastracode`; `src/tools/` are reference impls.

- 2.2.1 glob / find-files (build-fresh) — absent today. **Better:** glob over the indexed
  `file_records` table (no subprocess, multi-root-aware, gitignore applied) + live-FS
  `git ls-files` fallback flag.
- 2.2.2 Live grep — **hybrid**: keep trigram-PGlite `grepSearch` AND add ripgrep-over-disk,
  merging + labeling which engine matched. Required (not polish): an editing agent that greps
  the index after a write gets stale results.
- 2.2.3 Shell execution (build-fresh) — THE defining RAG→coding-agent gap. Port the full
  detached + tree-kill + global-set + finally teardown; test with real subprocesses.
  ⚠️ Hard-gated behind 2.1.
- 2.2.4 Web search — **Better:** prefer provider-native search (no extra key); Tavily only
  when a key is in the encrypted keychain (inverts mastra's Tavily-first default).
- 2.2.5 Browser/computer-use — could reuse the hidden-renderer host pattern instead of
  bundling `playwright-core`.
- **Better (sandbox):** reuse the `realpath` workspace-root containment (escape-proof-by-
  construction) for shell cwd vs mastra's `startsWith(root)` string check.

### 2.3 AST-aware Smart Editing + LSP — `adapt/build-fresh · XL · both`
*Mechanism:* `string-replace-lsp.ts` (primary edit) → `sharedFileEditor.strReplace()` then
real LSP diagnostics (`vscode-jsonrpc`, `waitForDiagnostics(3000)`, token-bounded diagnostics
block; LSP failure non-fatal). `ast-smart-edit.ts` (@ast-grep), `write.ts`, `file-editor.ts`
with a fuzzy-match cascade (exact→whitespace→char→Levenshtein via `fastest-levenshtein`).
*BrainStrike today:* read-only. No write/edit/AST/LSP, none of these deps.

- 2.3.1 write_file + string-replace with the fuzzy cascade + single-line-ambiguity guard —
  **port verbatim, don't "clean up"** (under-specified `old_str` corrupts files).
- 2.3.2 Per-file write lock to serialize concurrent edits from parallel tool calls.
- 2.3.3 LSP backbone (desktop-only enrichment, never a hard dep) — client/manager/server/
  workspace/language; surface diagnostics as a structured run-event card.
- 2.3.4 AST transforms — prefer the existing tree-sitter/Tapestry index data over native
  `@ast-grep/napi` where possible (avoids per-platform asarUnpack traps).
- **Better (killer differentiators):**
  - Re-index on edit: enqueue a re-chunk/re-embed job (`job_queue`) after each write so RAG
    stays consistent — mastra structurally cannot (no index).
  - PGlite edit journal (path, oldHash, newHash, diff, ts) → undoable/auditable/crash-
    recoverable.
  - Web editing via File System Access `FileSystemWritableFileStream` + one-time `readwrite`
    upgrade → coding agent on web too.
  - Approve a rendered DIFF via `requireApproval`/suspend (assistant-ui already supports it).

### 2.4 Diff Viewer / Embedded Terminal / Git — `adapt · XL · desktop-only`
*Mechanism:* `TerminalPanel.tsx` = xterm 6 + addon-fit + node-pty (idempotent `startPty`,
10× retry); `DiffEditor.tsx` inline+side-by-side vs HEAD (tints, no syntax highlight);
`GitPanel.tsx` stage/unstage/commit/push/pull.
*BrainStrike substrate:* `CodeSurface` (read-only CM6) + CM6 deps present → `@codemirror/merge`
is a drop-in upgrade.

- 2.4.1 PTY IPC domain (create/write/resize/destroy + pty_output/pty_exit) via
  `createDesktopIpcRegistry` + `window.terminal` bridge; node-pty native-module wiring
  (electron-rebuild + asarUnpack + darwin spawn-helper chmod) — ⚠️ fails only in packaged
  builds if wrong.
- 2.4.2 Git IPC domain (status/diff/stage/commit/push/pull) via `execFile` + `window.git`.
- 2.4.3 Diff viewer — **Better:** `@codemirror/merge` with real syntax highlighting reusing
  `CodeSurface` language resolution (mastra has none).
- **Better:** typed/validated IPC; capability-gate terminal/git off-web; scope each terminal
  to the active root's absolute path; full PTY teardown on root switch wired to lifecycle
  disposers. ⚠️ Raw PTY escapes the `resolveValidatedPath` sandbox by design — needs explicit
  cwd-pin + opt-in sign-off.

### 2.5 Observational Memory — `adapt(upgrade) · M · both` ✅ engine already runs
*Mechanism:* 100% Harness-native — app only relays `harness.loadOMProgress()` /
`getDisplayState().omProgress` and renders `OMTokenTracker` (two live bars) + observer/
reflector model split.
*BrainStrike today:* already runs the same `@mastra/memory` observe→reflect loop via
`createPgliteMastraMemory`, persists the exact fields in a PGlite OM table, emits
`memory.observation.*` run-events. **Missing the UX, not the engine.**

- 2.5.1 Live OM meter — read the PGlite OM row (`pendingMessageTokens`,
  `bufferedReflectionInputTokens`…) into progress bars.
- 2.5.2 Observer/reflector model split (currently one model) — ⚠️ verify `@mastra/memory`
  1.6.x accepts two models; ship as optional advanced toggle.
- **Better:** unify with the context-usage meter into one tri-segment "thread budget";
  drive with PGlite live reactive queries (no poll); surface the compaction *benefit*
  ("saved ~Nk tokens"); first-class keyless local-Gemma OM; throw on invalid OM model.
  ⚠️ Reads raw `@mastra/memory` columns (private contract) — pin version + schema-drift test.

### 2.6 Subagent Execution — `adapt · XL · both`
*Mechanism:* parent calls a `subagent` tool `{agentType:'explore'|'plan'|'execute', task,
modelId?}` → `SubagentDefinition` lookup → constrained tool subset → child Agent (maxSteps:50)
→ summary. App renders `subagent_*` events + `AgentDashboard` (status/branch/tokens/cost) +
parallel-agents-in-worktrees.
*BrainStrike today:* single agent. `createMastraAgentRuntime` already does everything a
spawner needs in miniature.

- 2.6.1 Subagent tool + persona registry (explore/plan/execute) + per-persona constrained
  tool whitelist **derived from the tool-categories registry** (read-only persona provably
  can't get a write tool).
- 2.6.2 Nested-activity run-events (`subagent.started/tool.*/finished` grouped by
  `parentToolCallId`) — first-class events, not mastra's brittle `<subagent-meta>` text tag.
- 2.6.3 Guard the child loop with the existing per-tool guard + watchdog; token-budget the
  returned summary via `fitItemsToCharBudget`.
- **Better:** RAG-native explore persona (queryEmbeddingSpace + grepSearch + hybrid — mastra
  is grep-only); run read-only subagents on keyless local Gemma for cheap private fan-out.
  ⚠️ Hard-cap nesting/concurrency (cost blowup); `execute` persona blocked on 2.2/2.3; respect
  the LocalLlmBackend serialization queue.

### 2.7 Token Tracking & Cost ("Token Trading") — `adapt · M · both`
*Mechanism:* `harness.getTokenUsage()` + app-owned static `MODEL_PRICING` (`cost.ts`, returns
0 for unknown — silent) + js-tiktoken (tool-output budgeting only) + `AgentDashboard` totals.
*BrainStrike today:* context-usage meter is in several ways more rigorous (exact
`{inputTokens,outputTokens}` keyed by thread), but no cost display / no per-model pricing /
no cross-agent aggregation.

- 2.7.1 Add `pricing?:{inputPerMTok,outputPerMTok}` co-located with `contextWindow` in
  provider-registry.ts (compile-enforced single source, no drift-prone separate map).
- 2.7.2 Durable per-thread cumulative usage derived from `mastra_messages` (BrainStrike
  persists turns; mastra doesn't) → real accumulated cost after reload.
- 2.7.3 Cross-thread/cross-root aggregation (the BrainStrike-native "token trading") via
  PGlite live queries — local, reactive, no polling.
- **Better:** honest provenance — unknown pricing shows "cost unavailable," never silent
  $0.00; apply real tiktoken to the tool-result budget; $0/undefined for keyless local.
  ⚠️ Don't overload the session-only context-usage store — add a parallel accumulation.

### 2.8 OAuth Login — `adapt · XL · both` ⚠️ ToS/legal caveat
*Mechanism:* full PKCE in app code (`pkce.ts`, Web Crypto S256). `OAuthProviderInterface`
plugins for Anthropic Claude Pro/Max + OpenAI Codex/ChatGPT using *hardcoded, undocumented*
client IDs/endpoints intended for official CLIs; injects a `"You are Claude Code..."` system
message; tokens in plaintext `auth.json`.
*BrainStrike today:* API-key only, but keys are **encrypted** (`safeStorage` →
`SecretsService`) — strictly more secure than mastra.

- 2.8.1 PKCE helper + provider plugins (Anthropic/OpenAI subscription).
- 2.8.2 Typed OAuth credential `{type:'oauth',access,refresh,expires,accountId}` in encrypted
  SecretsService (not plaintext).
- 2.8.3 `credentialResolver`/custom-fetch seam in `provider-factory.ts` (one path for OAuth +
  API-key); fix the `anthropic-beta` header as a **merge** (test that an SDK-added beta
  survives — ship the ideal fix mastra only patched).
- 2.8.4 `authType:'api_key'|'oauth-subscription'` on `ProviderDefinition` → picker renders
  "Sign in with Claude" vs "Paste key."
- ⚠️ **Risks:** undocumented client IDs can be revoked; **ToS may prohibit third-party use of
  Max/Plus subs — legal review before shipping.** Refresh tokens encrypted + logger-redacted
  only. Web has no loopback server/safeStorage — design manual-paste/redirect as canonical.

### 2.9 Slash Commands & Command Palette — `adapt · L · both`
*Mechanism:* `EditorInput.tsx` detects leading `/` → `SlashCommandAutocomplete`; builtins
(new/clear/plan/build/fast/model/…) are local UI actions; custom commands = markdown prompt-
macros from `~/.mastracode/commands` + project dir, with template expansion (`$ARGUMENTS`,
`` !`shell` ``, `@file`).

- **Better (big one):** build palette + slash + right-click all off the existing
  `packages/context-actions` registry — ONE command source. QuickFileOpen backed by the
  PGlite file index (web+desktop, multi-root, no spawn, rank by recency/embedding). Persist a
  per-root command catalog in PGlite. ⚠️ Verify the `@assistant-ui/react` ComposerPrimitive
  API allows inline `/` interception (highest-uncertainty item); `` !`shell` `` gated by
  permissions; decide what's persisted vs displayed (interacts with OM hydration).

### 2.10 Desktop Notifications — `adapt · M · both`
*Mechanism:* 4-mode pref (`off|bell|system|both`), native `Notification` (main, gated on
`!window.isFocused()`) + dock badge + bell; fires on agent_end / approval / error.
*BrainStrike today:* none, but toast/sonner + run-event stream + focus tracking all exist.

- **Better:** drive off typed run-events (distinguish cancelled vs failed; notify on long
  index/embedding completion too); reuse toast for an actionable in-app bell (click → jump to
  thread); cross-platform badge (`setBadgeCount`/`setOverlayIcon`, not macOS-only); web path
  via browser Notification API. ⚠️ Filter to the visible renderer (never fire from hidden
  hosts); AudioContext must unlock on a real gesture; v1 = completion+error only.

### 2.11 Harness Hooks — `adapt · L · both` (sequence WITH coding tools)
*Mechanism:* Claude-Code-style lifecycle hooks — config-file-driven shell commands
(`~/.mastracode/hooks.json` + project), 7 events (PreToolUse/PostToolUse/Stop/
UserPromptSubmit/SessionStart/SessionEnd/Notification, 3 blocking), spawned via `/bin/sh -c`
with JSON stdin + exit-code protocol.

- **Better:** real settings UI + per-hook dry-run test (mastra has neither); blocking reuses
  the tool-approval path (PreToolUse can auto-approve/deny → programmable permission policy);
  web-safe in-process JS hooks; emit `hook.*` run-events into the Activity panel; redact
  secrets from stdin payload; throw on malformed config. ⚠️ Low ROI until mutation tools
  exist — sequence with 2.2/2.3. Timeout invariant: hook < tool < stream-inactivity.

### 2.12 MCP — `skip / selective · M · both` ✅ already more capable
*BrainStrike today:* a more capable MCP consumer than mastra (stdio + sse, zod-validated
`McpConfig`, `collectCombinedTools` + sanitize) plus the Agent Hub MCP server (#1187).

- **Selective enhancements only:** unify the two client stacks (desktop connects to each
  server twice — raw SDK discovery + `@mastra/mcp` execution); add Streamable HTTP transport;
  bring MCP to web (HTTP/SSE only); import existing Claude Desktop/Code `mcpServers` config;
  per-root `.brainstrike/mcp.json` keyed by durable `rootId` (avoid #1197/#1198 collisions).

### 2.13 Data Layer: LibSQL alongside PGlite — `decision · M`
*Mechanism:* mastra's entire store is a single `mastra.db` LibSQL file — threads, messages,
and token counts — project-scoped by git remote URL. Hard-incompatible with PGlite for copy.

- **Recommendation:** the multi-connection-friendly metadata workload is exactly what
  PGlite's single-connection limit chafes against. Introduce **LibSQL/`@mastra/libsql` as a
  second store for high-contention metadata** (job_queue, thread/session metadata, permission
  grants, command catalog, subagent bookkeeping) while **PGlite stays the vector/RAG engine**
  (pgvector/halfvec/HNSW — non-negotiable). Net: relieve the connection-limit pain without
  losing local-first RAG.
- **DECISION GATE (measure first):** the `data-architecture` dive flags this as XL and warns the
  win may be small if model inference + embedding dominate wall-clock (the deferred PR4 lesson).
  Instrument `PgliteMemoryStore` memory-write contention (P50/P95 wait under a real chat +
  background-embedding + foreground-query load) BEFORE building. If P95 wait < ~50ms, retune the
  scheduler instead. `@libsql/client` is **Node-only** → the split is permanently desktop-only;
  web keeps PGlite. Make the memory backend pluggable (`pglite | libsql | wasm-sqlite`), keep
  `PgliteVectorStore` as the vector domain regardless. Full detail in the synthesis companion doc.

### 2.14 ACP / Event-bus / Harness abstraction — `strategic`
Covered in §0 — **stay bespoke.** Worth borrowing conceptually: the `steer` / `followUp`
mid-run control vocabulary (inject steering text into an in-flight run; queue a follow-up) and
a `shell_output` streaming-tool-output event channel — both net-new interaction primitives the
`AssistantRunEvent` vocabulary lacks.

---

## 3. Dependency-Ordered Roadmap

```
Phase 0  FOUNDATIONS    ── data-layer decision (2.13) + Harness ADR (stay bespoke)
Phase 1  SAFETY RAILS   ── Permissions (2.1) [HARD GATE] + token/pricing groundwork (2.7.1)
Phase 2  AGENT'S EYES   ── glob + hybrid live-grep + web search (2.2.1/2/4)   ← low risk
Phase 3  AGENT'S HANDS  ── edit tools + LSP (2.3) + shell (2.2.3)             ← gated by P1
Phase 4  DESKTOP IDE    ── diff/terminal/git (2.4) + notifications (2.10)
Phase 5  ORCHESTRATION  ── subagents+dashboard (2.6) + OM meter (2.5) + cost agg (2.7)
Phase 6  POWER-USER     ── slash commands (2.9) + hooks (2.11) + MCP polish (2.12)
Parallel track          ── OAuth (2.8)  [independent, but ToS review first]
```
**Why:** Permissions must precede any mutating tool. Read-mostly tools (glob/grep/web) are the
cheapest path to "it's a coding agent" and de-risk the harder edit/shell work. Subagent
`execute` persona and the cost meter both depend on edit/shell + token plumbing existing.

## 4. Effort / Risk / Value matrix

| Domain | Verdict | Effort | Web? | Top risk |
|---|---|---|---|---|
| Permissions | adapt | L | both | LIVE Mastra regression wiring `requireApproval` |
| Search/Shell/Web | adapt | XL | desktop | shell = arbitrary code exec → must be gated |
| Editing+LSP | build-fresh | XL | both | index goes stale w/o re-embed; fuzzy mis-apply |
| Diff/Terminal/Git | adapt | XL | desktop | node-pty native bundling fails only when packaged |
| Subagents | adapt | XL | both | cost blowup; hydration mis-render |
| OAuth | adapt | XL | both | ToS/legal; undocumented endpoints |
| Token/Cost | adapt | M | both | stale pricing; don't overload session store |
| Observational Memory | upgrade | M | both | reads private `@mastra/memory` columns |
| Notifications | adapt | M | both | fire from wrong/hidden window |
| Slash commands | adapt | L | both | assistant-ui composer `/` interception |
| Hooks | adapt | L | both | new freeze vector; secret exfiltration |
| MCP | skip/selective | M | both | live tool-path regression on unify |
| Data layer | decision | M | n/a | dual-store consistency |

## 5. Where ours wins (differentiation thesis)

1. **RAG-grounded editing** — re-index on every write; mastra has no index.
2. **Web + desktop coding agent** — HTTP/SSE transport + FS-Access writes; mastra is
   desktop-only forever.
3. **Hybrid live+index grep** with a freshness guarantee an editing agent needs.
4. **Local-first, keyless** — subagents + OM on built-in Gemma; no cloud, no bill.
5. **One command/permission/event source of truth** (context-actions registry,
   tool-categories, typed redacted run-events) vs mastra's per-surface re-declaration.
6. **Reactive PGlite live queries** for the OM/cost meters (no polling).

---

## Appendix — Source map (mastra-code-ui files by domain)

- **Auth:** `src/auth/{pkce,storage,types}.ts`, `src/auth/providers/{anthropic,openai-codex}.ts`,
  `src/providers/{claude-max,openai-codex}.ts`, `src/electron/ipc/auth-handlers.ts`,
  `src/renderer/components/LoginDialog.tsx`, `src/renderer/hooks/useAuthManager.ts`
- **Editing/LSP:** `src/tools/{ast-smart-edit,string-replace-lsp,file-editor,write,file-view,
  utils}.ts`, `src/lsp/{client,manager,server,workspace,language}.ts`,
  `src/renderer/components/{FileEditor,DiffEditor}.tsx`
- **Search/Shell/Web:** `src/tools/{grep,glob,shell,web-search,computer-use,navigate-browser}.ts`,
  `src/browser/playwright-manager.ts`, `src/electron/ipc/pty-handlers.ts`
- **MCP:** `src/mcp/{manager,config,types,index}.ts`, `src/electron/ipc/mcp-handlers.ts`
- **Permissions:** `src/permissions.ts`, `src/tools/{wrap-with-confirmation,request-sandbox-access}.ts`,
  `src/electron/ipc/permission-handlers.ts`, `src/renderer/components/{ToolApprovalDialog,
  ConfirmDialog,AskQuestionDialog}.tsx`
- **OM:** `src/renderer/components/OMTokenTracker.tsx`, `src/renderer/hooks/useHarnessEvents.ts`
- **Subagents:** `src/tools/subagent.ts`, `src/agents/{execute,explore,plan,types,index}.ts`,
  `src/renderer/components/{SubagentExecution,AgentDashboard,PlanApproval}.tsx`
- **Token/Cost:** `src/utils/cost.ts`, `src/renderer/components/{StatusBar,ContextPanel}.tsx`,
  `src/ipc/ipc-reporter.ts`
- **Diff/Terminal/Git:** `src/renderer/components/{DiffView,DiffEditor,TerminalPanel,GitPanel}.tsx`,
  `src/acp/{terminal-manager,event-bus}.ts`, `src/electron/ipc/{pty,git}-handlers.ts`
- **Slash commands:** `src/electron/ipc/slash-command-handlers.ts`,
  `src/renderer/components/{SlashCommandAutocomplete,CommandPalette,EditorInput,QuickFileOpen}.tsx`
- **Notifications:** `src/electron/notifications.ts`
- **Hooks:** `src/hooks/{config,executor,manager,types,index}.ts`
- **Data/arch:** `src/utils/project.ts`, `src/electron/{main,electron-state,preload}.ts`,
  `src/electron/ipc/index.ts`, `README.md`, `MONOREPO_MIGRATION.md`, `UPSTREAM_HARNESS_GAPS.md`
