# Handoff: Assistant Tool Token Efficiency

**Linear project:** [Assistant Tool Token Efficiency](https://linear.app/brainstrike/project/assistant-tool-token-efficiency-072ded0cf4ec) (team Brainstrike, High priority)
**Audit date:** 2026-08-07 · **This doc:** `docs/tool-token-efficiency-2026-08-07/HANDOFF.md`

You are picking up a fully-scoped efficiency program. The investigation is done; do not redo it. This document gives you the context, the rules, and the work order. Everything else you need is in the four sibling files in this directory and the ten Linear tickets.

---

## 1. Why this project exists

BrainStrike's coding agent works but burns tokens. A source-level audit compared our assistant tool layer against three popular OSS coding agents (local checkouts: `~/Documents/GitHub/opencode`, `~/Documents/GitHub/cline`, `~/Documents/GitHub/hermes-agent`). The verdict:

**Our budget machinery is peer-grade or better.** Deterministic token-denominated budgets (`packages/agent/src/stream/tool-output-limits.ts`: transport 3,000 tok / model-facing 2,000 tok / domain projections 1,500 tok = 6,000 chars), binary-search result fitting (`fitItemsToCharBudget`), text projections for search tools, offset pagination, a durable artifact reader for oversized results, and a strictness no peer has: **a limited result without a continuation hint fails the whole run** (BST-951).

**The bytes *inside* the budget are the problem.** Four findings drive all ten tickets:

1. **grepSearch content mode spends ~180 chars of envelope per match.** Each row carries `read_args={"path":"…","root":"<36-char-uuid>","startLine":N} | root_name="…" | source=index`. Peers spend 6–14 chars/row (path printed once per file, then `line: text`). Consequence: ~18 matches fit our 6,000-char page where the canonical format fits ~75 — so the model pages 4–5× more, and every extra tool call replays the entire conversation. (Cline's source comment names this cost: *"oversized outputs cost quadratically over the remaining run."*)
2. **Headers announce false alarms.** Every healthy grep result prints `live=ripgrep | candidates_truncated=false | scan_limited=false | skipped_missing_line_metadata=0` (~120–150 chars of noise). Every peer's healthy output is just "Found N matches".
3. **readWorkspaceFile returns `{type:'json'}` to the model.** File content as a JSON string (every newline = 2 chars, quotes escaped) plus 11 metadata keys including a permanently-null `tokenCount`. Every peer returns plain text pages.
4. **Nothing ever leaves our context.** No pruning, no compaction, no stale-read rewriting — every stored projection replays at full size for the life of a thread. All three peers have at least one lifecycle mechanism.

**Strategy ruling (do not relitigate):** stay in the small-page lane (where Cline is: they re-cap every result to 8k chars per request) and *complete* it — land compact formats first (equivalent to a 4–5× budget raise without touching budgets), then make history mortal (pruning + stale-read rewriting). Do **not** enlarge page budgets instead; that was considered and rejected in the report.

## 2. Read these before writing code

| File (this directory) | What it is |
|---|---|
| `token-efficiency-report.html` | The full diagnostic: verdict, comparison matrix, output anatomy with byte counts, P1–P10 proposals, wave plan. **Open it in a browser first.** |
| `opencode-report.md` | Source study of opencode's tools, file:line-cited (grep/glob formats, 50 KiB spill-to-file, compaction pruning, .txt few-shot descriptions) |
| `cline-report.md` | Source study of Cline's SDK core (8k per-request re-cap, stale-read rewriting w/ 64 KB batching, middle-truncation, model-aware edit routing) |
| `hermes-report.md` | Source study of hermes-agent (densified search output, unpadded-gutter A/B, loop-blocking, zero-match probes, 3-layer window-scaled budgets) |

Repo contract docs (auto-loaded via `.claude/skills/*-contract`, or read directly):

- `docs/agents/assistant-runtime.md` — stream/tool chain, guards, projections (Lanes A/B/F touch this)
- `docs/agents/assistant-persistence.md` — message persistence & reload hydration (P6 is governed by this; update doc + paired tests in the same change)
- `AGENTS.md` — working rules; the bar is build + lint + typecheck + unit tests green **in the same run**

Key source files you will be living in:

- `apps/desktop/src/assistant-server/workspace-search-model-projections.ts` — grep/glob model projections (P1, P2)
- `apps/desktop/src/assistant-server/grep-search-tool.ts` + `grep-search-result-contract.ts` — grep tool, hints, result contract (P1, P2, P4, P8)
- `apps/desktop/src/assistant-server/read-workspace-file-tool.ts` — read tool + cursor registry (P3)
- `apps/desktop/src/assistant-server/execute-command-tool.ts` — shell tool (P9)
- `packages/agent/src/stream/tool-output-limits.ts` — all budget constants (reference; you should rarely need to change these)
- `packages/agent/src/tools/schemas-search.ts` — input schemas incl. `contextLines` default (P4)
- `packages/assistant-contract/src/tool-descriptions.ts` + `packages/agent/src/mastra/default-instructions.ts` — descriptions & system prompt (P5)

## 3. Invariants that must survive every ticket

These are settled rulings. A PR that violates one will be rejected regardless of token savings.

1. **BST-951:** any result whose limits may have hidden matches (`truncated` / `scanLimited` / `candidatesTruncated`) MUST carry actionable continuation guidance. The projector deliberately **throws** on a limited result without a hint. Silencing happy-path flags (P2) must not weaken this: flags disappear only from the *healthy* path.
2. **Stored-projection replay:** projections are persisted and replayed by header-prefix detection (`grepProjectionHeaderPrefix` in `grep-search-result-contract.ts`, replay branch at the top of `projectGrepSearchModelOutput`). When you change the format (P1/P2), old threads still contain old-format stored projections — the replay path must accept both, or you must consciously version it. Test this explicitly.
3. **NO SILENT FALLBACKS.** Degradation is visible (`liveNote`, refusals, honest markers). P6's pruning markers and P7's block messages must say exactly what happened.
4. **Scan-limited hint preserves regex semantics** — that hint text (in `buildRefinementHint`) must never advise `isRegex: false` for a regex pattern; it changes the match set. Keep the existing wording's intent when you move it.
5. **Prompt-prefix caches:** P6 rewrites history bytes; batch rewrites (≥64 KB reclaimed, Cline's number) so you don't invalidate the provider prefix cache on every re-read. This is in the ticket; it is not optional.
6. Schema default changes (P4) update the zod `.describe()` string and the tool-side fallback **together** — no drift.

## 4. The tickets, lanes, and work order

Ten tickets, six lanes. **Lane heads are file-disjoint — up to six branches can run in parallel.** Chains inside a lane are real `blockedBy` links in Linear (same files; serialized to avoid merge conflicts). Every ticket description is self-contained with format specs, peer citations, and acceptance criteria — read the ticket before starting it.

| Lane | Ticket | Title | Depends on |
|---|---|---|---|
| **C — telemetry** | [BST-1190](https://linear.app/brainstrike/issue/BST-1190/p10-per-tool-token-telemetry-charscall-callsthread-zero-match-rate) | P10: Per-tool token telemetry | — (**land first**) |
| **A — grep projection** | [BST-1185](https://linear.app/brainstrike/issue/BST-1185/p1-path-grouped-compact-grep-projection-drop-per-row-read-args) | P1: Path-grouped compact grep projection | — |
| A | [BST-1191](https://linear.app/brainstrike/issue/BST-1191/p2-silent-happy-path-grepglob-status-flags-only-when-they-fire) | P2: Silent happy path | BST-1185 |
| A | [BST-1193](https://linear.app/brainstrike/issue/BST-1193/p4-grepsearch-contextlines-default-0-in-content-mode) | P4: contextLines default 0 | BST-1191 |
| A | [BST-1194](https://linear.app/brainstrike/issue/BST-1194/p8-zero-match-probes-on-grepsearch-case-literal-excluded-path-steering) | P8: Zero-match probes | BST-1193 |
| **B — read projection** | [BST-1186](https://linear.app/brainstrike/issue/BST-1186/p3-plain-text-projection-for-readworkspacefile-kill-the-json-envelope) | P3: Plain-text read projection | — |
| **D — prompts** | [BST-1187](https://linear.app/brainstrike/issue/BST-1187/p5-parallel-call-nudges-bounded-tool-routing-and-anti-verification) | P5: Nudges + routing + anti-verification lines | — |
| **E — shell** | [BST-1189](https://linear.app/brainstrike/issue/BST-1189/p9-executecommand-4060-headtail-retention-and-command-echo-dedup) | P9: 40/60 head+tail + command-echo dedup | — |
| **F — lifecycle** | [BST-1188](https://linear.app/brainstrike/issue/BST-1188/p7-loop-guards-repeated-identical-calls-warn3block4-unchanged-read) | P7: Loop guards + unchanged-read stubs | — |
| F | [BST-1192](https://linear.app/brainstrike/issue/BST-1192/p6-history-lifecycle-old-result-pruning-stale-read-rewriting) | P6: History pruning + stale-read rewriting | BST-1188 (+ shapes from P1/P3) |

**Sequencing notes:**

- **BST-1190 (P10) first, deliberately:** capture baseline numbers on main (chars/call, pages-per-search, zero-match rate) *before* the Lane A/B format PRs merge, so those PRs quote measured before/after instead of estimates. The report's byte counts are estimates marked "≈" — P10 replaces them with facts.
- P1+P2 (+P4 if it stays small) may land as one PR with fixture snapshots — the tickets are split for reviewability, not to force three PRs.
- P6 is the largest, riskiest, highest-compounding item (**the innovation-token spend**). Do it last, after P7 lands its cache-reset hook and after P1/P3 settle the stored-projection shapes it will be rewriting.

## 5. Working conventions (non-negotiable in this repo)

- **Never work on `main`.** One branch per ticket; Linear suggests branch names on each ticket (e.g. `seandearnaley/bst-1185-p1-path-grouped-compact-grep-projection-drop-per-row`). Land Lane A bottom-up (stacked PRs are fine — the lane is naturally layered).
- **RED/GREEN TDD.** For projection work this means: write the new-format fixture snapshot test first, watch it fail, then change the projector. Never delete an existing test to make a change pass; update it and keep the invariant it guarded.
- The bar per PR: `pnpm` build + lint + typecheck + unit tests green **in the same run**. `pnpm dlx ultracite fix` before committing. Run single tests from the package dir: `pnpm vitest run -t "test name"`.
- `*.integration.test.*` marks env-sensitive tests (real PGlite etc.) — excluded from the cached `test` script, run via `test:integration`.
- Verify with CDT/agent-debug for live model-facing output when in doubt (`pnpm --filter @brainstrike/desktop dev:agent-debug`; recipes in the repo memory/docs) — the projection you see in tests is exactly what the model pays for, but a live confirmation on one real thread is cheap insurance.
- PR reviews: green CI is not the merge gate — wait for and address inline bot comments, reply to every one, verify checks match the head SHA.
- End each PR description with: files changed (one line each), nearby files intentionally untouched, follow-ups.

## 6. Definition of done for the project

1. All ten tickets closed, each with tests proving its acceptance criteria.
2. P10 dashboards/lens show, on a comparable workload: model-facing chars per grepSearch call down ~4–5× in content mode; pages-per-search down correspondingly; readWorkspaceFile page overhead reduced (JSON envelope gone); long-thread context growth flattening once P6's window fills.
3. `docs/agents/assistant-runtime.md` and `docs/agents/assistant-persistence.md` updated in the same PRs that change their subsystems (living-doc rule).
4. No regression on the BST-951 guarantee — the "limited result without guidance throws" tests still exist and still pass.

If you find the report's estimates wrong once P10 measures reality (e.g. context lines turn out cheaper than modeled), update the affected ticket with the measurement and adjust — the numbers are estimates; the invariants and the lane structure are not.
