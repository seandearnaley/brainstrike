===== DATA-ARCHITECTURE | verdict=adapt effort=XL =====
MASTRA: mastra-code-ui delegates ALL durable storage to the published `mastracode`/`@mastra/libsql` packages — `createMastraCode({cwd})` (called in src/electron/main.ts createHarness) returns a Harness whose storage is a `LibSQLStore` pointed at ONE file `mastra.db`. That file holds threads, messages, token counts, OM, and metadata. Storage config resolution (src/utils/project.ts getStorageConfig): env `MASTRA_DB_URL`+`MASTRA_DB_AUTH_TOKEN` (can be a remote Turso `libsql://` URL) > project `.mastracode/database.json` > global `~/.mastracode/database.json` > default `file:${getAppDataDir()}/mastra.db`. App data dir is platform-specific with a dev/prod split (`mastra-code-dev` vs `mastra-code`). Crucially libsql is a real client/server SQLite with a CONNECTION POOL — concurrent reads/writes don't serialize on one lock, and it can transparently point at a remote replica.

Project-scoped threads (src/utils/project.ts detectProject): a `resourceId` is computed from git identity so conversations follow the repo across clones/worktrees/SSH-vs-HTTPS. Logic: worktree → keyed by worktree rootPath (each branch gets independent threads); else gitUrl present → `normalizeGitUrl(origin)` (strip .git, ssh→https, lowercase); else absolute path. resourceId = `${slugify(baseName)}-${shortHash12(source)}`. Overridable via `MASTRA_RESOURCE_ID` / config `resourceId` (a shared tag — two users with the same id share threads). OM scope (thread|resource) and userId (env > git user.email > os username) resolve through the same precedence ladder. ALL threads for ALL projects live in the SAME libsql file, part
BS: brainstrike runs its OWN Mastra storage adapter over a SINGLE PGlite instance — no libsql anywhere (verified: zero libsql/better-sqlite/node:sqlite imports in repo or any package.json). `PgliteMemoryStore` (packages/agent/src/pglite-mastra-memory/memory-store.ts, 1707 LOC) + `PgliteVectorStore` + `PgliteWorkflowsStore` implement Mastra's MemoryStorage/vector/workflows domains, composed via MastraCompositeStore in memory-factory.ts. Tables `mastra_threads`/`mastra_messages`/`mastra_resources`/`mastra_observational_memory`/`mastra_workflow_snapshot`/`mastra_vectors` (packages/assistant-contract/src/mastra-memory-schema.ts) live in the SAME PGlite DB as the RAG vector indexes (pgvector/halfvec/HNSW), file chunks, FTS, and job_queue — confirmed: apps/desktop/src/assistant-server.ts createPgliteMastraMemory({database: await getDatabase()}) reuses the one getDatabase() handle. Desktop: ONE PGlite in the main process (apps/desktop/src/db-main.ts); renderer reaches it over 3 IPC channels (db:q
GAPS: Single-connection serialization: assistant memory writes (thread/message/OM saves) contend on the SAME PGlite connection as RAG vector search, FTS, chunk inserts, and background embedding writes — the whole DatabaseWorkScheduler/PressureController machinery exists only to paper over this. mastra-code's libsql pool never has this contention. | No remote/sync escape hatch: PGlite is local-file-only; there's no equivalent of mastra-code's MASTRA_DB_URL Turso remote replica for backup/multi-device thread sync. | Thread scoping philosophy diverges and brainstrike's is coarser: brainstrike has ONE workspace-global resourceId and partitions only by whole-DB git-branch PROFILE; it has no per-repo/per-project thread grouping WITHIN a workspace the way mastra-code keys threads by git remote. Multi-root workspaces collapse all roots' assistant threads into one bucket. | No git-remote normalization for identity: brainstrike profiles by local branch+path hash (createWorktreeScopedProfile), so the same repo cloned to two paths, or SSH vs HTTPS remotes, get DIFFERENT databases — the opposite of mastra-code's 'threads follow the repo' guarantee. | IPC contract is broad, not a command bus: brainstrike exposes dozens of typed db:* channels (db:query/exec/transaction/live-query/managed-cache/scheduler/...) vs mastra-code's 2-channel harness:command/harness:event bus. More surface to keep in sync, though it is strongly typed. | atomic-transaction.ts is a workaround for the callback-can't-cross-IPC problem that libsql's transaction API wouldn't need.
BETTER: Keep PGlite for vectors AND add pooled SQLite for metadata — brainstrike ends up with libsql's write-concurrency for threads/OM AND pgvector HNSW for RAG, a strictly better combination than mastra-code (libsql-only, no real vector index) OR current brainstrike (PGlite-only, serialized). | Add a git-remote-normalized identity layer (port detectProject's normalizeGitUrl + worktree logic) so brainstrike's branch-profile DBs can OPTIONALLY share assistant threads across clones/SSH-vs-HTTPS — fixing the 'same repo, different path = different threads' gap while keeping the local-first default. | Introduce optional per-root (or per-repo) thread grouping by adding a real resourceId derivation (instead of the single WORKSPACE_MEMORY_RESOURCE_ID) so multi-root workspaces can scope assistant conversations to a focused repo — brainstrike's multi-root model makes this MORE valuable than mastra-code's single-project assumption. | Offer the remote-replica escape hatch libsql gives for free (Turso/embedded replica) as an opt-in 'sync my threads across devices' feature — impossible with PGlite-file-only; a genuine local-first-with-sync upgrade. | Because the memory store is already an interface (MemoryStorage), make the backend pluggable (PGlite | libsql | wasm-sqlite) selected per-platform: libsql on desktop, PGlite/wasm on web — no other domain has to know. | Use the freed-up PGlite connection budget to raise background embedding throughput (the scheduler can give more to background work once foreground memory writes leave the connection).
RISKS: @libsql/client is Node-only — it CANNOT run in the web/renderer bundle. This split is fundamentally desktop-only; web must keep PGlite-memory or a wasm SQLite, creating a permanent platform divergence that must be carefully documented and tested on both paths. | Splitting threads/messages off PGlite while semantic-recall vectors (mastra_vectors) stay on PGlite means ONE logical Memory now spans TWO physical stores — cross-store consistency (a message saved in libsql but its OM-vector write to PGlite fails, or vice versa) has no shared transaction. Must define the failure ordering and reconciliation explicitly. | brainstrike's OM persistence + reload hydration contract (CLAUDE.md ASSISTANT THREAD PERSISTENCE) is intricate (progressive snapshot grouping, toolCallId dedup, run-event interleaving). Moving the backing store risks subtly breaking hydration in ways mocked tests won't catch — the prior guard-wiring incident (broke real tool calling while mocks stayed green) is the cautionary precedent; live-loop tests are mandatory. | The win may be small: if model inference + embedding generation dominate wall-clock (likely, per the prompt's own note and the deferred PR4), relieving DB-connection contention buys little. The §0 measurement gate exists precisely to avoid an XL build for a marginal gain. | Run-event observability: PgliteMemoryStore emits brainstrike AssistantRunEventSink events; LibSQLStore won't natively. Wrapping it to preserve the run-event stream adds complexity and a regression surface for the assistant Activity/timeline UI. | Factory reset, per-branch DB profiling, and managed-cache reconciliation all currently assume one DB file — adding a second sqlite file means every lifecycle/reset/diagnostics path must account for it or risk orphaned/stale thread data reappearing.

BREAKDOWN:
## 0. Decision gate: measure-before-build (BLOCKING)
- Instrument current single-connection contention on memory writes
  - Add timing around `PgliteMemoryStore.saveMessages`/thread upsert/OM swap that records `DatabaseWorkScheduler` wait time vs service time per call
    - Emit via existing scheduler snapshot (`DatabaseWorkSchedulerSnapshot.priorityStats`) tagged with a `memory-write` label
    - Capture a real session: chat turn + concurrent background embedding batch + a foreground semantic-recall query, log P50/P95 memory-write wait
  - Decide: if memory-write P95 wait under load is < ~50ms, the libsql split is NOT worth it — stop and instead just retune scheduler priorities
    - Document the measured numbers in the PR; do not proceed on assumption (no-silent-fallbacks ethos applies to architecture too)

## 1. Backend abstraction seam (make memory store pluggable)
- Define a platform-agnostic memory-backend selector
  - Introduce `AssistantMemoryBackend = 'pglite' | 'libsql' | 'wasm-sqlite'` in assistant-contract
    - Default resolution: desktop → `libsql`, web → `pglite` (libsql client is Node-only)
    - Strict parse: unknown value THROWS (matches brainstrike no-silent-fallback rule)
  - Refactor `createPgliteMastraMemory` (memory-factory.ts) into `createAssistantMemory(backend, deps)`
    - Extract the `MastraCompositeStore` composition so the `memory` + `workflows` domains can come from EITHER PgliteMemoryStore or a new LibsqlMemoryStore
    - Keep `PgliteVectorStore` as the vector domain REGARDLESS of metadata backend (semantic recall stays on pgvector)
      - This is the load-bearing design choice: metadata→sqlite, vectors→pglite, in ONE Memory instance
    - Verify Mastra's `Memory({storage, vector})` accepts a composite store whose memory domain and vector store have DIFFERENT physical backends (read @mastra/memory Memory ctor; add a spec)

## 2. LibSQL store implementation (desktop main process)
- Add @mastra/libsql dependency to the desktop/main toolchain ONLY
  - Add to apps/desktop (NOT to any package imported by web/renderer bundles)
    - Confirm `@libsql/client` native binding is allowed in `pnpm.onlyBuiltDependencies`
    - Verify it does not leak into the renderer bundle (electron-vite externalization)
- Provision the libsql file + path resolution
  - Add `getAssistantMetaDbPath()` mirroring `getDatabasePath()`'s git-branch profile derivation
    - Reuse `createWorktreeScopedProfile`/`getGitProfileContext` so the sqlite file sits in


===== SYNTH:METHODOLOGY (24124 chars) =====
All claims verified against both repos. Key confirmations: the harness/mastracode/libsql import grep returns empty in brainstrike; `agent-runtime.ts`, `guard-tool-execution.ts`, the read-only-only tools dir (no write/edit/shell), both live-loop spec files, all four tool registries, and `with-inactivity-timeout.ts` all exist at the cited paths; mastra-code-ui's `createMastraCode` call sites and the five `@mastra/*` deps + the `mastracode.patch` are confirmed. Writing the playbook.

---

# Reverse-Engineering Playbook: Porting an External Electron + Mastra Coding Agent into Brainstrike

**Audience:** brainstrike engineers porting capabilities from `mastra-code-ui` (a thin Electron shell over the published Mastra **Harness**) into brainstrike (which owns its **own** Mastra loop and must *replicate*, not *adopt*).

**The one-sentence thesis you must internalize before touching anything:**
> In mastra-code-ui, the agent intelligence is **bought** (`createMastraCode()` returns a fully-wired Harness). In brainstrike, it is **owned** (`createMastraAgentRuntime` builds the `Agent` directly). Therefore "port feature X" almost never means copy-paste — it means **trace the mechanism, classify it Harness-native vs app-owned, then re-home the app-owned pattern into brainstrike's existing registries/seams** while honoring local-first + WEB+DESKTOP + no-silent-fallbacks.

This is verified: a grep for `@mastra/core/harness|from 'mastracode'|@mastra/libsql` across brainstrike `packages/` + `apps/` returns **empty**; brainstrike runs `packages/agent/src/mastra/agent-runtime.ts`. mastra-code-ui's `package.json` pins `mastracode@0.5.1`, `@mastra/core@1.9.0`, `@mastra/libsql@1.6.3` and ships `patches/mastracode.patch`.

---

## Phase 0 — Orientation & Ground Truth (do once, ~half a day)

### 0.1 Map the three layers of the source app
Before reading any feature code, establish *which layer owns what*. Run these from `/tmp/mastra-code-ui`:

```bash
# Layer 1 (app-owned): every IPC handler + renderer component is in-repo
ls src/electron/ipc/ src/renderer/

# Layer 2/3 (bought): the Harness factory call — the boundary you cannot read past
grep -rn "createMastraCode" src/electron/main.ts        # → main.ts:82
# Confirm the published deps that ARE the engine
grep -E "mastracode|@mastra/" package.json
```

**Deliverable:** a one-line classification per feature directory: *app-owned* (source is in `src/`) vs *bought* (logic lives behind `createMastraCode`).

### 0.2 Read the three strategy docs first, code second
- `ROADMAP.md` — the `[x]/[-]/[ ]` matrix tells you what the app actually finished vs aspires to. **A `[ ]` item is not a port target yet — it doesn't exist in working form.**
- `UPSTREAM_HARNESS_GAPS.md` — the single most valuable artifact. Each gap = a capability the app needed that the Harness didn't expose, with the workaround. **A "RESOLVED in 1.8.0/1.9.0" gap means the mechanism is Harness-internal and you cannot read it in `src/` — you only see the call site.** Still-OPEN gaps (#1 deleteThread, #9 hookManager-config, #10 mcpManager-config, #14 auth, #20 OAuth-header patch) are the parts that ARE app-owned and readable.
- `MONOREPO_MIGRATION.md` — confirms the app is tightening coupling to upstream (`workspace:*`), the **opposite** direction from brainstrike. Read it to know what *not* to copy.

### 0.3 Build the brainstrike substrate map (the landing zones)
brainstrike already has the seams every port must plug into. Memorize these — they are where ported patterns re-home:

| Source-app concept | Brainstrike landing zone (verified path) |
|---|---|
| `createMastraCode()` factory | `packages/agent/src/mastra/agent-runtime.ts` (`createMastraAgentRuntime`) |
| Harness tool registration | Multi-registry: `packages/agent/src/tools/schemas.ts` + `tool-categories.ts`/`tool-schemas-display.ts` (assistant-contract) + `apps/desktop/src/assistant-server/assistant-tools.ts` + `default-instructions.ts` |
| Per-tool execution guard | `packages/agent/src/tools/guard-tool-execution.ts` (`applyToolGuards`) |
| Stream watchdog | `packages/agent/src/stream/with-inactivity-timeout.ts` |
| `harness.subscribe()` event union | `packages/assistant-contract/src/run-events.ts` + `packages/agent/src/stream/data-stream-mapper.ts` |
| LibSQL thread/OM/token store | PGlite: `packages/agent/src/pglite-mastra-memory/` (own OM) |
| Harness permission engine | **ABSENT** — `guard-tool-execution.ts` is timeout-only, not allow/ask/deny |
| Harness `getTokenUsage()` | data-stream `message-finish` usage tap + `context-usage-store.ts` |
| `createMastraCode({cwd})` single-root | Multi-root `rootId` seam (workspace-roots) |
| Electron IPC bus | `createDesktopIpcRegistry` / `DESKTOP_IPC_CHANNELS` (typed, per-domain) |
| Resilience config | `packages/agent/src/config/resilience-config.ts` (strict-parse, THROWS) |
| Live-loop proof tests | `packages/agent/src/__tests__/mastra-tool-execution.spec.ts`, `mastra-memory-persistence.spec.ts` |

---

## Phase 1 — Harness-Native vs App-Owned Classification (per feature, ~1 hour)

This is the decision that determines whether a feature is even *readable*, let alone portable. Run this exact procedure:

### 1.1 The grep-for-importers test
```bash
cd /tmp/mastra-code-ui
# Does the feature's src/ module actually get imported by the running app?
grep -rn "from ['\"].*<feature-dir>" src/ --include="*.ts" --include="*.tsx" | grep -v "src/<feature-dir>/"
```
**Decision tree:**
- **Zero importers** → the `src/<feature>/` directory is a **reference/shadow copy**; the live logic is inside `createMastraCode`. You can *read the contract* but the runtime behavior is Harness-internal. (Confirmed cases: `src/mcp/*`, `src/hooks/*`, `src/tools/subagent.ts`, `src/agents/*` are all orphaned reference impls — the domain reports verified each by grep.)
- **Real importers in `src/electron/` or `src/renderer/`** → app-owned, readable, directly traceable.

### 1.2 The call-site classification
For any `harness.*` / `mcpManager.*` / `hookManager.*` call in `src/electron/`:
- If the app **calls a method** (`harness.getTokenUsage()`, `harness.setPermissionForCategory(...)`) → **Harness-native mechanism**, app only orchestrates. You must **replicate the capability in brainstrike's own loop**, not copy code.
- If the app **builds the data** (the `permissions.ts` `TOOL_CATEGORY_MAP`, the `cost.ts` `MODEL_PRICING` table, the `slash-command-loader.ts` directory scan) → **app-owned**, the algorithm is portable.

### 1.3 Record the verdict
Each feature gets one of three verdicts (matches the domain-report schema):
- **adapt** — replicate the app-owned pattern in a brainstrike seam (most features).
- **build-fresh** — brainstrike already has a bespoke equivalent; just extend it (e.g. the event bus / "acp-harness" domain).
- **skip** — brainstrike's existing capability is equal-or-better (e.g. MCP *consumer* — brainstrike's is more capable than mastra-code's).

---

## Phase 2 — End-to-End Feature Tracing (UI → IPC → tool → harness → model)

For any feature you decide to port, trace it through **both** apps in the same direction so you can line up the seams. Use this fixed trace template.

### 2.1 Trace the source app (mastra-code-ui)
1. **UI trigger** — find the renderer component / hook. `grep -rn "window.api.invoke" src/renderer/<component>`.
2. **IPC command** — the `{type}` string lands in `src/electron/ipc/<x>-handlers.ts`. (Single dispatcher: `ipcMain.handle("harness:command")`.)
3. **Handler body** — almost always a one-liner delegating to `harness.<method>()` (Harness-native) **or** to an app module (app-owned).
4. **Event return path** — results stream back on the single `harness:event` channel via `harness.subscribe` → `webContents.send`. Map which `HarnessEvent` kinds the feature emits.
5. **Mark the boundary** — the exact line where control crosses into `createMastraCode`'s opaque internals.

### 2.2 Trace the brainstrike equivalent (or confirm its absence)
1. **UI** — `packages/ui/src/assistant-ui-panel/` (composer, tool cards, run timeline).
2. **Transport** — NOT IPC for the agent: brainstrike uses a **loopback HTTP/SSE assistant server** (`apps/desktop/src/assistant-server.ts`) because brainstrike is WEB+DESKTOP and web has no IPC. This is the single most important divergence — never assume an IPC channel where brainstrike uses the data-stream.
3. **Tool/loop** — `createMastraAgentRuntime` → real `Agent` → `applyToolGuards` → stream.
4. **Event return** — Mastra stream parts → `DataStreamMapper` → AI-SDK data-stream chunks (run-events included) → renderer.
5. **Persistence** — `PgliteMemoryStore` (threads/messages/OM), with snapshot-grouping hydration on reload.

### 2.3 Diff the two traces → produce the port spec
The gap between the two traces *is* the work. Write it as: "source emits HarnessEvent `X` at step N; brainstrike has no run-event kind for `X` → add `X` to `run-events.ts` union + `DataStreamMapper` handler + a hydration fixture from a REAL persisted row."

---

## Phase 3 — The Per-Feature Porting Checklist

Run this for **every** feature. It is deliberately ordered: dependencies and safety before code, tests and resilience after.

### 3.0 Gate: is this feature unblocked?
Many features depend on others (the domain reports encode `dependsOn`). The hard sequencing facts:
- **Permissions, write/edit tools, and shell are prerequisites for almost everything dangerous.** A read-only RAG agent has nothing for a PreToolUse-deny hook to guard, nothing for an "execute" subagent persona to execute, and no approval/plan notifications to fire. Do not build downstream features against a producer that doesn't exist.
- **Web vs desktop capability gate is decided here, not later.** Anything touching `child_process`/`node-pty`/`fs`-write/LSP/playwright is **desktop-only by construction**. Use brainstrike's existing capability-gating discipline (Context Action System: web *never constructs* the tool — no disabled "desktop only" stubs, no `isElectron()` checks in tool/menu code).

### 3.1 Spike (timeboxed, throwaway)
- Reproduce the mechanism in isolation. For a tool: write the `createTool`/zod schema and run it through `createMastraAgentRuntime` against a real provider in a scratch test.
- For Harness-native features (permissions, OM meter): confirm brainstrike's underlying primitive supports it *before* committing. E.g. verify `@mastra/memory@^1.37` actually accepts an observer/reflector split before promising it — if it doesn't, that's an upstream gap, not an app task.

### 3.2 Extract the pattern (not the code)
- Pull out the **algorithm** from the app-owned source, discarding LibSQL/single-cwd/Electron-IPC assumptions. Examples:
  - file-editor fuzzy-match cascade (exact → whitespace → char → Levenshtein) → **port verbatim** including the single-line ambiguity guard and "diverged after N lines" message; do **not** "clean it up" (it corrupts files if loosened).
  - permission taxonomy `read/edit/execute/mcp` + allow/ask/deny + session-grant + YOLO → **port the design, build the implementation fresh** (brainstrike has no permission engine).
  - `MODEL_PRICING` table → re-home into the **single source of truth** `provider-registry.ts` (co-located with the existing `contextWindow` invariant), not a drifting parallel map.

### 3.3 Adapt to brainstrike registries (the multi-registry contract is mandatory)
Adding/renaming a native tool touches **every** registry — skipping one passes some checks but breaks others silently (the documented model-catalog class of bug). For a new tool:
1. zod schema + `schemaMap` → `packages/agent/src/tools/schemas.ts`
2. `NATIVE_TOOL_DEFAULTS` / `TOOL_DESCRIPTIONS` / `NATIVE_TOOL_SCHEMAS` → `packages/assistant-contract` (`tool-categories.ts`, `tool-schemas-display.ts`)
3. live registry → `apps/desktop/src/assistant-server/assistant-tools.ts`
4. model-facing guidance → `packages/agent/src/mastra/default-instructions.ts`
5. agent package exports

For other surfaces, re-home to the matching seam from the §0.3 table (permissions store → preferences + factory-reset enumeration; events → run-events union + DataStreamMapper; IPC → `createDesktopIpcRegistry` domain).

### 3.4 Honor brainstrike invariants (non-negotiable, checked in review)
- **No silent fallbacks.** Malformed config/policy/model THROWS a typed error (mastra-code frequently does `?? 'ask'` / returns `undefined`/`0` — fix these in the port, don't replicate them). Surface through the assistant-panel error boundary, never a dead bar/frozen thread.
- **Token-output budget contract.** New tool results self-bound via `fitItemsToCharBudget` + `truncated:true`+`hint` (NATIVE_TOOL_RESULT_TOKEN_BUDGET), never the source's blunt 2000/3000-token char chop.
- **Multi-root rootId identity.** Resolve all paths through the rootId seam; keep durable-rootId discipline (the #1197/#1198 same-named-root fix) — never key by path/dir-name.
- **Factory Reset.** Any new persistent store goes into `clearPersistentUiState()` or stale grants/keys reappear.
- **Logger redaction.** New secret-bearing fields (OAuth tokens, hook stdin) added to pino `redactPaths`.
- **Hidden-host filtering.** Notifications/badges/runs must fire only from the **visible** renderer, never the hidden embedding/llm/chunking hosts (copy `main.ts` host-window guards).

### 3.5 Tests — and the LIVE-loop mandate
This is the highest-leverage rule in the whole playbook, taken straight from a real brainstrike incident:

> A prior change wired the guard + watchdog into the live path and **broke real Mastra tool calling (hosted-provider tools silently stopped executing) while mocked tests stayed green.**

Therefore, for **any** change touching the agent loop, tool registration, suspend/resume (approval/plan gates), memory persistence, or the event seam:
- **Extend the real-agent-loop tests** — `mastra-tool-execution.spec.ts` (real `Agent` + real tool `execute`) and `mastra-memory-persistence.spec.ts` (real PGlite memory). Do **not** rely on mocked stream parts.
- **Hydration fixtures must mirror REAL persisted rows** (Mastra v2 `{format:2, parts:[...]}` with inline tool-invocation results), never hand-written shapes — a hand-written fixture once kept tests green while real tool history vanished on every reload.
- New run-event kinds need a hydration fixture proving reloaded threads render identically to live ones.

### 3.6 Resilience wiring
- New tools inherit `applyToolGuards` (timeout/`GuardedToolError`) automatically — confirm they're in the guarded map, not bypassing it.
- Any new blocking gate (permission ask, plan approval, hook PreToolUse) must respect the timeout invariant: **hook-timeout < tool-timeout (`BRAINSTRIKE_TOOL_TIMEOUT_MS`) < stream-inactivity (`BRAINSTRIKE_STREAM_INACTIVITY_MS`)** so it can never become a new freeze vector.
- Enabling `requireApproval` on a tool flips that step **parallel→sequential** in Mastra — scope it narrowly to avoid a latency regression on multi-tool turns.
- Dangerous tools (shell/web/browser) belong in the **conditional/deferred** tool tier, not critical, so their schemas don't bloat every session's context budget.

### 3.7 The clean-bar gate (CI is the double-check, not the discovery)
Per AGENTS.md, the bar is build + lint + type-check + unit tests **all green in the same run**, iterated until green. Before declaring done:
```bash
# scope to affected closure, then the project gates
pnpm doctor                        # react-doctor scope:changed (only NEW errors block)
pnpm knip                          # dependency auditor (deslop ≠ knip; knip is retained)
# build + types + lint + unit across the affected turbo closure
```
If the change touches the model catalog or a `packages/db/__tests__` test, also run **both** lane registries (`node scripts/test-lanes.mjs check` *and* `node scripts/coverage-lanes.mjs check`) — registering only one passes PRs but silently breaks Nightly Coverage (the #1101 class of bug).

---

## Phase 4 — Sequencing the Whole Port (dependency-ordered waves)

Derived from the `dependsOn` edges across all 14 domains. Build in this order; each wave unblocks the next.

**Wave 1 — Foundations (unblock everything):**
1. **Permissions engine** (verdict adapt, L) — net-new allow/ask/deny + category + session-grant + YOLO, wired to Mastra `requireApproval`. *Nothing dangerous ships before this.* Extend `mastra-tool-execution.spec.ts` with a real ask-gated tool.
2. **Event-seam extension** ("acp-harness", build-fresh, L) — add `agent.subagent.*`, `plan.approval.*`, `ask.question.*`, `task.updated`, `shell.output`, `hook.*` kinds to `run-events.ts` + `DataStreamMapper` + hydration fixtures. Write the ADR that brainstrike does **not** adopt the Harness (records the version/storage/transport mismatch so the decision doesn't get re-litigated).

**Wave 2 — Coding-agent core (the RAG→coding-agent jump):**
3. **Editing + LSP** (adapt, XL) — write/string-replace(fuzzy)/AST tools behind permissions; per-file write lock; **re-index the edited file via `job_queue`** (PGlite RAG coherence — a constraint mastra-code structurally lacks); LSP is desktop-only *optional enrichment* (never a hard dep, or web editing breaks); web editing via File System Access `readwrite` upgrade.
4. **Search/shell/web** (adapt, XL, desktop-only) — glob (over `file_records` first, ripgrep fallback), **hybrid live+index grep** (required the moment edit tools exist, or the agent loops on stale index results), shell with the full detached+tree-kill+global-set+finally teardown recipe (test with **real** subprocesses), provider-native-first web search. All capability-gated off web.

**Wave 3 — Orchestration & UX (depend on Waves 1–2 producers):**
5. **Subagents** (adapt, XL) — reuse `createMastraAgentRuntime` with constrained tool subset derived from the **same tool-categories registry** that powers permissions; nested activity as first-class run-events (not the `<subagent-meta>` text tag); hard-cap nesting/concurrency for token-cost safety. (execute-persona blocked on Wave 2.)
6. **Hooks** (adapt, L) — PreToolUse/PostToolUse/Stop at the `guardToolExecution` insertion point; desktop shell hooks + web-safe in-process JS hooks; THROW on malformed `hooks.json`.
7. **Slash commands** (adapt, L) — build on the existing `packages/context-actions` registry (one command source for right-click + ⌘K + `/`); PGlite file index as the ⌘P backend; `!\`shell\``/`@file` gated behind permissions + tool-guard.

**Wave 4 — Surfacing & polish (mostly independent, can interleave):**
8. **Token-cost** (adapt, M) — `pricing?:` field in `provider-registry.ts`; durable per-thread cumulative usage from `mastra_messages`; "cost unavailable" not silent `$0.00`; local model = `$0`/undefined.
9. **OM meter** (adapt, M) — read the existing PGlite OM row into a live meter, **unified** with the context-usage meter (not a second confusing bar); pin `@mastra/memory` + add a schema-drift projection test.
10. **Notifications** (adapt, M) — driven off run-events; v1 = completion + error only (approval/plan need Wave 1+2 producers); visible-renderer-only; coalesce bursts.
11. **Diff/terminal/git** (adapt, XL, desktop-only) — `@codemirror/merge` for real syntax-highlighted diffs (reuse CodeSurface lang resolution); typed IPC domains; node-pty native-module asarUnpack/rebuild (the dev-passes/packaged-fails trap); scope per active root.

**Evaluate, likely defer or skip:**
- **Auth/OAuth subscription** (adapt, XL) — **legal/ToS gate first** (undocumented hardcoded client IDs against claude.ai/chatgpt.com). If pursued: encrypted safeStorage (not plaintext `auth.json`), single-flight refresh, anthropic-beta **merge-not-replace** with a live test (the §20 trap), web manual-paste as canonical path.
- **MCP** (verdict **skip**) — brainstrike's consumer is already more capable; only worthwhile work is unifying the two client stacks (live-loop test mandatory) and Streamable-HTTP/web support.
- **Data-architecture libsql split** (adapt, XL) — **measure first**; if inference/embedding dominate wall-clock, relieving DB-connection contention buys little (the deferred-PR4 lesson). libsql is Node-only → permanent desktop/web divergence.
- **AgentDashboard + git-worktree isolation** — **do not port**; they assume process-per-project, which contradicts brainstrike's multi-root-in-one-renderer model. The *aggregation idea* (cross-thread token/cost) is the only transferable kernel.

---

## Phase 5 — Anti-Patterns & Traps Catalog (the "don't" list)

1. **Copy-pasting from a `src/` reference module.** If it has zero importers (§1.1), the running behavior is Harness-internal — the file may be stale or incomplete (it's documentation, not the implementation).
2. **Assuming IPC where brainstrike uses the data-stream.** mastra-code routes everything through `harness:command`/`harness:event`; brainstrike's agent path is loopback HTTP/SSE (web has no IPC). Wrong transport assumption = web-broken feature.
3. **Replicating silent fallbacks.** `?? 'ask'`, `return 0` for unknown models, swallow-on-parse-error all violate brainstrike's mandated rigor — fix them in the port.
4. **Mocked-only tests for live-loop changes.** The documented incident: mocks green, real tool calling dead. Always extend the real-agent-loop specs.
5. **Single-cwd path resolution.** mastra-code's `session.projectRoot` does not exist in brainstrike — resolve through rootId, key by durable rootId not path.
6. **Shipping dangerous tools ungated.** mastra-code defaults to YOLO=allow-all; for a local-first app users trust with their codebase, shell/edit must land behind the permission engine.
7. **Depending on vendored package internals.** Gap #20 required pnpm-patching minified `mastracode` dist to fix an OAuth header drop — exactly the opaque coupling brainstrike avoids by owning its loop. Don't reintroduce it.
8. **Forgetting a registry.** Tool changes touch 5 registries; model-catalog changes touch 2 migration ledgers + 2 lane registries. Partial registration is the silent-break class.
9. **Building producers and consumers out of order.** Notifications/hooks/plan-gates have no triggers until permissions + write/shell tools exist.
10. **Porting the worktree/dashboard model.** It is architecturally incompatible with multi-root-in-one-renderer; building it is wasted effort plus an unwanted git dependency.

---

## Quick-reference: the repeatable loop per feature

```
0. Read ROADMAP/UPSTREAM_GAPS rows for the feature → is it real ([x]) and which gaps are OPEN(app-owned)?
1. grep-for-importers + call-site classify → Harness-native (replicate) | app-owned (port pattern) | brainstrike-already-better (skip)
2. Trace UI→transport→tool→loop→persist in BOTH apps → diff = the port spec
3. Gate: unblocked by deps? web/desktop capability decided?
4. Spike → extract pattern (not code) → adapt to brainstrike registries → honor invariants
5. LIVE-loop tests + real-row hydration fixtures + resilience wiring
6. Clean bar in one run (build+lint+type+unit; +lanes if catalog/db; doctor scope:changed; knip)
7. Update CLAUDE.md/AGENTS.md section for the touched seam (living-document rule)
```

**Files this playbook is anchored to (all verified to exist):** brainstrike — `packages/agent/src/mastra/agent-runtime.ts`, `packages/agent/src/tools/guard-tool-execution.ts`, `packages/agent/src/stream/{data-stream-mapper,with-inactivity-timeout}.ts`, `packages/agent/src/config/resilience-config.ts`, `packages/agent/src/pglite-mastra-memory/`, `packages/agent/src/tools/{schemas.ts + read-only tool set, no write/edit/shell}`, `packages/agent/src/mastra/default-instructions.ts`, `packages/assistant-contract/src/{tool-categories,tool-schemas-display,run-events,provider-registry}.ts`, `apps/desktop/src/assistant-server/{assistant-tools,grep-search-tool}.ts`, `packages/agent/src/__tests__/{mastra-tool-execution,mastra-memory-persistence}.spec.ts`. mastra-code-ui — `ROADMAP.md`, `UPSTREAM_HARNESS_GAPS.md`, `MONOREPO_MIGRATION.md`, `package.json` (`mastracode@0.5.1` + `@mastra/core@1.9.0` + `@mastra/libsql@1.6.3` + `patches/mastracode.patch`), `src/electron/main.ts` (`createMastraCode` at line 82).


===== SYNTH:ROADMAP (22628 chars) =====
Both load-bearing facts confirmed: `@mastra/core@^1.37.1` (large gap from mastra-code's 1.9.0), no harness/mastracode/libsql anywhere, and the tools dir is entirely read-only RAG/search (no write/edit/shell). I have everything needed. Producing the roadmap.

---

# BRAINSTRIKE → CODING-AGENT: DEPENDENCY-ORDERED ROADMAP + STRATEGIC DECISION

## 1. THE STRATEGIC DECISION: Adopt Harness wholesale vs. replicate selectively vs. stay bespoke

**RECOMMENDATION: Stay bespoke on the agent loop; replicate selectively from mastra-code's *patterns* (not its code); never import `@mastra/core/harness`, `mastracode`, or `@mastra/libsql`.**

### The case FOR adopting the Harness (argued honestly)

mastra-code's central bet paid off spectacularly: **15 of 17 capability gaps closed by upstream version bumps, not app code.** By buying `createMastraCode()`, the app got — for free, maintained by Mastra — a category permission engine, observational memory with observer/reflector split, subagent execution, plan-approval, token accounting, OAuth model auth, and a typed event bus. Brainstrike wants *most* of those things (permissions, subagents, plan-gates, richer OM surfacing). Replicating them is, by the domain estimates, **5×XL + 4×L + 5×M of net-new work**. The Harness would collapse a huge fraction of that to integration glue. If brainstrike's goal were purely "become a coding agent fastest," the Harness is the rational buy.

### The case AGAINST (why it loses here)

1. **Storage is a hard incompatibility.** The Harness is welded to `@mastra/libsql`; brainstrike is PGlite with a dual-runner migration architecture, Mastra-v2 message persistence, and snapshot-grouping reload hydration that took multiple PRs to get right. `@libsql/client` is Node-only — **it cannot run in the web renderer at all.** Adopting the Harness either abandons the web surface or forces a permanent dual-stack. Brainstrike is web+desktop by mandate; the Harness is desktop-only by construction.

2. **Brainstrike already owns equivalent seams, and they're better-suited.** It has `createMastraAgentRuntime` (1398 LOC), its own OM (`pglite-mastra-memory`, with a real persistence/hydration proof), three live resilience layers, a typed run-event taxonomy that flows over **HTTP/SSE so it serves web AND desktop** (the Harness's IPC bus can never do this), metadata sanitization (secret redaction) the Harness lacks, and a DB-backed model catalog. Adopting the Harness would mean *deleting* working, tested, web-capable infrastructure to replace it with a desktop-only black box.

3. **Version gap is disqualifying.** Brainstrike is on `@mastra/core@^1.37.1`; mastra-code's Harness is `1.9.0`. The `/harness` export, the subagent-via-config support, and the typed event union mastra-code depends on are a *different*, *older* API line. Wholesale adoption isn't a version bump — it's adopting a divergent product.

4. **Vendored-internals fragility is exactly what brainstrike's architecture rejects.** mastra-code had to `pnpm-patch` minified `mastracode/dist/chunk-*.js` to fix the OAuth `anthropic-beta` header-drop bug (gap #20). Brainstrike's whole philosophy ("own your loop," "no silent fallbacks") is the opposite of patching a vendored agent bundle's dist on every breakage.

5. **The single-cwd / one-Harness-per-worktree model doesn't map.** Brainstrike is multi-root-in-one-renderer with durable `rootId` identity (6 landed PRs + the #1197/#1198 same-named-root fixes). The Harness's process-per-project isolation is a foreign substrate.

**Verdict: replicate the *designs* into brainstrike's existing systems.** The category permission model (read/edit/execute/mcp + allow/ask/deny + session grants + YOLO), the fuzzy-match edit engine, the LSP diagnostics loop, the OM progress meter, the subagent persona+constrained-toolset pattern, the slash-command/palette UX, and the git-remote identity idea are all *learnable patterns*. The 10 domains marked `adapt`, 1 `build-fresh`, and 1 `skip` in the analysis all point the same way: **bespoke loop, ported patterns.**

---

## 2. DEPENDENCY GRAPH (validated from the domain `dependsOn` edges)

I resolved the 14 domains into a DAG. Note: the raw `dependsOn` arrays contain several **reverse/aspirational edges** (e.g. `permissions` lists `editing-lsp` as a dependency, but permissions must precede edits; `token-cost` lists `subagents`, but cost must precede subagent budgeting). I corrected these to true build-order by asking "what must EXIST before this can function safely," producing the phases below. The corrected foundational ordering is:

```
data-architecture(decide) ─┐
token-cost ────────────────┼─► permissions ─► editing-lsp ──► subagents
observational-memory ──────┘        │            search-shell-web ┘
                                     ├─► hooks
acp-harness (event seam, ongoing) ──┘   slash-commands ─► notifications
diff-terminal-git (parallel, desktop) ──────────────────────────────────┘
mcp (independent, skip/defer)
auth-oauth (independent, gated on legal)
```

---

## 3. PHASED ROADMAP (dependency order, with rationale)

### Phase 0 — Foundation decisions & event-seam hardening *(do FIRST; cheap, unblocks everything)*
**Domains:** `acp-harness` (build-fresh, L) · `data-architecture` (decision only of the XL) · `token-cost` groundwork (M)

- **Write the ADR** committing to bespoke-loop / ported-patterns (kills re-litigation risk flagged in `acp-harness`).
- **Name and document the existing event seam as "the brainstrike agent event bus"** (run-events + DataStreamMapper + assistant-server) so it has the conceptual clarity the Harness gives without the lock-in. Encode mastra-code's closed gaps (typed events, `promptTokens ?? inputTokens` field reconciliation, permission categories) as **contract tests** so brainstrike never re-hits those bugs.
- **`data-architecture`: DECIDE, don't build.** The full PGlite→pooled-SQLite split is XL and the prompt's own perf note + deferred PR4 suggest inference dominates DB I/O. **Gate the XL build behind a measurement** (instrument memory-write contention first). Default outcome: stay PGlite-only; revisit only if measured contention is real. This is a decision gate, not Phase-0 construction.
- **`token-cost` groundwork:** add optional `pricing?: {inputPerMTok, outputPerMTok}` to the static `provider-registry.ts` (co-located with the existing compile-enforced `contextWindow`), so later phases can show cost honestly (unknown → "cost unavailable," never silently-wrong $0).

**Rationale:** the event taxonomy and the data-layer decision are upstream of every coding-agent feature; permission/subagent/notification events all extend the same union. Deciding the data layer now prevents an XL detour mid-stream.

### Phase 1 — Permission engine *(the gate everything mutating must pass through)*
**Domain:** `permissions` (adapt, L) · `applicability: both`

- Add the risk taxonomy (`read|edit|execute|mcp`) **derived from the existing `UnifiedToolMetadata.requiresApproval`** single source of truth — do NOT hand-maintain a second `TOOL_CATEGORY_MAP` that silently mis-buckets new tools (mastra-code's drift trap).
- Add allow/ask/deny policy + session grants (`always_allow_category`) + a YOLO preset, persisted in a new preference store **registered in `clearPersistentUiState()`** (Factory Reset contract).
- **Wire the dormant `requireApproval` flag into the live Mastra registration** — and extend `mastra-tool-execution.spec.ts` with a *real* ask-gated tool (not mocked), per the documented LIVE-validation invariant.
- Strict-parse policy config (throws on unknown category/policy — no-silent-fallbacks).

**Rationale:** **Permissions MUST precede edit/shell tools.** Shipping write/exec ungated on a local-first app users trust with their codebase is the single largest safety risk in the whole port. This is the hard prerequisite for Phases 2–3.

### Phase 2 — Edit tools + LSP feedback loop
**Domain:** `editing-lsp` (adapt, XL) · `applicability: both`

- Port the **4-tier fuzzy-match engine verbatim** (exact → whitespace → char → Levenshtein, with the single-line ambiguity guard and "diverged after N lines" diagnostic) — do not "clean it up" or it corrupts files.
- Per-file write lock (Mastra runs step tool-calls concurrently — real data-loss race without it).
- `write_file` + `string_replace`. **AST-edit (`@ast-grep/napi`) and LSP are DESKTOP-ONLY optional enrichment** — editing must not hard-depend on LSP or web editing breaks.
- **Brainstrike-native wins:** after a successful edit, enqueue re-chunk/re-embed on the existing `job_queue` and mark the file dirty in `collection_indexing_stats` (RAG index coherence — something mastra-code structurally cannot do). Route edit approval through the Mastra suspend/resume path showing a **rendered diff** (ties to Phase 4 diff viewer).
- **Web edit path:** upgrade File System Access from read-only to a one-time `readwrite` permission + `FileSystemWritableFileStream` — makes brainstrike a coding agent on web, which mastra-code never solved.

**Rationale:** depends on `permissions` (the edit gate) and `data-architecture` decision (index coherence). LSP depends on a desktop child-process backbone, so it's gated to desktop.

### Phase 3 — Shell / glob / live-grep / web-search *(desktop-only)*
**Domain:** `search-shell-web` (adapt, XL) · `applicability: desktop-only`

- **Glob** over the indexed `file_records` table by default (zero subprocess, multi-root-aware, gitignore already applied), with a live `git ls-files`/ripgrep fallback flag.
- **Hybrid live+index grep** — required, not polish: the moment edit tools exist (Phase 2), index-only grep returns stale results post-edit and the agent loops. Run trigram-PGlite grep AND a live ripgrep pass, merged, surfacing which engine produced each match.
- **Shell** with the full `detached + tree-kill + global-set + finally` process-group teardown (test with real subprocesses, not mocks). Gated behind the Phase-1 permission engine — **never default-YOLO.**
- Web search: invert mastra-code's Tavily-first to **provider-native-first** (no extra key), Tavily only when a key exists in the encrypted keychain. Verify the provider fetch **merges** `anthropic-beta` headers (the gap-#16/#20 clobber trap).
- **Defer browser/computer-use** (lowest value, ~150MB playwright footprint).
- All capability-gated per platform (web simply never constructs these — no `isElectron()` checks, no disabled stubs).

**Rationale:** depends on `permissions` (shell is the biggest exec-safety surface) and is tightly coupled to `editing-lsp` (the staleness correctness trap). Desktop-only by construction (no Node/child_process on web).

### Phase 4 — Diff viewer, terminal, git UI *(desktop-only, parallelizable with Phase 2–3)*
**Domain:** `diff-terminal-git` (adapt, XL) · `applicability: desktop-only`

- Real syntax-highlighted diffs via **`@codemirror/merge`** (one-dep add; reuse `CodeSurface` language resolution) — strictly better than mastra-code's green/red tints.
- Typed `terminal` + `git` IPC domains via `createDesktopIpcRegistry` (compile-safe, vs mastra-code's stringly-typed dispatcher). `node-pty` + `@xterm/*`; **async `execFile` for git** (mastra's `execSync` would block brainstrike's main-process Mastra loop).
- Capability-gate off the active root's absolute path; tear down PTYs on root-switch (wire into desktop lifecycle disposers); hard-gate web/FS-Access roots (no real git/PTY).
- Share the PTY IPC + git wrapper with Phase-3's shell tool so UI and agent use one audited path.

**Rationale:** independent of permissions for the *human-facing* UI, but the diff viewer feeds Phase-2 edit-approval UX, so sequence it alongside edits. Desktop-only (native modules).

### Phase 5 — OM progress meter + token/cost surfacing *(UX payoff on existing infra)*
**Domains:** `observational-memory` (adapt, M) · `token-cost` finish (M) · `applicability: both`

- **Unify** the OM meter with the existing context-usage meter into one tri-segment "thread budget" surface (chat / observation / reflection), keyed by `selectedMemoryThreadId`. Drive it **reactively via PGlite `live` queries** on the OM row (no poll-on-event), works web+desktop.
- Pin `@mastra/memory` + add a projection test that fails loudly on OM-row schema drift (brainstrike reads raw columns the Harness insulates via `getDisplayState()`).
- Surface the **compaction benefit** ("this reflection saved ~Nk tokens / removed M messages").
- Cost: durable per-thread cumulative usage **derived from `mastra_messages`** (a local-first advantage mastra-code's session-only totals can't have); honest provenance (hide cost chip when unpriced).
- **Verify the observer/reflector split is even supported in `@mastra/memory` 1.6.x before promising it** — if single-model-only, that's an upstream gap, expose split as optional-advanced if it lands.

**Rationale:** depends only on `token-cost` groundwork (Phase 0). Pure brainstrike-side UX over engine state that already exists; no coding-tool prerequisite, so it can slot in early if desired.

### Phase 6 — Slash commands + command palette + quick-open
**Domain:** `slash-commands` (adapt, L) · `applicability: both`

- Build palette + `/` + ⌘P on the **existing `packages/context-actions` registry** so right-click menus, ⌘K, and `/` project from ONE command source (mastra-code re-declares per surface).
- QuickFileOpen backed by the **PGlite file index** (works web+desktop, multi-root, no `git ls-files` spawn).
- `@file` resolves through the index/VFS; `!`shell`` and config-dir scan are **desktop-only, gated behind Phase-1 permissions + the tool-guard timeout** (mastra-code's bare 30s `execSync` with no approval is a real attack surface — a malicious `.brainstrike/commands` could exec on open).
- **Highest-uncertainty item:** verify `@assistant-ui/react` `ComposerPrimitive.Input` can host inline `/` autocomplete before committing to that approach.

**Rationale:** depends on `permissions` (for `!`shell`` macros) and `search-shell-web` (shell expansion). The pure-UI half (palette, builtins, quick-open) has no hard deps and could ship earlier.

### Phase 7 — Subagents
**Domain:** `subagents` (adapt, XL) · `applicability: both`

- Reuse `createMastraAgentRuntime` as the spawner with a **constrained tool subset derived from the same tool-categories registry** that powers permissions (single source of truth — a read-only persona *provably* can't get a write tool).
- Personas **data-driven via the DB-catalog/preferences pattern** (user-extensible), not hardcoded TS.
- Persist nested activity as **first-class run-events** (`subagent.started/tool.*/finished` grouped by `parentToolCallId`), not mastra-code's brittle `<subagent-meta>` text tag — so reload hydration renders subagent cards identically to live.
- Reuse the existing per-tool guards + stream watchdog *inside* the child loop; token-budget the child's returned summary; hard-cap nesting depth + concurrent children (cost/recursion blowup).
- **RAG-native explore persona** (queryEmbeddingSpace + grepSearch + hybrid) — a genuinely better "explore" than mastra-code's grep-only. Run read-only subagents on the keyless local Gemma.
- **DO NOT** port AgentDashboard / git-worktree isolation — they don't fit local-first multi-root web+desktop.

**Rationale:** the most-cited dep in the graph (depends on editing-lsp, search-shell-web, permissions, OM, token-cost, tool-call-ui, slash-commands). The useful `execute` persona is **blocked until Phases 2–3 land**; only read-only explore/plan are buildable before that.

### Phase 8 — Cross-cutting polish
**Domains:** `notifications` (adapt, M) · `hooks` (adapt, L) · `mcp` (skip/defer, M) · `auth-oauth` (adapt, XL, **legal-gated**)

- **`notifications`:** v1 = completion + error only (brainstrike's run events already emit these); approval/plan/question branches have no producer until Phases 1+7. Drive off the typed run-event stream; filter to the visible renderer (not hidden hosts); cross-platform badge.
- **`hooks`:** low standalone ROI until mutation tools exist — sequence WITH (not before) editing/shell. Web-safe in-process JS hooks + desktop shell hooks (capability-gated). Throw on malformed `hooks.json`.
- **`mcp` (verdict: SKIP for consume; brainstrike already has a *more* capable MCP consumer than mastra-code).** The real opportunity is **unifying the two duplicate MCP client stacks** (raw SDK discovery + `@mastra/mcp` execution connect twice) and bringing HTTP/SSE MCP to web — small, optional.
- **`auth-oauth` (XL, do LAST and only after legal review):** subscription OAuth against claude.ai/chatgpt.com uses undocumented hardcoded client IDs intended for official CLIs — **ToS/legal review is a hard gate before any work.** When/if approved: store tokens in encrypted `safeStorage` (not mastra's plaintext `auth.json`), add the `credentialResolver`/custom-fetch seam to `provider-factory.ts`, ship the gap-#20 header **merge** (with a test asserting an SDK beta survives) — the "ideal fix" mastra only patched.

---

## 4. EFFORT / RISK / VALUE MATRIX (all 14 domains)

| # | Domain | Verdict | Effort | Value | Risk | Applicability | Phase |
|---|--------|---------|--------|-------|------|---------------|-------|
| 1 | **permissions** | adapt | L | **Very High** (gate for all mutation) | High (live-loop regression; dormant gate untested) | both | **1** |
| 2 | **editing-lsp** | adapt | XL | **Very High** (defines coding agent) | High (file corruption if fuzzy-match altered; web readwrite) | both | **2** |
| 3 | **search-shell-web** | adapt | XL | **Very High** (shell = the RAG→coding leap) | **Highest** (arbitrary exec; index staleness) | desktop-only | **3** |
| 4 | **acp-harness** (event seam) | build-fresh | L | High (unblocks all, ADR clarity) | Med (taxonomy drift across hydration) | both | **0** |
| 5 | **data-architecture** | adapt | XL | Med (win may be small if inference-bound) | High (web can't run libsql; cross-store consistency) | desktop-only | **0 (decide)** |
| 6 | **token-cost** | adapt | M | Med-High (cost honesty, durable totals) | Low-Med (pricing drift; provenance) | both | **0/5** |
| 7 | **observational-memory** | adapt | M | Med-High (visible value-add) | Med (raw-column coupling; observer/reflector may be unsupported) | both | **5** |
| 8 | **diff-terminal-git** | adapt | XL | High (review loop, feeds edit UX) | High (node-pty packaged-only failures; raw-shell sandbox escape) | desktop-only | **4** |
| 9 | **slash-commands** | adapt | L | Med-High (UX, registry leverage) | Med (`!`shell`` exec; composer API uncertainty) | both | **6** |
| 10 | **subagents** | adapt | XL | High (fan-out, RAG-native explore) | High (recursion/cost blowup; hydration grouping) | both | **7** |
| 11 | **notifications** | adapt | M | Med (attention UX) | Low-Med (autoplay; focus source-of-truth; hidden-host) | both | **8** |
| 12 | **hooks** | adapt | L | Low-Med (until mutation tools exist) | Med (blocking freeze vector; exfiltration) | both | **8** |
| 13 | **mcp** | **skip** | M | Low (brainstrike already ahead) | Med (live-path unification; web secret-at-rest) | both | **8 (opt)** |
| 14 | **auth-oauth** | adapt | XL | Med (subscription auth) | **Highest** (ToS/legal; revocable undocumented endpoints) | both | **8 (legal-gated)** |

**Effort tally:** 5×XL (editing-lsp, search-shell-web, data-architecture, diff-terminal-git, subagents, auth-oauth = actually 6×XL), 4×L (permissions, acp-harness, slash-commands, hooks), 4×M (token-cost, OM, notifications, mcp).

---

## 5. DESKTOP-ONLY vs WEB-APPLICABLE SPLIT

**Desktop-only by construction (no Node/fs/child_process/native-modules in the web renderer):**
- `search-shell-web` (shell, glob-via-subprocess, live ripgrep, browser/computer-use)
- `diff-terminal-git` (node-pty, git shell-outs)
- `data-architecture` libsql split (`@libsql/client` is Node-only)
- LSP backbone within `editing-lsp` (spawns language-server child processes)
- `!`shell`` macros + config-dir scan within `slash-commands`
- Desktop shell **hooks** within `hooks`

**Web-applicable (must ship on both, using brainstrike's HTTP/SSE + FS-Access + PGlite substrate):**
- `permissions` (normal local-first preference store, both surfaces)
- `editing-lsp` **write/string-replace** via `FileSystemWritableFileStream` (web's coding-agent unlock; LSP/AST are the desktop-only enrichment)
- `editing-lsp` **index-grep** (PGlite, identical both surfaces)
- `observational-memory` meter, `token-cost` (read PGlite OM row in-renderer on web, via IPC bridge on desktop)
- `slash-commands` palette + `/` + quick-open (PGlite-index-backed)
- `subagents` (route through assistant-server loop on desktop; web-safe path — **known caveat:** web local chat uses in-renderer `LocalRuntimeChat` with no server loop, so a web-local subagent needs a distinct path or is unavailable)
- `notifications` (Electron `Notification` on desktop; browser Notification API on web)
- in-process JS **hooks** (web-safe alternative to shell hooks)
- `mcp` HTTP/SSE servers (web-reachable; stdio is desktop-only)
- `auth-oauth` manual-paste/redirect flow (canonical, web+desktop; desktop loopback server is progressive enhancement)

**The governing rule across all of this** (from brainstrike's Context Action System): **capability-gate, never `isElectron()`-check, never render disabled "desktop only" stubs.** Web simply never constructs the desktop-only tool.

---

## 6. THE ONE-LINE COMMIT

Brainstrike should **stay bespoke and replicate selectively**: own the loop, port the *patterns* (category permissions → fuzzy-edit → live+index grep / shell → subagents), and exploit the three things the Harness can never have — **web parity (HTTP/SSE event bus + FS-Access writes), RAG-index coherence on edits (job_queue re-embed), and keyless local-model fan-out.** Build in strict dependency order — **permission engine before any mutating tool, edit+shell before subagents, data-layer decided (not built) up front** — and gate `auth-oauth` behind legal review and `data-architecture`'s XL build behind a measurement.

**Files validated:** `/Users/seandearnaley/Documents/GitHub/brainstrike/.claude/worktrees/flamboyant-antonelli-4a4b6a/packages/agent/package.json` (`@mastra/core@^1.37.1`), `packages/agent/src/tools/` (all read-only: diagnostics/docs-search/embedding-sets/file-tree/hybrid-search/queue-status/retrieval/workspace-index-retrieval — no write/edit/shell), `packages/agent/src/mastra/agent-runtime.ts`, `packages/agent/src/tools/guard-tool-execution.ts`; confirmed-empty grep for `@mastra/core/harness | mastracode | @mastra/libsql` across `packages/` + `apps/`.


===== SYNTH:DIFFERENTIATORS (10428 chars) =====
# HOW OURS BECOMES BETTER — Brainstrike's Differentiation Strategy

mastra-code-ui is a thin Electron shell over a published agent bundle (`mastracode` + `@mastra/core/harness` + `@mastra/libsql`). Its value is UI/IPC; its intelligence is rented. Brainstrike owns its loop, its storage, its embeddings, and its RAG index. That ownership is exactly what lets us leapfrog rather than chase. Below: where we win, and the 5-7 differentiators to prioritize — each tied to a real brainstrike capability that mastra-code structurally *cannot* match.

---

## The structural asymmetry

| Axis | mastra-code-ui | brainstrike | Who wins, and why |
|---|---|---|---|
| Agent loop | rented Harness (opaque, version-pinned, patched via minified-dist pnpm patches) | own `createMastraAgentRuntime` + 3 live resilience layers | **brainstrike** — every event/decision is ours to stream, redact, and test |
| Storage | LibSQL, one file, no vector index | PGlite + pgvector HNSW + FTS + hybrid RRF, all local | **brainstrike** — the agent can *search semantically*; mastra-code greps disk blind |
| Retrieval | ripgrep over live FS only | trigram-prefiltered grep **+** `queryEmbeddingSpace` **+** hybrid fusion | **brainstrike** — lexical *and* semantic, fused |
| Platform | macOS-only desktop, unsigned | web **+** desktop, capability-gated | **brainstrike** — a coding agent in the browser is something mastra-code can never ship |
| Local inference | always bills a hosted model | keyless Gemma llm-host + local embedders | **brainstrike** — private, free, offline-capable agent loops |
| OM | rented, surfaced as disconnected status items | own pglite-mastra-memory, persisted + hydrated, live-queryable | **brainstrike** — observable, unified, local-model-capable |

mastra-code rented its way past 15 of 17 upstream gaps with version bumps. The flip side: it cannot do anything the Harness doesn't expose, and it pays a lock-in tax (the §20 OAuth-header pnpm-patch on minified dist is the canonical cautionary tale). Brainstrike's "own the loop" bet means **net-new work**, but every feature lands on substrate mastra-code lacks.

---

## The 7 highest-leverage differentiators (prioritized)

### 1. RAG-grounded edits — the index *is* the agent's working memory
**Tie-in:** PGlite `job_queue` (lease-based re-embed), `collection_indexing_stats` dirty-gating, `FileChunkRepository`.

mastra-code's edit tools `writeFileSync` and forget — it has no index to keep coherent. Brainstrike can make the **edit→re-chunk→re-embed loop transactional**: every successful write enqueues a re-embed job for that path so semantic search never goes stale, and records `(path, oldHash, newHash, diff)` in PGlite as an undoable, crash-recoverable **edit journal**. This is the single biggest correctness advantage: an editing agent that greps its own index gets *fresh* results. mastra-code structurally cannot offer this — it has no index to invalidate. *(domains: editing-lsp, search-shell-web)*

### 2. Hybrid live+index grep — semantic grep fused with trigram, with a freshness guarantee
**Tie-in:** `GrepSearchService` (trigram prefilter + JS matcher), `queryEmbeddingSpace`, `HybridSearchService` (FTS+vector RRF).

mastra-code has exactly one search mode: ripgrep over disk. Brainstrike already has three (trigram-grep, semantic, hybrid-RRF) and can **fuse them**: instant index-grep for the common case, a live ripgrep pass to catch just-edited/gitignored/unindexed files, *and* semantic recall when the exact string is unknown — each match labeled by which engine found it. Glob defaults to the indexed `file_records` table (multi-root-aware, gitignore already applied, zero subprocess) with a live-FS fallback flag. This is a strictly richer retrieval surface than mastra-code's, and it's the differentiator that compounds with every other tool. *(domain: search-shell-web)*

### 3. Local-first, no-cloud agent — keyless coding agent on the built-in Gemma
**Tie-in:** `LlmHostChatModel` proxy, `local-llm-host-client`, keyless local OM + local embedders (LOCAL LLM ARCHITECTURE).

mastra-code always bills a hosted model — even its subagents, even its OM observer/reflector. Brainstrike runs **chat, observational memory, AND embeddings keyless** through the hidden llm-host. That means: private fan-out subagents at zero marginal cost, an OM meter that shows `$0` honestly for local inference, and an agent that works **offline with no API key**. For a tool users trust with their entire codebase, "the agent never phones home unless you tell it to" is a category-defining stance mastra-code's rented-hosted-Harness can't take. *(domains: subagents, observational-memory, token-cost)*

### 4. Vector-aware subagents — RAG-native fan-out the explore persona deserves
**Tie-in:** `createMastraAgentRuntime` (already a subagent spawner in miniature), run-event bus, per-tool guards, tool-categories registry as the capability source of truth.

mastra-code's `explore` persona is grep-only. Brainstrike's explore persona gets `queryEmbeddingSpace` + `grepSearch` + hybrid RRF, so parallel children fan out **semantic and lexical** retrieval and the parent fuses. Three further wins it can't match: (a) persist nested activity as **first-class run-events** (`subagent.started`/`subagent.tool.*`) instead of mastra-code's brittle `<subagent-meta>` text tag, so reload hydration renders subagents identically to live; (b) run the per-tool guard + stream watchdog *inside* the child loop so a wedged subagent can't freeze the parent (mastra-code's reference impl has only `maxSteps:50`); (c) derive each persona's tool whitelist from the **same** tool-categories registry that powers permissions — a read-only persona provably cannot be handed a write tool. *(domain: subagents)*

### 5. The agent event bus done right — transport-portable, secret-redacted, resilience-transparent
**Tie-in:** `AssistantRunEvent` union, `DataStreamMapper`, loopback HTTP/SSE server, the 3 LIVE resilience layers, metadata sanitization.

mastra-code's "event bus" is `harness.subscribe` + Electron IPC — desktop-only and opaque. Brainstrike's run-event seam already flows over **HTTP/SSE, so one event union serves web AND desktop**. Extend it to coding-agent parity (`plan.approval.*`, `ask.question.*`, `task.updated`, `shell.output`) while keeping brainstrike's **secret redaction** (the Harness lacks it) so streamed events are safe-by-construction. Critically, **stream the resilience decisions themselves** (tool-guard timeout → `tool.failed` with reason; watchdog stall → `run.failed`) so the UI surfaces *why* something stopped — transparency mastra-code's opaque harness cannot provide. *(domains: acp-harness, hooks, notifications)*

### 6. Context budget meter superiority — durable, multi-thread, honest cost
**Tie-in:** `context-usage-store` + `ContextUsageMeter`, `deriveEffectiveInputBudget` (throws, never clamps), one-number-three-consumers wiring, durable `mastra_messages`, real WASM tiktoken, PGlite live-queries.

mastra-code's totals are **session-only** (lost on restart) and its `estimateTokenCost` silently returns `$0` for unmapped models. Brainstrike can do four things it can't: (a) derive **durable per-thread cumulative usage** from persisted `mastra_messages` so reload shows real accumulated tokens, not a heuristic; (b) **cross-thread/cross-root aggregation** — the local-first answer to mastra-code's polled AgentDashboard, computed reactively via PGlite live-queries, no 3s polling; (c) **honest cost provenance** — unknown pricing renders "cost unavailable," never a confidently-wrong `$0.00` (the no-silent-fallbacks rule as a feature); (d) co-locate pricing with the existing compile-enforced `contextWindow` invariant in `provider-registry.ts` so it can't drift from the model catalog. Plus apply the already-vendored tiktoken to the tool-result budget, which brainstrike has but doesn't yet use. *(domains: token-cost, observational-memory)*

### 7. Observable, programmable permissions + hooks — policy as a first-class, web+desktop surface
**Tie-in:** `requireToolApproval` suspend/resume (already live), `tool-categories.ts` (single source of truth), `applyToolGuards`, `tool-approval-dialog.tsx` (built, richer than mastra-code's), preferences stores, FACTORY RESET contract.

This is the **gate that makes everything else safe to ship** — shell and edit tools without it would be reckless. mastra-code's permission engine is Harness-native and desktop-only; its session grants are in-memory and lost on restart. Brainstrike can build a permission/category policy as a **normal local-first preference store working identically on web and desktop**, wired into the FACTORY RESET contract so grants don't resurrect. Better still: a **PreToolUse hook can auto-approve/auto-deny**, turning hooks into a *programmable* permission policy on top of `requireToolApproval`, with a diff-preview approval card (reusing the already-built `tool-approval-dialog.tsx` mastra-code lacks) and a structured **audit log** via the pino logger. Every policy decision observable; malformed config throws, never coerces. *(domains: permissions, hooks)*

---

## Sequencing logic

- **#7 (permissions) is the safety gate** — it must land alongside, not after, the first mutation tool, or an unsandboxed agent can overwrite in-root files with no human gate.
- **#1, #2, #6** are the *immediately shippable* RAG/cost wins — they leverage substrate that already exists (index, search, meter) and don't depend on write tools.
- **#4 (vector subagents)** is buildable for read-only explore/plan personas *today* (RAG fan-out is the payoff); the execute persona unblocks once edit/shell tools land.
- **#3 (local-first)** is a stance to bake into #1/#4/#6 from day one, not a separate workstream.
- **#5 (event bus)** is the connective tissue — extend the union *before* adding producers (subagents, hooks, shell), and every new event kind needs a hydration fixture from real persisted rows (the documented silent-divergence trap).

**The one-sentence thesis:** mastra-code is a great UI bolted onto a rented brain; brainstrike owns the brain, the memory, and the index — so it can ground every edit in semantic retrieval, run the whole loop locally and privately, and surface every token, decision, and resilience event over a web+desktop event bus. That combination is not a feature gap mastra-code can close with a version bump — it's the architecture.