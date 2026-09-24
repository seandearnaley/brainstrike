# Model Catalog settings redesign (BST-1805): design

**Status:** approved 2026-09-22 (type filter defaults to All; two-PR stack: forms move first, redesign second)

Date: 2026-09-22
Branch: `seandearnaley/bst-1805-model-catalog-settings-uiux-overhaul-for-hundreds-of-models`

Artifacts (session scratchpad, not committed):

- Current state: `scratchpad/bst1805/current-wide.png` (1440×900), `current-wide-list.png`
  (the list, scrolled), `current-narrow.png` (900×900).
- Mockup: `scratchpad/bst1805/mockup.html` (self-contained and interactive, with real
  `provider-catalog.json` data), `mockup-wide.png`, `mockup-narrow.png`,
  `mockup-wide-filtered.png` (`claude` + Reasoning), `mockup-wide-scrolled.png` (sticky
  section headers).

## 1. Problem

The user's words: *"no foldable sections, it's hard to find things … designed for
hundreds of models and providers, optimal use of screen real estate, first-class
UI/UX for 2026."*

What the current page does, measured on a production build (`vite preview`, 1440×900):

| Finding | Evidence |
| --- | --- |
| The catalog sits below unrelated forms. You scroll past the cache directory, the whole **Assistant Memory** form (8 fields) and the **Subagent budgets** form (4 fields) before reaching a single model. | `current-wide.png` shows no model above the fold. `model-selection-page.tsx` renders `AssistantMemorySettingsSection` and `SubagentSettingsSection` before `ModelList`. |
| Screen real estate is wasted. Every settings category uses `mx-auto max-w-3xl`, so at 1440 px the content is 768 px wide and about 360 px is empty on each side. | `settings-page-content.tsx:315`, measured with `getBoundingClientRect` |
| Each row is **120 px tall**: switch, name, a "Streaming" badge on nearly every row, tagline, description, best-for tags and a mono id, all stacked. The 108 rows add up to about 13,000 px. | measured `[data-testid^=model-row-]` height = 120 |
| Two scrollbars. The list lives in a fixed `h-[620px]` `ScrollArea` inside the page's own scroll. | `model-list.tsx` `ModelListContent` |
| Nothing folds. Provider groups are static `Card`s, so the only way to get OpenRouter's 59 rows out of view is to type a search. | `model-list.tsx` |
| Chat and Embedding are separate tabs, and Remote and Local are toggle buttons, so there is no single view of "everything I have enabled". There is also no enabled/disabled filter. | `model-list.tsx` |
| The page shows none of the facts that matter when choosing a model, even though the static registry has them: context window (108/116 rows), max output (100), pricing (103), vision (108), reasoning (via `resolveModelReasoningSupport`). | `provider-catalog.json` key census |
| Search is a raw substring match, not the repo's tokenised-AND rule (`matchesModelQuery`), so `claude opus` finds nothing. | `model-list.tsx` `filteredModels` |
| All rows render eagerly, with no virtualisation. | 108 rows in the DOM |
| `model-filters.ts` is dead code: only its own test imports it. | `grep` |

## 2. Principles

1. **Put the catalog first.** The page is about models. Settings that merely *use* a
   model belong where users look for that behaviour.
2. **One line per model, details on demand.** A row carries what you compare across
   models (name, capabilities, context, price, state). Everything else goes in an
   inline details row.
3. **Scale by folding and filtering, not scrolling.** Provider sections fold and have
   sticky headers. Filters compose (AND), counts are always visible, and one action
   clears everything.
4. **Stable under the pointer.** Toggling never reorders rows. This is the Provider
   Hub's frozen-order rule, and the current list already relies on it.
5. **Reuse the shared primitives and contracts**: TreeTable (virtualised treegrid,
   shared-scroller mode), `matchesModelQuery`, `formatContextWindow`,
   `ProviderIcon`/`PROVIDER_COLOR_MAP`, `Switch`, `Popover`, `DropdownMenu`,
   `useModelToggle`, toast actions. The UI invents no new visual language. Tokens,
   type scale and density come from the running app.
