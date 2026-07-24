# Coding-Agent Phase 0-4 Handoff & Smoke-Test Guide
**Branch:** `feat/coding-agent` @ `14f556e2d` — 2026-06-20

> Audience: Sean, for extensive manual smoke-testing before Phase 5 (OM + cost meters) begins.
> Scope: Phases 0 through 4. Phases 5-8 are **not started** (see final section).

---

## 1. TL;DR

This branch turns BrainStrike's assistant from a **read-only RAG assistant** into a **full coding agent**: it can now write and string-replace workspace files, glob and grep the tree (hybrid index + live ripgrep), execute shell commands, search the web (Tavily), and operate a real Git panel with a CodeMirror diff viewer and an embedded xterm terminal — all gated behind a secure-by-default per-call permission engine. The integration health gate is **GREEN**: `pnpm install --frozen-lockfile` succeeds (including the new native `node-pty` darwin-arm64 prebuild), 68/68 turbo build + type-check tasks pass, the `lint:ci` CI gate exits 0 (4 advisory warnings, 0 errors), and ~6,094 unit tests across all 7 touched packages pass with **0 failures**. There are no red checks and no blockers — the branch is worth smoke-testing as one unit. **Test this first:** the enforce-on-by-default approval flow (Settings > Permissions, then ask the assistant to edit a file and confirm the Approve/Decline prompt appears for edit/execute but **not** for read-only tools) — this is the single biggest behavior change and the gate that protects every other new capability.

---

## 2. Integration health

