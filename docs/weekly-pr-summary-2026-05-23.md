# Brainstrike — weekly merged PR summary

**Week ending:** Saturday, 23 May 2026  
**Window:** last 7 days (`merged:>=2026-05-17`)  
**Source:** GitHub (`gh pr list` — this repo’s `origin` is GitHub, not GitLab; `glab` has no authenticated GitLab host for it)  
**Merged PRs:** 30

---

## At a glance

A big week: the **architecture reset** landed, the **file explorer moved to the right**, indexing got **smarter Python chunks** and a **faster desktop JS parser**, and CI shifted to **“prove locally, run only what changed in the cloud.”** Latest merges add **incremental file-tree updates** and **embedding cache visibility**.

---

## What’s new (things you’ll notice)

### File explorer on the right

- **#1027** — The folder tree now lives on the **right** side of the workspace (neutral naming so we can flip sides later).
- **#1028** — Fixed desktop tests and layout migration edge cases after that move (old left-panel selectors were stale).

*ELI15:* Think of moving your bookshelf from the left wall to the right — same books, new spot; we also updated the “where is the shelf?” signs in automated tests.

### Smoother, faster folder tree

- **#1030** — File tree worker sends **small patches** (what changed) instead of shipping the whole tree every time.
- **#982** (earlier in week) — Worker-flattened rows refresh when tree content changes, not only when you expand/collapse.

*ELI15:* Instead of mailing you the entire phone book when one name changes, the app now sends a sticky note: “add these rows, update that folder.”

### Better Python indexing (tree-sitter)

- **#1011** (+ stack **#998–#1007**) — **Python files** can chunk by real functions/classes (tree-sitter), not just “split every N characters.” Default-on for `.py` with a URL kill switch.

*ELI15:* For Python, the app finally reads the code structure — like splitting a textbook by chapters instead of every 200 letters.

### Faster code parsing on desktop (oxc)

- **#994** and parser stack (**#979–#993**, **#988–#997**) — Desktop chunking can use **oxc** (native Rust parser) over IPC for JS/TS — roughly **4× faster** on real repo benchmarks, with per-file fallback and `?parserFlag=babel` kill switch.

*ELI15:* Desktop indexing got a faster “reader” for JavaScript/TypeScript; web stays on the old reader so the download size doesn’t balloon.

### Embedding pipeline transparency

- **#1031** — Embedding worker emits **diagnostic events** for model cache (hits, loads, evictions, device loss) instead of guessing memory numbers.

*ELI15:* When the app loads AI embedding models, it now leaves a clear trail in logs — like a pantry inventory that says what’s on the shelf, not pretending it knows exact calories.

---

## Faster & smoother (performance & UX)

| PR | What | ELI15 |
|----|------|--------|
| **#1020** | Faster filename extraction in background indexer | Stop chopping strings into arrays just to get the last folder name |
| **#978** | Faster JSON sorting for assistant cache keys | Sorting big JSON for caches got ~20% quicker |
| **#1006** | Fixed explorer resize jank with many expanded folders | Resizing the panel no longer tries to paint the whole tree at once |
| **#977** | Tougher chunk ↔ source matching for big repetitive files | Finding text in huge files won’t give up after 10k false starts |

### Accessibility

- **#1016** — Token budget panel: button now properly **links** to the legend for screen readers (`aria-controls`, `aria-expanded`).

---

## Fixes & safety

| PR | What |
|----|------|
| **#1023** | Timing-safe API key check for telemetry collector (no “length leak” side channel) |
| **#1022** | Safer desktop factory reset + tighter rules for destructive SQL from renderer |
| **#1009** | Less flaky desktop test for “filter preset survives restart” |
| **#976** | Cleaner token-indexer failure logging (no duplicate error spam) |

---

## Under the hood — CI, proof, and platform

### Architecture reset (big platform PR)

- **#1021** — **Architecture reset release candidate**: risk-based CI lanes, domain boundaries, desktop hidden hosts, proof manifests, and related refactors/docs.

*ELI15:* One large “housekeeping + guardrails” release so future PRs run cheaper, safer checks.

### Smarter CI (run less, trust local proof more)

| PR | What |
|----|------|
| **#1010** | Local `ci:select` / `ci:prove` / `ci:verify-proof` + PR Sentinel |
| **#1013** | Documented the proof flow in AGENTS.md |
| **#1025** | Desktop lanes: smoke, IPC reset, runtime hosts, DB storage vs full regression |
| **#1026** | Web lanes: smoke, file explorer persistence, import, assistant, settings, DB, destructive |
| **#1032** | Split **unit** vs **coverage** — routine PRs skip heavy coverage unless the diff needs it |
| **#1014** | Integrated batch: queue telemetry, restore access, secret scan gate, diagnostics privacy, tooltips, etc. |

*ELI15:* Contributors prove tests locally once; GitHub only runs the expensive suites that match what actually changed.

### Agent / review tooling

- **#1008** — Opt-in **Agent DevTools** port for debugging desktop renderers
- **#980** — Higher Claude auto-review turn budget for large PRs

---

## Also merged earlier in the 7-day window (May 17–18)

Worth calling out if you want the full picture:

- **Chunking / parsers:** oxc Phases 2–8, tree-sitter Phases 2–9, strict config (**#1007**), recovery merge **#1011**
- **Explorer / indexing:** resize thrash **#1006**, chunk matching **#977**, worker flatten refresh **#982**
- **CI foundation:** proof gates **#1010**, filter preset E2E **#1009**

---

## By the numbers

| Metric | Value |
|--------|--------|
| Merged PRs (7 days) | **30** |
| Merged Mon–Sat (19–23 May) | **14** |
| Notable themes | Layout, file-tree perf, Python chunking, desktop oxc parser, CI proof lanes, architecture reset |

---

## Commands used (GitHub equivalent of `glab`)

```bash
gh pr list --repo seandearnaley/brainstrike --state merged \
  --search "merged:>=2026-05-17 sort:updated-desc" \
  --json number,title,mergedAt,labels,url,body
```

To re-run for a different window, change the `merged:>=YYYY-MM-DD` date.