6. **Absence is explicit.** An unpriced model shows `—` with "No published price",
   never `$0`. Reasoning `unknown` renders as "unverified", never coerced. A row with
   no registry entry shows `—` for registry facts.

## 3. Information architecture

### 3.1 What moves off this page

| Content | Decision | Reason |
| --- | --- | --- |
| **Assistant Memory** (observational memory, semantic recall) | **Move** to a new **Assistant Memory** settings category, on both desktop and web, keeping `assistantMemoryBackendAvailable` and `providerKeySources`. Keywords: `memory, observations, semantic recall, mastra, embedding`. | It configures agent behaviour, not the catalog. It is the single biggest reason the catalog is "hard to find". |
| **Subagent budgets** (`SubagentSettingsSection`) | **Move** into the existing **Subagents** category (`createSubagentPersonasSettingsCategory`), above or below the personas. | Users already look for subagent configuration there. |
| **Local model cache directory** | **Keep, compacted.** A header button shows the current value (`Local cache · System default`) and opens a `Popover` holding the existing input, the folder picker and the help text. | It only affects downloaded local models, so it does not deserve a full-width form row at the top. Showing the value on the button keeps it visible, not buried. |
| **Refresh registry** | **Keep** as an icon button in the page header (`model-registry-refresh`). | — |
| Downloads | **Keep** in the row's actions cell (Download → progress → Downloaded). | — |

These moves are a **separate PR at the bottom of the stack** (section 10), so the
catalog PR diffs only catalog code.

### 3.2 Page anatomy (workspace layout)