**Verdict: GREEN.** Integrated `feat/coding-agent` (26 commits, HEAD `14f556e2d`, 20 PRs #1250-#1271, 133 files, +20,191 LOC; `main` fully in sync, 0 behind) passes every gate. **No red checks. No blockers.**

| Check | Status | Detail |
|---|---|---|
| `pnpm install --frozen-lockfile` | ✅ pass | ~10s. New deps resolved: `node-pty@1.1.0` (darwin-arm64 prebuild present, native helper chmod'd by desktop postinstall), `@xterm/xterm@6.0.0` + addon-fit/web-links, `@codemirror/merge@6.12.2`. Only a non-critical lefthook git-hook install warning. |
| build + type-check (turbo, touched pkgs + dependents) | ✅ pass | 68/68 tasks successful in ~31s (35 cached) across assistant-contract/agent/preferences/app-shell/ui/db/desktop. Desktop emits only pre-existing third-party direct-eval warnings (web-tree-sitter, pglite) — non-fatal. tsc `type-check:main` + `type-check:e2e` clean. |
| lint (CI gate: `pnpm run lint:ci`) | ✅ pass | Exits 0 on pristine HEAD: arch contracts + domain-boundaries (2378 imports, 0 exceptions) + eslint (`--max-warnings=50`) + `biome check .` → "Found 4 warnings", 0 errors, no tree mutation. The 4 warnings are advisory. |
| unit — @brainstrike/assistant-contract | ✅ pass | 9 files, 87 tests, 0 failed (~0.1s). |
| unit — @brainstrike/preferences | ✅ pass | 58 files, 679 tests, 0 failed (~3.7s). level:50 logs are intentional negative-path assertions. |
| unit — @brainstrike/app-shell | ✅ pass | 58 files, 613 tests, 0 failed (~14s). |
| unit — @brainstrike/ui | ✅ pass | 140 files, 1316 passed + 3 skipped, 0 failed (~5.4s). Covers new diff-view/terminal UI. |
| unit — @brainstrike/agent | ✅ pass | 69 files, 917 tests, 0 failed (~37s). Includes mastra live-loop tool-execution + memory-persistence proofs. |
| unit — @brainstrike/desktop | ✅ pass | 156 files, 1543 tests, 0 failed (~94s). Covers PTY IPC backend + grep-search tool wiring. level:50 logs are intentional error-path assertions. |
| unit — @brainstrike/db | ✅ pass | 5 lanes green (154+336+87+111+251 = 939 tests across 105 files), 0 failed (~5m37s). Real-PGlite migration/job-queue/search integration on the integrated schema. |
| biome check changed-set | ✅ pass | Warm run = 0 errors / 4 advisory warnings across 2598 files. No blocking findings in the 133 changed files. |

**Two lint false-positive traps were investigated and confirmed NOT real defects** (so you don't chase them):
1. Running the whole-repo root lint script via turbo across 28 packages concurrently self-races on `biome --fix` writes, producing a spurious `ELIFECYCLE`. The authoritative gate is `pnpm run lint:ci` (no `--fix`), which is deterministically clean.
2. A bare `biome check .` (no `--fix`) flaps 3 `organizeImports` "errors" on a **cold** cache that clear to 0 on a **warm** back-to-back run with a byte-identical tree. The `.d.ts` imports (`electron.d.ts`, `app-shell-shims.d.ts`, chunking-worker `shared.d.ts`) are objectively already sorted — it's a biome cold-cache assist artifact.

**One install caveat to note:** `tavily` is **not declared anywhere** in the integrated tree's `package.json` files, and that is correct — the Tavily web-search tool calls `https://api.tavily.com/search` with raw `fetch` and pulls its API key from the encrypted keychain at runtime (no SDK dependency). Web search is non-fatal when no key is configured.

**Strategy context:** STAY BESPOKE (ADR-0001) — these features replicate `mastra-code-ui` patterns but import **none** of its harness or libsql.

---

## 3. How to run it

### Launch the desktop app for live smoke-testing (recommended)

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug
```

This is the opt-in agent-debug launch: it enables Chrome-DevTools renderer debugging on **port 9222** with a throwaway profile. (Per AGENTS.md, do not add `--remote-debugging-port` to default desktop E2E; this command is the sanctioned path.) Main-process debugging remains separate via Electron `--inspect`.

### Pull an individual feature branch instead

The integrated branch is the right thing to test as a whole, but 12 feature branches are preserved on `origin` if you want to isolate one capability:

```
feat/ca-0.1-foundations      feat/ca-4.1-git-ipc
feat/ca-0.2-pricing          feat/ca-4.2-git-panel
feat/ca-3.2-hybrid-grep      feat/ca-4.3-pty-ipc
feat/ca-3.3-shell            feat/ca-4.4-terminal-ui
feat/ca-3.4-web-search       feat/ca-approval-flow
feat/ca-grep-correctness     feat/ca-p2-review-fixes
```

```bash
git fetch origin
git checkout feat/ca-3.3-shell        # example: just the shell-exec branch
pnpm install --frozen-lockfile
pnpm --filter @brainstrike/desktop dev:agent-debug
```

---

## 4. Smoke-test guide by feature

Each checklist is action → expected, directly followable. Most edit/execute steps assume **Enforce tool permissions is ON** (the default — see Section 5).

### 4a. Permissions + Per-Call Approval Flow

1. Open Desktop → **Settings > Permissions**.
   → Panel loads; **Enforce tool permissions** toggle is **ON** by default; four category cards visible (Read, Edit, Execute, MCP) with defaults **Read=Allow, Edit=Ask, Execute=Ask, MCP=Allow**; YOLO mode toggle **OFF**.
2. In the workspace, prompt the assistant to edit a file (e.g. "Change the function name from foo to bar in main.py").
   → Assistant suggests the edit; a tool-call-approval notice appears with risk metadata (Edit category) and **Approve** / **Decline** buttons. The notice does **NOT** appear for read-only calls (e.g. "List files in this folder").
3. Click **Approve**.
   → Edit tool executes; the approval notice closes; the assistant continues with the edited result.
4. Prompt another edit; when the notice appears, click **Decline**.
   → Edit tool is skipped; assistant receives the skip and continues (does not re-offer the same edit or error out).
5. In Settings > Permissions, change **Edit** from **Ask** to **Deny**.
   → Dropdown changes; the setting persists across revisits.
6. Prompt an edit again.
   → Edit tool is **NOT** offered; it does not appear in the model's tool list (no call, no prompt).
7. Change Edit back to **Ask**, then toggle **Enforce tool permissions OFF**.
   → Enforce switches OFF; category controls become disabled (grayed out); YOLO section remains but is ineffectual.
8. Prompt an edit.
   → Edit runs **WITHOUT** an approval prompt (full passthrough mode).
9. Toggle Enforce back **ON**, then toggle **YOLO mode ON**.
   → YOLO switches ON with a red "All tools allowed" badge; Enforce stays ON (YOLO is not a replacement for Enforce).
10. Prompt an edit + execute (e.g. "Edit main.py to add a function and run it").
    → Both tools execute **WITHOUT** approval prompts (YOLO overrides edit:ask and execute:ask).
11. Reload the app (close + reopen) → Settings > Permissions.
    → Enforce still **ON** (persisted); category policies as last set (persisted); **YOLO OFF** (session-only, cleared on reload).
12. Open the **Web** app → Settings > Permissions.
    → Same panel; all controls present; caveat note at bottom reads "Enforcement currently applies to the desktop assistant runtime."
13. On web, change policies/YOLO, then prompt an edit.
    → Web respects enabled/disabled tools by policy (read runs, edit/execute omitted), but **NO** approval notice appears (web has no tool-approval resume).

### 4b. Edit Tools (`writeWorkspaceFile`, `stringReplaceWorkspaceFile`)

1. In desktop, prompt: "Create a test file at test.txt with content Hello World".
   → Approval prompt appears (edit-risk, enforce-on).
2. Click **Approve**.
   → `test.txt` is created on disk; tool result shows `bytesWritten` and `created: true`.
3. Run a grepSearch for "Hello".
   → "Hello World" from test.txt appears, proving the file was indexed.
4. Prompt: "Edit test.txt to say Hello Brainstrike".
   → Approval prompt appears again (`stringReplaceWorkspaceFile` is edit-risk).
5. Click **Approve**.
   → File is edited; result shows `replaced: true` and `matchType` (exact/whitespace/fuzzy); next grepSearch confirms "Brainstrike" is searchable.
6. Verify via `readWorkspaceFile` that edits persisted.
   → Content matches the edited version, not the original.

### 4c. Search + Exec Tools (`globWorkspace`, `grepSearch`, `executeCommand`, `webSearch`)

1. Ask: "Find all TypeScript files in src/ matching *.test.ts using globWorkspace".
   → Assistant calls `brainstrike.globWorkspace` with the pattern + root; result lists test files under src/ and excludes `node_modules`/`.git`/`dist`.
2. Edit a file, then ask: "Search for `export const Button` and confirm the file was just changed".
   → Assistant calls `brainstrike.grepSearch`; result shows both **index** and **live** matches; a second re-grep shows source `both`; live engine labeled `ripgrep` or `js-walk`.
3. Run a non-destructive command: "Execute git status to show the current branch".
   → Approval prompt appears (if enforce-on); after approval `executeCommand` runs with `exitCode 0`; output shows the branch; **no orphan processes** remain (verify with `ps aux | grep`).
4. Request a web search: "Search the web for `TypeScript async/await best practices`".
   → If Tavily key configured: `available: true` with 5 results (title/url/snippet). If missing: `available: false` with "Web search is unavailable — add a Tavily API key in Settings". Key is **never** visible in the response body or logs.
5. Open the **Web** app and ask: "Run npm test".
   → Web does **NOT** offer/allow `executeCommand`; assistant responds it's unavailable in the web version or omits it.

### 4d. Git Panel + Diff Viewer

1. Click the **Git** tab in the left sidebar (visible only when a workspace is open and the git bridge is available).
   → Git panel loads with branch name, push/pull buttons with ahead/behind badges, and Staged/Unstaged/Untracked sections. Not a repo → "This folder is not a Git repository." Clean → "No changes. Working tree clean."
2. Modify a file in the workspace (create or edit).
   → Panel refreshes automatically or on **Refresh**; the file appears in Unstaged (or Untracked if new), with a status code ("M", "?").
3. Click the **FilePlus** icon next to an unstaged file.
   → File moves to Staged; no error toast; staged count increments.
4. Click a staged file.
   → Right pane shows a syntax-highlighted diff (original left / modified right). Language highlighting applies. Split/inline mode toggle works.
5. Type a commit message, click **Commit (N)**.
   → Toast "Committed `<hash>` on `<branch>`"; panel refreshes; Staged empties; `git log` confirms the commit.
6. With a branch lacking an upstream, click **Push**.
   → Toast "Pushed" or "Up to date." Uses `git push -u origin HEAD` to set the upstream; ahead/behind badge updates. (Note: no confirmation dialog — Push fires immediately.)
7. With an upstream and commits behind, click **Pull**.
   → Toast "Pulled" with output summary; behind badge decreases or vanishes.

### 4e. Terminal (PTY IPC + xterm UI)

1. Open the Terminal panel via the Terminal nav item.
   → xterm host renders, shows the cwd path, and an empty shell prompt ready for input.
2. Type `ls`, Enter.
   → Directory contents stream in (no hangs).
3. Run `sleep 30`.
   → Prompt disappears while running; no host-element corruption.
4. Press **Ctrl+C** during the sleep.
   → Keystroke reaches the pty; process terminates; prompt returns within ~1s.
5. Run `echo test`, then resize the panel by dragging the splitter.
   → Resizes smoothly; ResizeObserver debounces; xterm re-fits; wrapping adjusts with no tearing/stale overlay.
6. (If available) open a second workspace root and switch the active root.
   → Panel briefly shows "starting"; a fresh session creates in the new cwd; no exited-overlay leaks from the prior root. (This is the just-fixed bug from PR #1271 — covered by the `does not leak a prior root's exited overlay` regression test.)
7. Close the Terminal panel (tab away / close sidebar).
   → `bridge.destroy()` is called; shell exits; **no orphaned pty/shell** lingers (verify with `ps`).
8. Reopen Terminal in the same root.
   → A fresh pty spawns; prompt appears; no stale data from the previous session.

---

## 5. Default behavior change to expect

**The assistant now asks before it edits files or runs shell commands.** This is intentional and secure-by-default:

- **Enforce tool permissions is ON by default** (a P1 security fix; the store is at `STORE_VERSION = 2`).
- Default policies: **Read = Allow, Edit = Ask, Execute = Ask, MCP = Allow.** So read/search/glob/grep run freely, but **every edit and every shell command surfaces an Approve/Decline prompt** before executing.
- **Upgrade note:** the v1→v2 store migration adopts `enforce: true` for any pre-v2 slice. If you previously opted out of enforcement under v1, you will be re-prompted after this upgrade. This is the safe direction and is by design — not a bug.
- To run unattended, either set categories to **Allow** per-category, turn **Enforce OFF** (full passthrough), or flip **YOLO mode ON** for the session (cleared on reload). YOLO is additive to Enforce, not a replacement.

If you see an approval prompt before an edit or a command, that's working as intended — don't file it as a regression.

---

## 6. Known gaps & deferred items

These are documented, intended states — **please do not report them as bugs.**

### Blocking (scope boundary)
- **Web file writes are DEFERRED to PR-2.6.** The Web FS-Access write path (`FileSystemWritableFileStream`) is not wired. **Web cannot create or edit files yet** — only read-only tools are wired on web. File editing is **desktop-only** for now.

### Web vs desktop runtime caveats
- **Web has no interactive tool-approval prompt.** Web honors permission policies (tools are filtered before the agent sees them), but cannot approve/decline individual calls — the web backend returns HTTP 501 `tool_approval_resume_unsupported` if an approval action is submitted. This is by design: Mastra workflow storage (required to suspend/resume) is desktop-only. The settings UI states this honestly.
- **Permission policy is sent to the server only on desktop** (`localChatTransport === 'data-stream'`). Web relies on default passthrough; it sends no `permissionPolicyRequest`.
- **Web has no shell, terminal, or git surfaces.** `executeCommand` exists in the schema/registry but is desktop-scoped at the IPC level; the web app never constructs the Terminal or Git panels (capability-gated, not `isElectron()` checks).
- **Local runtime with no storage:** in a pure-local context with no Mastra workflow storage, "ask" tools are **fail-safe-omitted** from the map (warning logged, tool unavailable — never executed without approval). Safe-direction fallback.

### Permission-engine caveats
- **MCP default policy is `allow`, not `ask`** (rationale: MCP servers are user-configured/trusted). MCP tools discovered at runtime default to risk category `mcp` (most restrictive sensible) when absent from the risk map — so they won't be misclassified as harmless "read". Operators should verify custom MCP tools land in their intended bucket.
- **Per-tool UI overrides are deferred.** The store + server resolver support per-tool-id overrides (`setToolOverride`), but the Settings UI only exposes **category-level** control. Per-tool UI is a future enhancement.
- **"Grant for this session" has no UI gesture yet.** The store API supports session grants (promote a category to allow for the session only, lost on reload), but no UI surfaces it.
- **Interactive per-call approval UI polish is deferred to a later PR.** The runtime wiring is live (Mastra per-tool `requireApproval` + `streamMastraToolApprovalAction`); the final "Apply this change?" modal UX polish is future work. Gating itself works today.

### Edit-tool caveats
- **reindexEditedFile is non-fatal.** If the DB is unavailable, re-index fails with a DEBUG log only; the edit still succeeds but isn't searchable until manual sync (edit > index, by design). Suggested follow-up: log WARN-level when the DB *is* available and re-index still fails.
- **String-replace no-op guard** throws `not_found` if fuzzy branches locate text but the final `.replace` produces no change (whitespace mismatch). Correct (no silent no-ops); error messaging could be clearer.

### Search + exec caveats
- **`executeCommand` interactive per-call approval** is gated at registration time by the permission config (enforce-on-by-default). When a category is set to "ask", the live runtime suspends for approval (per-call) on desktop; the final modal UX polish is shared with the approval-flow follow-up.
- **Deliberately daemonizing children** (`setsid` → new session/process group) escape `killTerminalTree` / negative-pid kill / tree-kill — a fundamental POSIX limitation, as in every terminal emulator. Normal commands (tests, builds, git) don't daemonize, so this is acceptable but documented.
- **Silent ripgrep→JS-walk fallback.** If `rg` is missing, live-grep logs a warning and returns matches via JS-walk; there's no user notification that performance degraded.
- **grep engine label is model-facing only.** The `ripgrep`/`js-walk`/`skipped` label reaches the model but isn't surfaced in the visual context explorer.
- **Legacy null-`rootId` grep dedupe** across multi-root forests may be ambiguous (dedupe keys on `rootId, path, line`). Accepted as a legacy-path edge case.

### Git caveats
- **Push has no confirmation dialog** — clicking Push immediately invokes `git push -u`/`git push`. Intentional one-click UX; noted for users expecting an "Are you sure?".
- **Git panel operates on the focused workspace root only.** With multiple roots open there's no multi-repo diff or tabbed switching; click a different root in FileExplorer to switch git context.
- **Push/pull network timeout is 120s** (`GIT_NETWORK_TIMEOUT_MS`). Slow network/auth-prompt timeouts surface "git command timed out"; no retry UI — click again.
- **Diff output bounded to 4MB** (`GIT_MAX_BUFFER_BYTES`). Larger diffs show a truncation note but render a valid partial prefix; very large binary/generated files are partial.
- **Deferred:** interactive rebase, merge-conflict resolution, and stash are not implemented. Only status/diff/stage/unstage/commit/push/pull.

### Terminal caveats
- **`MAX_EVENT_CHUNK_CHARS` (256k UTF-16)** is a soft IPC limit; a split surrogate pair could momentarily render U+FFFD, but `SurrogateBuffer` mitigates this and the buffered text is always correct (no visible artifact).
- **Daemonized children** escape `killTerminalTree` by ancestry (POSIX, as in iTerm/VSCode) — out of scope, documented.
- **The terminal route stays mounted once opened** (never unmounts) so the pty persists across tab switches (intentional — preserves shell history/state). Please verify during smoke testing that repeated tab switches don't leak memory.
- **`chmod-pty-spawn-helper` runs at postinstall on macOS only.** Windows relies on npm's pre-built node-pty binaries; the current package ships them ready.
- **The exited-overlay stale-outcome fix has a regression test** (`does not leak a prior root's exited overlay onto a freshly-starting root`, `terminal-panel.test.tsx:317`) — it fails on the pre-fix sessionId-only gate and passes with the rootId-keyed gate. Verified present in the merged code.

---

## 7. What's next (Phase 5-8, NOT started)

- **P5 — Observational Memory + cost meters:** OM integration for coding turns plus per-run token/cost metering surfaced in the UI. *(This is the phase that begins after this smoke-test round.)*
- **P6 — Slash commands + command palette:** keyboard-driven command surface for invoking tools and agent actions.
- **P7 — Subagents:** spawning scoped sub-agents for parallel/independent task execution.
- **P8 — Notifications / hooks / MCP / OAuth:** lifecycle notifications, hook automation, expanded MCP integration, and OAuth (legal-gated — pending review).
