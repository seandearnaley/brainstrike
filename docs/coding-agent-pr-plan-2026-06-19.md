# Coding-Agent Port — Orchestrated PR Plan & Pipeline

Execution backbone for porting mastra-code-ui patterns into brainstrike (see
`mastra-code-port-breakdown-2026-06-19.md` + `mastra-code-port-synthesis-2026-06-19.md`).

## Operating model (locked with the user)

- **Integration branch:** all PRs target `feat/coding-agent` (a long-lived branch off `main`).
  `main` is never touched by the pipeline. The user merges `feat/coding-agent` → `main`
  manually after smoke-testing.
- **Per-PR pipeline (the 4-thread dance):**
  1. **Builder** (own git worktree) — red/green TDD, implements one small slice, runs the
     clean-bar gate (`build + lint + type + unit` in one run, `pnpm doctor` scope:changed,
     `knip`, lane checks if catalog/db touched), commits.
  2. **Reviewer** (independent agent, + the repo's `claude-code-review.yml`) — adversarial
     review on PR filing.
  3. **Builder loops** on review comments + CI until the reviewer approves and CI is green.
  4. **CDT verification** — a verifier agent drives the running app via the chrome-devtools
     MCP (`apps/desktop` `dev:agent-debug`, port 9222 — real clicks/console/network, NOT
     Playwright) and attaches evidence. Then **auto-merge into `feat/coding-agent`** and
     trigger the next unblocked PR.
- **User gate:** each merged slice is small + green + CDT-verified + pull-ready; the user
  smoke-tests branches individually before the final `feat/coding-agent` → `main` merge.
- **Size cap:** one coherent sub-feature per PR, target ≤ ~400 net LOC. No PR "too large."
- **Invariants enforced every PR:** no-silent-fallbacks (throw on malformed) · web+desktop
  capability-gating (no `isElectron()`, no disabled stubs) · multi-registry tool contract ·
  LIVE-loop tests for any loop/tool/persistence change · FACTORY RESET wiring for new stores ·
  logger redaction for new secret fields.

## Parallel lanes vs stacked chains

```
Lane A (SEQUENTIAL GATE — stacked):  P0 ─► P1(perms) ─► P2(edit) ─► P3(shell) ─► P7(subagents)
Lane B (PARALLEL off main):          P4 diff/terminal/git           (desktop-only)
Lane C (PARALLEL off main):          P5 OM + cost meters
Lane D (after P1+P3):                P6 slash/palette
Lane E (after P1; v1 early):         P8.1 notifications
Parked (gated):                      P8.4 OAuth (LEGAL review) · P2.5 LSP (desktop enrich)
```
Lanes B/C/E branch off `main`→`feat/coding-agent` and run concurrently with Lane A (subject
to CDT-verify serialization: each running-app verify needs its own worktree + devtools port).

## PR manifest (≈35 small PRs)

Legend: `[lane] size · CDT?` — CDT? = needs running-app Chrome DevTools verification.

### Phase 0 — Foundations (cheap, unblocks all)
- **PR-0.1** `[A] S` — ADR: "stay bespoke, replicate patterns"; name the brainstrike agent
  event bus (run-events + DataStreamMapper + assistant-server). Docs only.
- **PR-0.2** `[A] S` — add optional `pricing?:{inputPerMTok,outputPerMTok}` to
  `provider-registry.ts` (co-located w/ `contextWindow`); lint/test every priced model is in
  the catalog. No UI.
- **PR-0.3** `[A] M` — data-layer DECISION GATE: instrument `PgliteMemoryStore` memory-write
  contention (P50/P95 wait under chat+embedding+query load) via scheduler snapshot. No
  behavior change. Output: a measured go/no-go for the libsql split.

### Phase 1 — Permission engine (HARD GATE)
- **PR-1.1** `[A] S` — risk taxonomy `read|edit|execute|mcp` derived from existing
  `UnifiedToolMetadata.requiresApproval` (no second map). Contract + types.
- **PR-1.2** `[A] M` — policy store: allow/ask/deny per category + YOLO preset + session
  grants; persisted in preferences; wired into `clearPersistentUiState()`. Strict-parse.
- **PR-1.3** `[A] M·high-risk` — wire dormant Mastra `requireApproval` into the live tool
  registry; extend `mastra-tool-execution.spec.ts` with a REAL ask-gated tool (not mocks).
- **PR-1.4** `[A] M · CDT` — approval UI: riskLevel + diff-preview hook + audit log via
  `createLogger`.

### Phase 2 — Edit tools + LSP (stacked on P1)
- **PR-2.1** `[A] M` — `write_file` tool + full multi-registry wiring + tests.
- **PR-2.2** `[A] M` — `string_replace` fuzzy-match cascade (exact→ws→char→Levenshtein,
  verbatim) + single-line ambiguity guard + per-file write lock + tests.
- **PR-2.3** `[A] M` — re-index-on-edit: enqueue re-chunk/re-embed via `job_queue` + mark
  `collection_indexing_stats` dirty + tests (RAG coherence — our differentiator).
- **PR-2.4** `[A] M · CDT` — edit-approval rendered-diff card via suspend/resume.
- **PR-2.6** `[A] M` — WEB edit path: FS-Access `readwrite` upgrade +
  `FileSystemWritableFileStream` writes (web coding-agent unlock).
- **PR-2.5** `[parked-desktop] XL→split` — LSP backbone (client/manager/server/workspace) as
  optional desktop enrichment + diagnostics run-event card. Split into ≥3 PRs when reached.
- **PR-2.7** `[parked-desktop] M` — AST transform reusing tree-sitter/Tapestry index.

### Phase 3 — Shell / glob / grep / web (desktop; stacked on P1+P2)
- **PR-3.1** `[A] M` — `glob` over `file_records` (multi-root, gitignore applied) + live
  `git ls-files` fallback flag + tests.
- **PR-3.2** `[A] M` — hybrid live+index grep (trigram-PGlite + ripgrep pass, merged, engine-
  labeled) + tests. Required once edits exist (staleness).
- **PR-3.3** `[A] M·high-risk` — `shell` tool (detached + tree-kill + global-set + finally);
  gated behind P1; REAL-subprocess tests; capability-gated off web.
- **PR-3.4** `[A] M` — web search provider-native-first; Tavily via encrypted keychain key;
  verify `anthropic-beta` header MERGE.

### Phase 4 — Diff / terminal / git UI (PARALLEL lane B, desktop-only)
- **PR-4.1** `[B] M` — PTY IPC domain (create/write/resize/destroy + pty_output/exit) via
  `createDesktopIpcRegistry` + `window.terminal` bridge + node-pty asarUnpack/rebuild wiring.
- **PR-4.2** `[B] M · CDT` — `TerminalPanel` (xterm + addon-fit) UI; teardown on root switch.
- **PR-4.3** `[B] M` — git IPC domain (status/diff/stage/commit/push/pull) via async
  `execFile` + `window.git` bridge.
- **PR-4.4** `[B] M · CDT` — `GitPanel` UI + `@codemirror/merge` syntax-highlighted diff
  viewer (reuse CodeSurface lang resolution).

### Phase 5 — OM + cost meters (PARALLEL lane C, web+desktop)
- **PR-5.1** `[C] M` — durable per-thread cumulative usage from `mastra_messages`; honest
  provenance ("cost unavailable", never silent $0).
- **PR-5.2** `[C] M · CDT` — cross-thread/cross-root cost aggregation via PGlite live queries.
- **PR-5.3** `[C] M · CDT` — OM live meter unified with context-usage meter (tri-segment);
  pin `@mastra/memory` + schema-drift projection test; surface compaction benefit.

### Phase 6 — Slash commands + palette (lane D, after P1+P3)
- **PR-6.1** `[D] M · CDT` — command registry on `packages/context-actions` + ⌘K palette.
- **PR-6.2** `[D] M·risky · CDT` — `/` autocomplete in composer (VERIFY `@assistant-ui/react`
  ComposerPrimitive API first).
- **PR-6.3** `[D] M · CDT` — ⌘P quick-open backed by PGlite file index.
- **PR-6.4** `[D] M` — custom command macros (`@file`/`` !`shell` `` gated by P1).

### Phase 7 — Subagents (stacked on P2+P3)
- **PR-7.1** `[A] M` — subagent run-event kinds + DataStreamMapper + hydration fixtures (real
  rows).
- **PR-7.2** `[A] M` — subagent tool + persona registry + constrained toolset derived from
  tool-categories; guards/watchdog inside child; nesting/concurrency caps.
- **PR-7.3** `[A] M` — RAG-native explore persona (queryEmbeddingSpace + grep + hybrid);
  keyless local-Gemma option.
- **PR-7.4** `[A] M · CDT` — subagent activity UI cards.

### Phase 8 — Polish
- **PR-8.1** `[E] M · CDT` — notifications (run-event driven; completion+error v1; visible-
  renderer-only; cross-platform badge; web Notification API).
- **PR-8.2** `[E] M` — hooks (config + executor + desktop shell + web in-process JS hooks +
  settings UI + dry-run; throw on malformed).
- **PR-8.3** `[opt] M` — MCP: unify the two client stacks + Streamable HTTP + web HTTP/SSE.
- **PR-8.4** `[PARKED — LEGAL GATE] XL` — OAuth subscription (Claude Max / Codex). Do NOT
  start without ToS/legal sign-off. Encrypted safeStorage; `credentialResolver` seam;
  `anthropic-beta` merge-not-replace.

## Execution state (updated as PRs land)

| PR | Lane | Status | Branch | Notes |
|----|------|--------|--------|-------|
| 0.1 | A | pending | — | first up |
| …  |   |         |   |   |

(Status: pending → building → in-review → cdt-verify → merged-to-integration → user-smoke-ok)