```
┌ Model Catalog                                    [📁 Local cache · System default] [⟳] ┐
│ Browse every catalogued model and enable the ones you want.                          │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ [🔍 Search name, id, provider…  /] [All|Enabled|Disabled] [All|Chat|Embedding]         │
│ [👁 Vision] [✺ Reasoning] [Context: Any ▾] [Providers: All ▾]                         │
│ 17 of 122 models match · 3 providers  ("claude" ×) (Reasoning ×)  Clear filters      │
│                                                       ⇕ Expand all   ⇳ Collapse all  │
├──────────────────────────────────────────────────────────────────────────────────────┤
│      MODEL                               CAPABILITIES  CONTEXT  MAX OUT  $/1M IN·OUT │  column header (outside the scroller)
├──────────────────────────────────────────────────────────────────────────────────────┤ ← scroller starts
│ ˅ ◇ Anthropic  HOSTED  ▬▬▬── 5 / 7 enabled   6 shown         Enable 6 shown  Disable… │  sticky section header
│ [●] Claude Opus 5   For complex agentic coding…   👁 ✺    1M    128K   $5 · $25    ˅   │  36 px row
│ [○] Claude Sonnet 4.6                             👁 ✺  200K     64K   $3 · $15    ˅   │
│ › ◇ OpenRouter GATEWAY  ───── 0 / 59 enabled   4 shown                               │  collapsed section
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Workspace layout.** Add an optional `layout?: 'document' | 'workspace'` to
  `SettingsCategory` (`settings-page-content.tsx`). `document` (the default) keeps
  today's `mx-auto max-w-3xl` and page scroll for every other category. `workspace`
  drops the width cap, makes the content a full-height flex column, and lets the
  category own its scroll. This removes the double scrollbar and the 720 px of dead
  side space. It is one small, opt-in change to the shell.
- **Header, toolbar and result bar** stay fixed at the top of the category. Only the
  catalog scroller scrolls.
- **Sections are provider groups** in DB `sort_order`, the same order as today and
  the Provider Hub. Each header shows the chevron, the provider icon tile (colour from
  `PROVIDER_COLOR_MAP`), the name, a runtime tag (Hosted / Gateway / On device, from
  `getProviderDefinition(id).runtime`), an enabled meter with `n / total enabled`,
  `n shown` when filtered, and the bulk actions.

### 3.3 Default expansion

- On first render with no filters, **expand providers with at least one enabled
  model** and collapse the rest. Your working set is open, and the long tail (for
  example OpenRouter's 59 models) is one click away. If nothing is enabled anywhere,
  expand the first section.
- **While any filter or search is active, expansion is derived.** Every section with
  a match renders expanded, and a section the user collapses *during that filter
  session* stays collapsed. Clearing the filters restores the user's manual expansion
  set. That set is never mutated by searching.
- Expand all and Collapse all act on the manual set.
- Expansion is **component state only**, with no new persistence. Persisting it would
  need factory-reset wiring (`platform-contracts.md`) and is listed as a follow-up.

## 4. Finding things

| Control | Behaviour |
| --- | --- |
| **Search** | `matchesModelQuery`: case-insensitive, whitespace-tokenised AND over label, model id, provider id, provider name and tagline. Extend `ModelQueryFields` with an optional `keywords?: readonly string[]` so `bestFor` tags stay searchable, since the current list searches them and dropping that would regress. The change is backward compatible and does not affect the composer picker. `/` focuses search (unless focus is in an editable field). `Esc` clears, then blurs. Input is deferred (`useDeferredValue`). Matches are highlighted with `<mark>`. **Id on demand:** when a query word matches the model id but not the name, the row's secondary text switches from tagline to the mono id with the match highlighted. |
| **Status** | Segmented control (`role="radiogroup"`): All / Enabled / Disabled. |
| **Type** | Segmented control: All / Chat / Embedding. It replaces the Chat/Embeddings tabs. Default **All**. Embedding rows carry an `Embedding` tag when Type is All. |
| **Capabilities** | Toggle chips (`aria-pressed`): **Vision** (`vision === 'supported'`) and **Reasoning** (`resolveModelReasoningSupport(...).state === 'supported'`; `unknown` does not match). |
| **Context** | `Select`: Any / ≥ 128K / ≥ 200K / ≥ 1M. Rows with no context window never match a band. |
| **Providers** | `Popover` with a checkbox list of providers and per-provider counts ("All" when none are chosen). Needed at scale, because typing a provider name also matches ids like `anthropic/…` on OpenRouter. |
| **Result bar** | `aria-live="polite"`. With no filters it reads `122 models · 10 providers · 27 enabled`. With filters it reads `17 of 122 models match · 3 providers`, followed by removable chips for each active filter and **Clear filters**. |
| **Sort** | Column headers Model / Context / Max out / Price are sort buttons (`aria-sort`). Sorting is caller-owned, **within each provider section**, and cycles default (catalog order) → asc → desc. Absent values sort last in both directions (the TreeTable sorting contract). Price sorts by input rate. |
| **Empty states** | No matches: an `EmptyState` saying "No models match" with a Clear filters button. Provider has no matches: its section is hidden. Empty catalog: "No models are catalogued yet" with Refresh. Registry error: the existing `model-registry-error` block and Retry, unchanged. |

**Local runtimes:** Ollama and LM Studio models are discovered at runtime and never
written to the `models` table, so they are not in this catalog today. The `local`
(browser Gemma) and `transformers` (Transformers.js embeddings) sections appear with
download state. A **Downloaded** filter is not added; the actions cell shows download
state directly, and Status plus the On-device sections cover the need. Adding it
later is a one-predicate change.

## 5. Row design

Row pitch is **36 px**, one line. Columns at wide width (catalog container ≥ 900 px):

| Column | Width | Content |
| --- | --- | --- |
| Enabled | 52 | `Switch`, `aria-label="Enable <name>"`, `data-testid="model-toggle-<id>"` (kept). Disabled with `aria-busy` while a write is in flight. |
| Model | flex | **Name** (13 px, medium, `title` = model id), a `Recommended` tag when the registry marks it `default`, an `Embedding` tag when Type is All, and the **tagline** (muted, truncating). The id replaces the tagline when the search hits the id. |
| Capabilities | 84 | Icons with `role="img"` and `aria-label`: Vision (eye) and Reasoning (sun). Supported is foreground, unsupported is faint, unknown is dashed with the label "unverified". Embedding rows show dimensions instead (`1536-d`). |
| Context | 76 | Compact tokens, right-aligned, tabular (`1.05M`, `200K`), `—` when absent. Extract `formatTokenCount` from `formatContextWindow`, which then calls it; no second formatter. |
| Max out | 84 | Same format as Context. |
| $ / 1M in · out | 128 | `$2.50 · $15`, with output muted. `Free` when both rates are 0. `—` with "No published price" when unpriced. Screen-reader text: "input $2.50, output $15 per million tokens". |
| Actions | 72 | For local rows: Download (with size), then inline progress (%), then a Downloaded check. The details disclosure (`aria-expanded`) sits in every row. |

**Details row** (TreeTable child node `type: 'detail'`, level 2) shows the model id
with a copy button (`CopyTextButton`), context and max output in full digits, pricing
(input, output, cache read, cache write when present), the reasoning effort ladder,
best-for tags, the description, and for downloaded local models the cache path. This
absorbs everything the current 120 px row stacks vertically.

The enabled row tint stays subtle (`bg-primary/5` equivalent). The current
`outline` on enabled rows goes, because it produces a heavy box grid when most rows
are enabled.

### Responsive (container queries on the catalog, not viewport media queries)

- **< 900 px:** hide Max out (still in details).
- **< 640 px** (the 900 px-viewport case, where the catalog is ~525 px): also hide
  Price and the inline tagline. The Capabilities header reads "Caps". Vision,
  Reasoning, Context and Providers collapse into one **Filters** popover button, with
  a count badge of active filters. The search spans the full row. Section headers
  drop the runtime tag and meter but keep `n / total` and the bulk actions.
- The column header follows the Explorer forest precedent. There is ONE header above
  the shared scroller, aligned by construction: the same column widths and the
  measured scrollbar gutter, `role="presentation"` with static labels, sort buttons
  kept in the accessibility tree, and cells describing themselves through sr-only
  text.

## 6. Bulk enable/disable

- Each section header has **Enable all / Disable all**. When filters are active the
  labels become **Enable N shown / Disable N shown**. Bulk actions only ever touch the
  rows that are visible, so "Disable all" under a `claude` search disables the
  Claude rows, not the whole provider.
- It is **one write, not N.** Add a store action,
  `setModelsEnabled(db, ids, enabled)`, which runs one
  `UPDATE models SET is_enabled = $1, updated_at = NOW() WHERE id = ANY($2)` plus one
  `syncDurableDatabaseWrites`, with an optimistic update and exact per-id rollback on
  failure. `useModelToggle` gains `toggleMany(ids, enabled): Promise<boolean>` with
  the same contract as `toggle`: it never rejects, reports failure with a destructive
  toast, and marks every id busy while the write is in flight. This is an app-state
  store change, **not a schema change**.
- **Undo.** Success shows `Disabled 59 OpenRouter models` with an **Undo** toast
  action. Undo restores the exact prior per-model states, grouped into at most two
  `setModelsEnabled` writes. There is no confirmation dialog, because the change is
  reversible and undoable.
- The Provider Hub's per-provider list keeps its own UI and shares the same hook, so
  a failure is reported the same way on both surfaces.

## 7. Keyboard and accessibility

- **Structure:** each expanded section is a TreeTable `role="treegrid"`, labelled
  `"<Provider> models"`. Model rows are level 1 and details rows level 2. Section
  headers are `<h3>` elements wrapping a disclosure `<button aria-expanded
  aria-controls>`. The bulk buttons sit beside the disclosure, not nested inside it.
- **Tab order:** toolbar controls, then per section: the disclosure button, the
  bulk buttons, then the treegrid (one tab stop with roving focus). DOM order
  follows the §3.2 visual order (WCAG 2.4.3); no `tabindex` reordering.
- **Inside the grid** (TreeTable keyboard): ↑/↓ move between rows, Home/End jump to
  the ends, → opens details (or moves into them), ← closes details or returns to the
  model row. **Space** toggles the focused row's switch through `onCheckboxSpace`, the
  same pattern a checkbox list uses. **Enter** toggles details. Keys pressed on
  interactive cell descendants (switch, download, copy) stay owned by those
  descendants, per the TreeTable row-chrome contract.
- Focus follows TreeTable's contract: roving `data-focused`, the ring only on
  keyboard modality, neutral focus tokens.
- Capability state is never shown by colour alone: icons carry `aria-label`s and the
  enabled meter has visible `n / total` text.
- Motion: the chevron rotation is the only transition, with a
  `prefers-reduced-motion` reset.
- Both light and dark themes use only existing tokens.

## 8. Performance

- **Size today:** 116 registry rows plus about 6 DB-only Transformers rows. OpenRouter
  alone is 59 and growing, and the design targets 500+.
- **Virtualisation:** one TreeTable per expanded section in **shared-scroller mode**.
  The catalog scroller is the scroll owner and passes `scrollParentRef` to every
  table. Each table's viewport becomes a non-scrolling spacer and windows through
  `scrollMargin`. This is the sanctioned multi-table pattern (`ui-conventions.md` →
  Scroll ownership), which the Explorer forest already uses. Sticky section headers
  sit in normal flow inside the same scroller (`position: sticky; top: 0`), so each
  one is pushed out by the next.
- Pin `windowingStrategy: 'virtual'`. Paged windowing would break the one continuous
  scroll.
- `rowHeight` is a **per-type record** (`{ model: 36, detail: 132 }`). That makes it a
  first-paint estimate that TreeTable measures, which suits details rows of variable
  height. The 36 px model pitch must still be **measured** in an E2E test
  (consecutive row tops), per "Row height and painted geometry". The mockup measures
  exactly 36.
- **Derivation:** the projection (DbModel joined with the registry) is memoised on
  `models` identity. The filter pass runs on the deferred query. Section node arrays
  are identity-stable (`TreeNode` objects reused per model id), so a toggle repaints
  one row and never rebuilds a section (the row identity contract). The frozen order
  is keyed by membership, as in `ProviderModelSection`.

## 9. Components and data

### Reused as-is

`TreeTable` (virtual, treegrid, keyboard, `scrollParentRef`, per-type row height,
caller-owned sort), `Switch`, `Button`, `Input`, `Popover`, `Select`, `DropdownMenu`,
`EmptyState`, `CopyTextButton`, `Tooltip`, toast plus `ToastAction`, `ProviderIcon`,
`PROVIDER_COLOR_MAP`, `matchesModelQuery`, `useModelToggle`,
`useEnsureModelRegistry`, the existing download functions, and the cache-directory
handlers moved into the popover unchanged.

### New (all in `packages/settings-ui/src/settings/models/` unless noted)

| Unit | Responsibility |
| --- | --- |
| `catalog-projection.ts` | Pure function that joins a `DbModel` with `findLlmModelDefinition` / `getProviderModelDefinitions` (embedding) and `resolveModelReasoningSupport`, plus the provider runtime, into a `CatalogRow`. `registry: null` for DB-only rows (for example `transformers`, which is not a `SupportedProvider`). Money and context are `number \| null`, never coerced to 0. |
| `catalog-filters.ts` | Pure predicate `matchesCatalogFilters(row, filters)` plus an AND composition, and the `CatalogFilters` type (a discriminated `status`/`type`, context band as a literal union). **Replaces the dead `model-filters.ts`**, which is deleted with its test. |
| `catalog-expansion.ts` | Pure default-expansion rule and the filter-session derivation. |
| `catalog-toolbar.tsx` | Search, segments, chips and popovers, with the compact Filters popover under 640 px. |
| `catalog-section.tsx` | Sticky header (disclosure, meter, bulk actions) and the section TreeTable. |
| `catalog-columns.tsx` | The TreeTable column definitions (one source for widths, shared by the header and the tables). |
| `model-catalog.tsx` | Composition and the scroll owner. Replaces `model-list.tsx`. |
| `use-model-toggle.ts` | Gains `toggleMany`. |
| `app-state` `model-registry-store.ts` | Gains `setModelsEnabled`. |
| `ui` `model-picker/utils` | `ModelQueryFields.keywords?`, and `formatTokenCount` extracted from `formatContextWindow`. |
| `settings-ui` `settings-page-content.tsx` | `SettingsCategory.layout?: 'document' \| 'workspace'`. |

Test ids are kept for E2E continuity: `model-row-<id>`, `model-toggle-<id>`,
`model-cache-dir-input` / `-select` (now inside the popover),
`model-registry-refresh`, `model-registry-error`, `model-registry-retry`.

## 10. Delivery (stacked, each layer green)

1. **Relocate non-catalog settings.** Add the Assistant Memory category (desktop and
   web). Move Subagent budgets into Subagents. Update the page-content tests and any
   E2E that reaches these sections through Model Catalog. No catalog changes.
2. **Catalog data layer.** `catalog-projection`, `catalog-filters`,
   `catalog-expansion`, `setModelsEnabled` and `toggleMany`, the `keywords` and
   `formatTokenCount` helpers, delete `model-filters.ts`. Pure and fully unit-tested,
   with no UI change.
3. **Catalog UI.** The workspace layout, toolbar, sections, rows, details, bulk
   actions and undo, cache popover; port `model-list.test.tsx`'s still-valid cases
   to `ModelCatalog` coverage and drop its Chat/Embeddings and Local/Remote
   assertions before deleting `model-list.tsx` and its test; update the web and
   desktop `settings-models-and-providers` E2E.

## 11. Testing and verification (RED/GREEN)

- **Unit, pure:**
  - projection: an unpriced row gives `null`, not 0; a DB-only row gives
    `registry: null`; reasoning `unknown` is preserved.
  - filters: every predicate, AND composition, band boundaries at exactly
    128,000 / 200,000 / 1,000,000, and absent context never matching.
  - `keywords` search.
  - expansion: default rule, the filter session, restore on clear.
  - Mutate every guard (flip each predicate and confirm a test fails).
- **Store and hook:**
  - `setModelsEnabled` issues one UPDATE and rolls back exact per-id state on failure
    (real-store test alongside `use-model-toggle-real-store.test.tsx`).
  - `toggleMany` never rejects, shows a destructive toast on failure, busy-marks all
    ids.
  - Undo restores mixed prior states.
- **Component** (`settings-ui`):
  - search auto-expands matching sections and hides the rest;
  - counts and result-bar text; Clear filters; empty state;
  - bulk actions are scoped to shown rows;
  - order is frozen after a toggle;
  - keyboard: `/`, Space toggles, → and ← for details, Enter;
  - `aria-expanded` on section disclosures; the compact Filters popover under
    640 px (container width mocked).
- **E2E:**
  - update the web and desktop `settings-models-and-providers` tests: expand a
    section or search before locating a row, and read the cache directory through
    the popover;
  - new assertions for measured row pitch = 36 and sticky section header geometry;
  - memory and subagent E2E paths move to the new categories.
- **Manual (CDT):** a built web preview at 1440 and 900 wide, light and dark. Screenshot
  the default, filtered, bulk-with-undo, details-open and download-in-progress states.
  Record a performance trace while scrolling with every section expanded.
- **Gates:** `pnpm dlx ultracite check`, React Doctor (changed scope), knip (the
  deletions), the `settings-ui`, `app-state` and `ui` unit lanes, and the web smoke
  E2E.

## 12. Out of scope (needs backend/schema or is a separate change)

- **Persisting expansion or filter state:** a new persistent store needs
  factory-reset wiring. This is a follow-up and not needed for v1.
- **Ollama and LM Studio discovered models in the catalog:** they are not in the
  `models` table, so including them needs persistence or discovery work.
- **Provider connection status in section headers** ("Not connected → Connect"): it
  is feasible with `useProviderAuthStates`, but it widens the PR. Follow-up.
- **Deep link from the Provider Hub** ("Browse and download all models") with the
  provider filter preset: it needs a category navigation parameter. Follow-up.
- A cross-provider flat "group by: none" view (for example cheapest 1M-context model
  across all providers). Follow-up.
- Tool-calling capability, long-context price tiers (BST-1708), and usage or
  last-used stats: not in the registry or schema.
- The `is_enabled` conflation of shipped-on and user-chose-on
  (model-enablement gap): a schema question, unchanged here.
