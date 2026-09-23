# Model Catalog Redesign (BST-1805, PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Model Catalog settings page's stacked 120 px card list with a full-width, full-height catalog: one-line rows in foldable provider sections with sticky headers, composable filters with live counts, inline details, and one-write bulk enable/disable with Undo. It must stay fast with hundreds of models.

**Architecture:** A pure data layer (`catalog-projection` → `catalog-filters` → `catalog-sections` → `catalog-expansion`) joins each `DbModel` with the static registry. It filters, groups, sorts and counts rows, and derives which sections are expanded. The UI renders one shared `TreeTable` per expanded provider section inside ONE scroll owner (shared-scroller mode, `scrollParentRef`). One presentational column header sits above that scroller, which is the Explorer forest precedent. Writes go through `useModelToggle` (`toggle`, plus the new `toggleMany` backed by the new `setModelsEnabled` store action). The new `useModelBulkToggle` layers the Undo toast on top. The settings shell gains an opt-in `layout: 'workspace'` and `headerActions` so this one category can own the full width and height.

**Tech Stack:** React 19, TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Tailwind CSS v4, zustand, PGlite, Radix primitives via `@brainstrike/ui`, `TreeTable` + `@tanstack/react-virtual`, Vitest + Testing Library (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-22-model-catalog-settings-redesign-design.md` (approved; the type filter defaults to **All**; this is PR 2, stacked on PR 1). Visual reference: the scratchpad `bst1805/mockup.html` and `mockup-*.png`.

**Worktree:** every path is relative to the PR 2 worktree root, called `$WT` below (`/Users/seandearnaley/Documents/GitHub/brainstrike-bst-1805-redesign`). Run every command from `$WT`. The scratchpad is `$SCRATCH` = `/private/tmp/claude-501/-Users-seandearnaley-Documents-GitHub-brainstrike/a7b8828b-8744-460a-9255-3d56758b3a31/scratchpad/bst1805`.

## Global Constraints

Every task implicitly includes all of these.

- **Commits:** the message is `<type>(BST-1805): <imperative summary>` (type is `feat`, `fix`, `test`, `refactor`, `docs` or `chore`). End every commit message with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work only on the PR 2 branch; never commit on `main`.
- **Never run `git stash`** in any form (the stash is shared across worktrees). Never `kill -9` the dev app.
- **TypeScript:** strict, and never `any`. Use `unknown` plus narrowing, and discriminated unions rather than enums. Annotate parameters and return types. The base tsconfig enables `exactOptionalPropertyTypes` (so never assign `undefined` to an optional property; spread it in conditionally) and `noUncheckedIndexedAccess`. Do not use non-null assertions (`!`).
- **Tailwind v4:** use literal class strings only, never runtime-composed class names. `packages/settings-ui/styles.css` already `@source`s `./src`.
- **Layers:** hardcode no `z-` utility in new code. The in-flow sticky provider header uses `STICKY_SECTION_HEADER_LAYER_CLASS` from `@brainstrike/ui` (added in Task 1). Popups keep their own tokens (`POPUP_LAYER_CLASS`, applied inside the primitives).
- **Popup anchors:** add no `transform`, `scale` or `zoom` to any element that anchors a popup (the `PopoverTrigger`/`SelectTrigger` buttons) or to a wrapper around one. The only transform the page adds is the chevron rotation inside non-anchor disclosure buttons, and it resets under `motion-reduce:`.
- **Writes:** every enable/disable goes through `useModelToggle().toggle`, `useModelToggle().toggleMany`, or `useModelBulkToggle` (built on `toggleMany`). No other code path writes `models.is_enabled`. A failed or refused write surfaces as a destructive toast, with no silent early return and no fallback.
- **Absence is explicit:** a fact the registry does not publish renders `—` with sr-only text naming what is missing. Reasoning `unknown` renders as "unverified". Never show `0` or `$0` for a missing value, and never coerce `unknown`.
- **TreeGrid contract** (`docs/agents/ui-conventions.md`):
  - Build on `@brainstrike/ui` `TreeTable`.
  - The catalog scroller is the ONE scroll owner, and every section table passes it as `scrollParentRef` with `windowingStrategy="virtual"`.
  - There is one presentational column header above the scroller (`role="presentation"`, the same `table-fixed` + `<colgroup>` widths, minus the measured scrollbar gutter).
  - TreeNodes are identity-stable per `CatalogRow` identity, and row-facing callbacks and column definitions are identity-stable.
  - `rowHeight` is a per-type record (a first-paint estimate), and the painted pitch is measured in E2E.
- **Files:** use kebab-case names. Components are exported in PascalCase; hooks live in `use-*.ts`/`use-*.tsx` and are exported in camelCase. A `.tsx` module that exports a component exports only components (plus types), per ESLint `react-refresh/only-export-components` on the per-rule warning ratchet.
- **Formatting:** run `pnpm exec biome check --write <changed files>` before every commit (block statements, sorted keys and props, and similar), and run `pnpm dlx ultracite check` in the final gate.
- **TDD:** each task writes its tests first, runs them RED, then implements until GREEN. Every guard listed under "Mutation check" must be mutated to prove a test fails; revert the mutation before committing.
- **Full lanes, not name filters:** before pushing, run the FULL package lanes (`pnpm --filter @brainstrike/settings-ui test`, `pnpm --filter @brainstrike/ui test`, `pnpm --filter @brainstrike/app-state test`, `pnpm --filter @brainstrike/app-state test:integration`, `pnpm test:scripts`). A shrink-only boundary test was missed on a previous PR because only name-filtered runs were used. A focused `exec vitest run <file>` is for the RED/GREEN loop only.
- **Type-check** goes through turbo so referenced `dist` declarations are rebuilt: `node scripts/run-turbo-command.mjs -- run type-check --filter=<pkg>`.
- **Quality gates:**
  - React Doctor reports no new error-severity issue (`npx react-doctor . --scope changed --verbose`).
  - `pnpm run lint:eslint` passes (the per-rule warning ratchet must neither grow nor shrink unbanked).
  - `pnpm knip` reports nothing for the touched packages (the deleted `model-list.tsx`/`model-filters.ts` leave no dangling exports).
- **Web E2E runs against `apps/web/dist`** (`vite preview`) and never builds. Run `pnpm run build:web` before EVERY web E2E run that follows a source change. Desktop E2E needs `pnpm turbo run build --filter=@brainstrike/desktop --force`.
- **Scope fence:** touch only the files in the File Structure table. If a task seems to need another file, stop and report instead of widening the change.

## Design decisions resolved while planning

These are recorded so no executor relitigates them.

1. **Scope:** spec §10 lists three layers. The approved header ("two-PR stack") puts the data layer and the UI together in PR 2, so this plan contains both.
2. **Header actions:** the mockup puts **Local cache** and **Refresh** at the right of the category title. `SettingsCategory` gains an optional `headerActions?: ReactNode`, which is rendered in both layouts (Task 5).
3. **Token formatter:** `formatTokenCount` keeps `formatContextWindow`'s existing one-decimal rounding (`1_050_000 → "1.1M"`), because `composer-model-picker.test.tsx` pins `1.1M context`. The mockup's `1.05M` is illustrative, and the details row shows full digits.
4. **Tagline source:** the row shows the **DB** `tagline` (this page's catalog of record, and what the current list and the Provider Hub show), not the registry's composer tagline.
5. **Bulk SQL:** the write is a single atomic statement: `UPDATE … WHERE id = ANY($2) AND (SELECT count(*) FROM models WHERE id = ANY($2)) = $3 RETURNING id`. If any id is missing, nothing is written; a short `RETURNING` set is a hard failure that restores state. The store action returns the prior per-id states for Undo.
6. **Bulk scope:** "Enable all" and "Enable N shown" write only the SHOWN rows whose state would actually change. A button with nothing to change is disabled.
7. **Expand all / Collapse all:** these act on the set that currently drives expansion. With no filter active that is the manual set; during a filter session it is the session's collapsed set. Otherwise both buttons would do nothing while filtering. The manual set is never mutated by searching.
8. **Test id continuity:**
   - `model-row-<id>` now sits on the Model cell (TreeTable owns the `<tr>`).
   - `model-toggle-<id>` is unchanged.
   - `model-cache-dir-input` and `model-cache-dir-select` move inside a popover opened by the new `model-cache-dir-trigger`.
   - The web toggle-persistence E2E deliberately migrates from walking `model-row-*` rows to `[data-testid^="model-toggle-"][aria-checked="false"]`, and it searches for the model after reload, because windowing means an off-screen row is not in the DOM.
9. **Status filter:** toggling a row under Status = Enabled/Disabled removes it from view. That is a membership change, not a reorder; row ORDER never depends on enabled state.
10. **Column widths:** Enabled is 60 px, not the spec's 52, because the shared `Switch` is 44 px wide and cells keep `px-2`. Capabilities is 96 px, so the uppercase header fits. Context and Actions are 80 and 88 px. Actions holds the local-download control and the details disclosure together. Only these numbers differ from spec §5.
11. **Scrollbar gutter:** `useScrollbarGutterWidth` duplicates the Explorer header's private 15-line measurement instead of promoting it into `@brainstrike/ui` (a `file-explorer-ui` change is out of scope). A follow-up can dedupe it.

## Precondition (orchestrator, before Task 1)

PR 1 (move Assistant Memory into its own category, and subagent budgets into Subagents) must be committed on its branch.

```bash
cd $WT
git status --short                      # expect: clean
git log --oneline -3                    # expect: PR 1's commits on top
grep -n "AssistantMemorySettingsSection\|SubagentSettingsSection" packages/settings-ui/src/settings/models/model-selection-page.tsx
# expect: no output
grep -n "export function ModelSelectionPage" -A2 packages/settings-ui/src/settings/models/model-selection-page.tsx
# expect: `export function ModelSelectionPage() {` or a destructure with NO memory props.
# If `assistantMemoryBackendAvailable` or `providerKeySources` is still a prop, STOP and report — Task 9's code assumes they are gone.
git switch -c seandearnaley/bst-1805-model-catalog-redesign
```

---

## File Structure

| File | Status | Responsibility | Task |
| --- | --- | --- | --- |
| `packages/ui/src/model-picker/utils/match-model-query.ts` | modify | `ModelQueryFields.keywords?` | 1 |
| `packages/ui/src/model-picker/utils/format-context-window.ts` | modify | extract `formatTokenCount` | 1 |
| `packages/ui/src/model-picker/index.ts` | modify | export `formatTokenCount` | 1 |
| `packages/ui/src/layers.ts` | modify | `STICKY_SECTION_HEADER_LAYER_CLASS` | 1 |
| `packages/ui/src/model-picker/__tests__/match-model-query.test.ts` | modify | keywords tests | 1 |
| `packages/ui/src/model-picker/__tests__/format-token-count.test.ts` | create | formatter tests | 1 |
| `packages/ui/src/__tests__/layers.test.ts` | modify | sticky token invariant | 1 |
| `docs/agents/ui-conventions.md` | modify | sticky token row; catalog as a shared-scroller consumer | 1, 7 |
| `packages/settings-ui/src/settings/models/catalog-projection.ts` | create | `DbModel` + registry → `CatalogRow` (memoised) | 2 |
| `packages/settings-ui/src/settings/models/catalog-filters.ts` | create | filter model, predicates, chips, highlight segments | 2 |
| `packages/settings-ui/src/settings/models/catalog-sections.ts` | create | grouping, per-section sort, counts, summary | 2 |
| `packages/settings-ui/src/settings/models/catalog-format.ts` | create | `formatUsd`, `pluralNoun`, `pluralize` | 2 |
| `packages/settings-ui/src/settings/models/model-filters.ts` (+ test) | delete | dead code | 2 |
| `packages/settings-ui/src/settings/models/catalog-expansion.ts` | create | pure default-expansion and filter-session rules | 3 |
| `packages/settings-ui/src/settings/models/use-catalog-expansion.ts` | create | hook over the pure rules | 3 |
| `packages/app-state/src/stores/model-registry-store.ts` | modify | `setModelsEnabled` | 4 |
| `packages/settings-ui/src/settings/models/use-model-toggle.ts` | modify | `toggleMany` | 4 |
| `packages/settings-ui/src/settings/models/use-model-bulk-toggle.tsx` | create | bulk change + Undo toast | 4 |
| `packages/settings-ui/src/settings-page-content.tsx` | modify | `layout`, `headerActions` | 5 |
| `packages/settings-ui/src/settings/models/catalog-nodes.ts` | create | identity-stable TreeNodes | 6 |
| `packages/settings-ui/src/settings/models/use-catalog-row-actions.ts` | create | live row state context | 6 |
| `packages/settings-ui/src/settings/models/catalog-model-details.tsx` | create | inline details row | 6 |
| `packages/settings-ui/src/settings/models/catalog-columns.tsx` | create | width tiers, column layouts, cells | 6 |
| `packages/settings-ui/src/settings/models/use-scrollbar-gutter-width.ts` | create | scroller gutter measurement | 6 |
| `packages/settings-ui/src/settings/models/catalog-column-header.tsx` | create | the single presentational header with sort buttons | 6 |
| `packages/settings-ui/src/settings/models/catalog-section.tsx` | create | sticky provider header + section TreeTable | 7 |
| `packages/settings-ui/src/settings/models/catalog-toolbar.tsx` | create | search, segments, chips, popovers, result bar | 8 |
| `packages/settings-ui/src/settings/models/model-catalog.tsx` | create | composition, scroll owner, width tier, `/` shortcut | 9 |
| `packages/settings-ui/src/settings/models/model-cache-directory-popover.tsx` | create | the cache-directory form, moved into a popover | 9 |
| `packages/settings-ui/src/settings/models/model-selection-page.tsx` | modify | slim page + `ModelCatalogHeaderActions` | 9 |
| `packages/settings-ui/src/settings/models/model-list.tsx` (+ test) | delete | replaced | 9 |
| `apps/web/src/app/settings/page-content.tsx` | modify | workspace layout + header actions | 9 |
| `apps/desktop/src/renderer/components/settings/page-content.tsx` | modify | workspace layout + header actions | 9 |
| 4 app test files mocking `model-selection-page` | modify | add the `ModelCatalogHeaderActions` export to the mock | 9 |
| `apps/web/e2e/settings-models-and-providers.test.ts` | modify | migrate selectors; pitch and sticky geometry | 10 |
| `apps/desktop/e2e/settings-models-and-providers.desktop.test.ts` | modify | cache popover selectors | 10 |

Test files created under `packages/settings-ui/src/settings/models/__tests__/`:

| Test file | Task |
| --- | --- |
| `catalog-test-harness.ts` | 2 |
| `catalog-projection.test.ts` | 2 |
| `catalog-filters.test.ts` | 2 |
| `catalog-sections.test.ts` | 2 |
| `catalog-format.test.ts` | 2 |
| `catalog-expansion.test.ts` | 3 |
| `use-catalog-expansion.test.tsx` | 3 |
| `use-model-bulk-toggle.test.tsx` | 4 |
| `catalog-dom-harness.ts` | 6 |
| `catalog-nodes.test.ts` | 6 |
| `catalog-columns.test.tsx` | 6 |
| `catalog-column-header.test.tsx` | 6 |
| `catalog-section.test.tsx` | 7 |
| `catalog-toolbar.test.tsx` | 8 |
| `model-catalog.test.tsx` | 9 |
| `model-cache-directory-popover.test.tsx` | 9 |

Task 4 also creates `packages/app-state/src/__tests__/model-registry-store-bulk.test.ts` and `model-registry-store-bulk.integration.test.ts`.

**Why no new shared primitive:** the section view is `TreeTable`. Search, chips, toggles, popovers and selects are the existing `Input`/`Button`/`Badge`/`Popover`/`Select`/`Checkbox`. The segmented control is two native radio groups styled with `has-[:checked]:`, which gives native arrow-key semantics and needs no new component. The only new visual element in `@brainstrike/ui` is one layer token.

---
### Task 1: `@brainstrike/ui` helpers — searchable keywords, `formatTokenCount`, sticky layer token

**Files:**
- Modify: `packages/ui/src/model-picker/utils/match-model-query.ts`
- Modify: `packages/ui/src/model-picker/utils/format-context-window.ts`
- Modify: `packages/ui/src/model-picker/index.ts:4`
- Modify: `packages/ui/src/layers.ts` (append a constant)
- Modify: `docs/agents/ui-conventions.md` (FLOATING LAYER STACKING table)
- Test: `packages/ui/src/model-picker/__tests__/match-model-query.test.ts` (append)
- Test: `packages/ui/src/model-picker/__tests__/format-token-count.test.ts` (create)
- Test: `packages/ui/src/__tests__/layers.test.ts` (append)

**Interfaces:**
- Produces:
  - `ModelQueryFields.keywords?: readonly string[] | undefined`. This is backward compatible; the composer picker passes none.
  - `formatTokenCount(tokens: number): string`, exported from `@brainstrike/ui`.
  - `STICKY_SECTION_HEADER_LAYER_CLASS = 'z-10'`, exported from `@brainstrike/ui`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ui/src/model-picker/__tests__/match-model-query.test.ts`:

```ts
describe('matchesModelQuery keywords (BST-1805)', () => {
  const tagged: ModelQueryFields = {
    keywords: ['Coding', 'Tool use'],
    label: 'GPT-5.4',
    modelId: 'gpt-5.4',
    providerId: 'openai',
  };

  it('matches a query word against a keyword', () => {
    expect(matchesModelQuery(tagged, 'tool')).toBe(true);
  });

  it('still requires every word, keywords included', () => {
    expect(matchesModelQuery(tagged, 'coding gpt')).toBe(true);
    expect(matchesModelQuery(tagged, 'coding claude')).toBe(false);
  });

  it('never matches a word across two keywords', () => {
    expect(matchesModelQuery(tagged, 'codingtool')).toBe(false);
  });

  it('is unchanged for callers that pass no keywords', () => {
    expect(
      matchesModelQuery({ label: 'GPT-5.4', modelId: 'gpt-5.4', providerId: 'openai' }, 'tool')
    ).toBe(false);
  });
});
```

Create `packages/ui/src/model-picker/__tests__/format-token-count.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatContextWindow, formatTokenCount } from '../utils/format-context-window';

describe('formatTokenCount', () => {
  it.each([
    [512, '512'],
    [999, '999'],
    [1000, '1K'],
    [64_000, '64K'],
    [128_000, '128K'],
    [131_072, '131K'],
    [200_000, '200K'],
    [1_000_000, '1M'],
    [1_050_000, '1.1M'],
    [2_000_000, '2M'],
  ])('%i → %s', (tokens, expected) => {
    expect(formatTokenCount(tokens)).toBe(expected);
  });
});

describe('formatContextWindow', () => {
  it('is formatTokenCount plus the "context" suffix', () => {
    expect(formatContextWindow(1_050_000)).toBe('1.1M context');
    expect(formatContextWindow(200_000)).toBe('200K context');
    expect(formatContextWindow(512)).toBe('512 context');
  });
});
```

In `packages/ui/src/__tests__/layers.test.ts`, add `STICKY_SECTION_HEADER_LAYER_CLASS,` to the import list from `'../layers'` (keep it sorted: after `POPUP_LAYER_CLASS,`). Then append inside `describe('floating layer scale', () => { … })`, before its closing `});`:

```ts
  // BST-1805: the Model Catalog's sticky provider headers are IN-FLOW (inside
  // one scroller), so they only need to out-rank positioned row content painted
  // later in that scroller (Switch thumbs, focus rings) and must stay under
  // every floating layer a header control can open.
  it('keeps the in-flow sticky section header below every floating layer', () => {
    const sticky = zIndexOf(STICKY_SECTION_HEADER_LAYER_CLASS);
    expect(sticky).toBeGreaterThan(0);
    expect(sticky).toBeLessThan(zIndexOf(DIALOG_LAYER_CLASSES[0].overlay));
    expect(sticky).toBeLessThan(zIndexOf(POPUP_LAYER_CLASS));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/model-picker/__tests__/match-model-query.test.ts src/model-picker/__tests__/format-token-count.test.ts src/__tests__/layers.test.ts`

Expected: FAIL for three reasons:
- a type/import error that `formatTokenCount` is not exported;
- `STICKY_SECTION_HEADER_LAYER_CLASS` is undefined, so `zIndexOf` throws;
- `'tool'` → `false`.

- [ ] **Step 3: Implement**

Replace `packages/ui/src/model-picker/utils/match-model-query.ts` with:

```ts
/** The text a model can be found by. */
export interface ModelQueryFields {
  /**
   * Extra searchable tags that are never displayed by the matcher (BST-1805:
   * the Model Catalog passes a row's best-for tags so they stay searchable).
   */
  keywords?: readonly string[] | undefined;
  label: string;
  modelId: string;
  providerId: string;
  providerName?: string | null | undefined;
  tagline?: string | null | undefined;
}

// Newline separates fields so a query word (which never contains whitespace)
// cannot match across two of them.
const FIELD_SEPARATOR = '\n';

/**
 * Case-insensitive, whitespace-tokenised AND: every word must appear in one of
 * the fields. An empty or whitespace-only query matches everything. No fuzzy
 * matching — the same rule the command palette documents.
 */
export function matchesModelQuery(fields: ModelQueryFields, query: string): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return true;
  }
  const haystack = [
    fields.label,
    fields.modelId,
    fields.providerId,
    fields.providerName ?? '',
    fields.tagline ?? '',
    ...(fields.keywords ?? []),
  ]
    .join(FIELD_SEPARATOR)
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}
```

Replace `packages/ui/src/model-picker/utils/format-context-window.ts` with:

```ts
/**
 * Compact token count ("1.1M", "200K", "512") shared by every model-facts
 * surface — the composer badge and the Model Catalog columns — so the two can
 * never disagree about how a number is rounded.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return `${tokens}`;
}

/** Compact "1M context" / "200K context" badge copy for model rows. */
export function formatContextWindow(tokens: number): string {
  return `${formatTokenCount(tokens)} context`;
}
```

In `packages/ui/src/model-picker/index.ts`, replace

```ts
export { formatContextWindow } from './utils/format-context-window';
```

with

```ts
export { formatContextWindow, formatTokenCount } from './utils/format-context-window';
```

Append to `packages/ui/src/layers.ts`, after `TOAST_LAYER_CLASS`:

```ts
/**
 * In-flow sticky section headers inside ONE scroller (the Model Catalog's
 * provider headers, BST-1805). Not a floating layer: it only has to out-rank
 * positioned row content painted later in the same scroller (Switch thumbs,
 * focus rings), and it must stay below every dialog and popup tier so a popover
 * opened from a header control paints over it.
 */
export const STICKY_SECTION_HEADER_LAYER_CLASS = 'z-10';
```

In `docs/agents/ui-conventions.md`, § FLOATING LAYER STACKING, insert this row directly under the `| --- | --- | --- |` separator (the scale is lowest first):

```markdown
| In-flow sticky section header (inside one scroller; not floating) | `STICKY_SECTION_HEADER_LAYER_CLASS` | `10` |
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/model-picker/__tests__/match-model-query.test.ts src/model-picker/__tests__/format-token-count.test.ts src/__tests__/layers.test.ts`

Expected: PASS.

- [ ] **Step 5: Mutation check**

Remove `...(fields.keywords ?? []),` from the haystack and re-run the Step 4 command. Expected: FAIL on `'tool'`. Restore the line and confirm PASS.

- [ ] **Step 6: Run the full lanes for the touched packages**

Run:
- `pnpm --filter @brainstrike/ui test`
- `pnpm --filter @brainstrike/assistant-ui exec vitest run --project unit src/__tests__/composer-model-picker.test.tsx`, which proves `1.1M context` is unchanged
- `node scripts/run-turbo-command.mjs -- run type-check --filter=@brainstrike/ui`

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write packages/ui/src/model-picker/utils/match-model-query.ts packages/ui/src/model-picker/utils/format-context-window.ts packages/ui/src/model-picker/index.ts packages/ui/src/layers.ts packages/ui/src/model-picker/__tests__/match-model-query.test.ts packages/ui/src/model-picker/__tests__/format-token-count.test.ts packages/ui/src/__tests__/layers.test.ts
git add packages/ui/src/model-picker packages/ui/src/layers.ts packages/ui/src/__tests__/layers.test.ts docs/agents/ui-conventions.md
git commit -m "feat(BST-1805): add catalog search keywords, token formatter and sticky layer token

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Catalog data layer — projection, filters, sections, formatting

**Files:**
- Create: `packages/settings-ui/src/settings/models/catalog-projection.ts`
- Create: `packages/settings-ui/src/settings/models/catalog-filters.ts`
- Create: `packages/settings-ui/src/settings/models/catalog-sections.ts`
- Create: `packages/settings-ui/src/settings/models/catalog-format.ts`
- Delete: `packages/settings-ui/src/settings/models/model-filters.ts`
- Delete: `packages/settings-ui/src/settings/models/__tests__/model-filters.test.ts`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-test-harness.ts`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-projection.test.ts`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-filters.test.ts`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-sections.test.ts`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-format.test.ts`

**Interfaces:**
- Consumes:
  - From Task 1: `matchesModelQuery` with `keywords`.
  - From the registry: `findProviderDefinition(providerId)`, `ProviderModelDefinition`, `ModelVisionSupport`, `ProviderRuntime` (all from `@brainstrike/assistant-contract/provider-registry`), and `resolveModelReasoningSupport`, `resolveReasoningControlsAvailability`, `ModelReasoningSupport`, `ReasoningControlsAvailability` (from `@brainstrike/assistant-contract/model-reasoning`).
  - `isLocalModelProviderId` from `@brainstrike/app-state/models/local-model-utils`.
- Produces (exact names later tasks import):
  - `catalog-projection.ts`: `CatalogRow`, `CatalogPricing`, `CatalogModelType`, `projectCatalogRow(model: DbModel, providerName: string): CatalogRow`, `createCatalogProjector(): (model: DbModel, providerName: string) => CatalogRow`.
  - `catalog-filters.ts`:
    - types: `CatalogFilters`, `CatalogStatusFilter`, `CatalogTypeFilter`, `CatalogContextBand`, `CatalogFilterKey`, `CatalogFilterChip`, `HighlightSegment`;
    - constants: `DEFAULT_CATALOG_FILTERS`, `CONTEXT_BAND_MIN_TOKENS`, `CONTEXT_BAND_LABELS`, `CONTEXT_BAND_OPTIONS`;
    - functions: `parseContextBand(value: string): CatalogContextBand`, `matchesCatalogFilters(row, filters): boolean`, `isCatalogFilterActive(filters): boolean`, `describeActiveFilters(filters, providerNames: ReadonlyMap<string, string>): readonly CatalogFilterChip[]`, `clearCatalogFilter(filters, key): CatalogFilters`, `queryHitsIdOnly(row: Pick<CatalogRow,'id'|'name'>, query): boolean`, `highlightSegments(text, query): readonly HighlightSegment[]`.
  - `catalog-sections.ts`:
    - types: `CatalogSort`, `CatalogSortColumn`, `CatalogProviderStat`, `CatalogSection`, `CatalogSummary`, `CatalogView`;
    - constants: `UNKNOWN_PROVIDER_SECTION_ID`, `UNKNOWN_PROVIDER_NAME`;
    - functions: `sortCatalogRows(rows, sort): readonly CatalogRow[]`, `buildCatalogView({ filters, providers, rows, sort }): CatalogView`.
  - `catalog-format.ts`: `formatUsd(amount: number): string`, `pluralNoun(count: number, singular: string): string`, `pluralize(count: number, singular: string): string`.
  - Test harness: `makeDbModel`, `makeDbProvider`, `makeCatalogRow`.

- [ ] **Step 1: Write the test harness and the failing tests**

Create `packages/settings-ui/src/settings/models/__tests__/catalog-test-harness.ts`:

```ts
import type { DbModel, DbProvider } from '@brainstrike/app-state/stores/model-registry-store';
import type { CatalogRow } from '../catalog-projection';

export function makeDbModel(overrides: Partial<DbModel> & Pick<DbModel, 'id'>): DbModel {
  return {
    bestFor: null,
    capabilities: { type: 'llm' },
    description: null,
    icon: null,
    isEnabled: false,
    name: overrides.id,
    parameters: null,
    providerId: 'openai',
    sortOrder: 0,
    tagline: null,
    ...overrides,
  };
}

export function makeDbProvider(id: string, name: string, sortOrder: number): DbProvider {
  return { icon: null, id, isEnabled: true, name, sortOrder };
}

export function makeCatalogRow(overrides: Partial<CatalogRow> & Pick<CatalogRow, 'id'>): CatalogRow {
  return {
    bestFor: [],
    contextWindow: 200_000,
    description: null,
    dimension: null,
    enabled: false,
    isLocal: false,
    maxOutputTokens: 64_000,
    name: overrides.id,
    pricing: { cacheReadPerMTok: null, cacheWritePerMTok: null, inputPerMTok: 3, outputPerMTok: 15 },
    providerId: 'anthropic',
    providerName: 'Anthropic',
    reasoning: { source: 'model', state: 'supported' },
    reasoningEfforts: ['low', 'medium', 'high'],
    recommended: false,
    registered: true,
    sizeLabel: null,
    tagline: null,
    type: 'chat',
    vision: 'supported',
    ...overrides,
  };
}
```

Create `packages/settings-ui/src/settings/models/__tests__/catalog-projection.test.ts`. It uses the REAL static registry, so a registry fact drift is caught here:

```ts
import { describe, expect, it } from 'vitest';
import { createCatalogProjector, projectCatalogRow } from '../catalog-projection';
import { makeDbModel } from './catalog-test-harness';

describe('projectCatalogRow', () => {
  it('joins the registry facts for a registered chat model', () => {
    const row = projectCatalogRow(
      makeDbModel({
        id: 'gpt-5.6-terra',
        isEnabled: true,
        name: 'GPT-5.6 Terra',
        providerId: 'openai',
        tagline: 'Most capable for everyday work',
      }),
      'OpenAI'
    );
    expect(row).toMatchObject({
      contextWindow: 1_050_000,
      enabled: true,
      isLocal: false,
      maxOutputTokens: 128_000,
      name: 'GPT-5.6 Terra',
      pricing: { cacheReadPerMTok: null, cacheWritePerMTok: null, inputPerMTok: 2.5, outputPerMTok: 15 },
      providerName: 'OpenAI',
      recommended: true,
      registered: true,
      tagline: 'Most capable for everyday work',
      type: 'chat',
      vision: 'supported',
    });
    expect(row.reasoning?.state).toBe('supported');
  });

  it('carries cache pricing and the offered effort ladder', () => {
    const row = projectCatalogRow(
      makeDbModel({ id: 'claude-opus-5', name: 'Claude Opus 5', providerId: 'anthropic' }),
      'Anthropic'
    );
    expect(row.pricing).toEqual({
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
      inputPerMTok: 5,
      outputPerMTok: 25,
    });
    expect(row.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('keeps an unpriced model null, never 0', () => {
    const row = projectCatalogRow(
      makeDbModel({ id: 'onnx-community/gemma-4-E2B-it-ONNX', providerId: 'local' }),
      'Local'
    );
    expect(row.pricing).toBeNull();
    expect(row.contextWindow).toBe(8192);
    expect(row.isLocal).toBe(true);
  });

  it('gives a DB-only row no registry facts at all', () => {
    const row = projectCatalogRow(
      makeDbModel({
        capabilities: { defaultDimension: 384, type: 'embedding' },
        id: 'Xenova/all-MiniLM-L6-v2',
        providerId: 'transformers',
      }),
      'Transformers.js'
    );
    expect(row).toMatchObject({
      contextWindow: null,
      dimension: 384,
      isLocal: true,
      maxOutputTokens: null,
      pricing: null,
      reasoning: null,
      reasoningEfforts: null,
      recommended: false,
      registered: false,
      type: 'embedding',
      vision: null,
    });
  });

  it('preserves an unknown reasoning state instead of coercing it', () => {
    const row = projectCatalogRow(
      makeDbModel({ id: 'openai/gpt-6-astra', providerId: 'openrouter' }),
      'OpenRouter'
    );
    expect(row.reasoning).toEqual({ reason: 'openrouter-undeclared', state: 'unknown' });
    expect(row.reasoningEfforts).toBeNull();
  });

  it('reads embedding dimensions and the registry default flag', () => {
    const row = projectCatalogRow(
      makeDbModel({
        capabilities: { defaultDimension: 1536, type: 'embedding' },
        id: 'text-embedding-3-small',
        providerId: 'openai',
      }),
      'OpenAI'
    );
    expect(row).toMatchObject({
      contextWindow: null,
      dimension: 1536,
      reasoning: null,
      recommended: true,
      type: 'embedding',
      vision: null,
    });
  });

  it('reads the size label and best-for tags from the DB row', () => {
    const row = projectCatalogRow(
      makeDbModel({
        bestFor: ['Coding', 'Tool use'],
        id: 'onnx-community/gemma-4-E2B-it-ONNX',
        parameters: { size: '1.2 GB' },
        providerId: 'local',
      }),
      'Local'
    );
    expect(row.sizeLabel).toBe('1.2 GB');
    expect(row.bestFor).toEqual(['Coding', 'Tool use']);
  });
});

describe('createCatalogProjector', () => {
  it('returns the same row for the same DbModel identity', () => {
    const project = createCatalogProjector();
    const model = makeDbModel({ id: 'gpt-5.6-terra', providerId: 'openai' });
    expect(project(model, 'OpenAI')).toBe(project(model, 'OpenAI'));
  });

  it('re-projects only a replaced DbModel (a toggle)', () => {
    const project = createCatalogProjector();
    const a = makeDbModel({ id: 'gpt-5.6-terra', providerId: 'openai' });
    const b = makeDbModel({ id: 'gpt-5.5', providerId: 'openai' });
    const aRow = project(a, 'OpenAI');
    const bRow = project(b, 'OpenAI');
    const toggledA = { ...a, isEnabled: true };
    const toggledRow = project(toggledA, 'OpenAI');
    expect(toggledRow).not.toBe(aRow);
    expect(toggledRow.enabled).toBe(true);
    expect(project(b, 'OpenAI')).toBe(bRow);
  });

  it('re-projects when the provider name changes', () => {
    const project = createCatalogProjector();
    const model = makeDbModel({ id: 'gpt-5.6-terra', providerId: 'openai' });
    const first = project(model, 'OpenAI');
    expect(project(model, 'OpenAI (renamed)')).not.toBe(first);
  });
});
```

Create `packages/settings-ui/src/settings/models/__tests__/catalog-filters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  type CatalogFilters,
  clearCatalogFilter,
  DEFAULT_CATALOG_FILTERS,
  describeActiveFilters,
  highlightSegments,
  isCatalogFilterActive,
  matchesCatalogFilters,
  parseContextBand,
  queryHitsIdOnly,
} from '../catalog-filters';
import { makeCatalogRow } from './catalog-test-harness';

function withFilters(overrides: Partial<CatalogFilters>): CatalogFilters {
  return { ...DEFAULT_CATALOG_FILTERS, ...overrides };
}

describe('matchesCatalogFilters', () => {
  it('matches everything under the defaults', () => {
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'a' }), DEFAULT_CATALOG_FILTERS)).toBe(true);
  });

  it('filters by enabled status', () => {
    const on = makeCatalogRow({ enabled: true, id: 'on' });
    const off = makeCatalogRow({ enabled: false, id: 'off' });
    expect(matchesCatalogFilters(on, withFilters({ status: 'enabled' }))).toBe(true);
    expect(matchesCatalogFilters(off, withFilters({ status: 'enabled' }))).toBe(false);
    expect(matchesCatalogFilters(off, withFilters({ status: 'disabled' }))).toBe(true);
    expect(matchesCatalogFilters(on, withFilters({ status: 'disabled' }))).toBe(false);
  });

  it('filters by type, defaulting to all', () => {
    const chat = makeCatalogRow({ id: 'chat', type: 'chat' });
    const embedding = makeCatalogRow({ id: 'emb', type: 'embedding' });
    expect(matchesCatalogFilters(embedding, DEFAULT_CATALOG_FILTERS)).toBe(true);
    expect(matchesCatalogFilters(chat, withFilters({ type: 'embedding' }))).toBe(false);
    expect(matchesCatalogFilters(embedding, withFilters({ type: 'embedding' }))).toBe(true);
    expect(matchesCatalogFilters(embedding, withFilters({ type: 'chat' }))).toBe(false);
  });

  it('matches Vision only when vision is supported', () => {
    const filters = withFilters({ vision: true });
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'y', vision: 'supported' }), filters)).toBe(true);
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'n', vision: 'unsupported' }), filters)).toBe(false);
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'u', vision: 'unknown' }), filters)).toBe(false);
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'x', vision: null }), filters)).toBe(false);
  });

  it('never lets an unknown reasoning state satisfy Reasoning', () => {
    const filters = withFilters({ reasoning: true });
    expect(
      matchesCatalogFilters(
        makeCatalogRow({ id: 'y', reasoning: { source: 'model', state: 'supported' } }),
        filters
      )
    ).toBe(true);
    expect(
      matchesCatalogFilters(
        makeCatalogRow({ id: 'u', reasoning: { reason: 'openrouter-undeclared', state: 'unknown' } }),
        filters
      )
    ).toBe(false);
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'x', reasoning: null }), filters)).toBe(false);
  });

  it.each([
    ['128k', 127_999, false],
    ['128k', 128_000, true],
    ['200k', 199_999, false],
    ['200k', 200_000, true],
    ['1m', 999_999, false],
    ['1m', 1_000_000, true],
  ] as const)('context band %s at %i tokens → %s', (band, tokens, expected) => {
    expect(
      matchesCatalogFilters(makeCatalogRow({ contextWindow: tokens, id: 'm' }), withFilters({ context: band }))
    ).toBe(expected);
  });

  it('never matches a context band when the window is unpublished', () => {
    const row = makeCatalogRow({ contextWindow: null, id: 'm' });
    for (const band of ['128k', '200k', '1m'] as const) {
      expect(matchesCatalogFilters(row, withFilters({ context: band }))).toBe(false);
    }
    expect(matchesCatalogFilters(row, withFilters({ context: 'any' }))).toBe(true);
  });

  it('filters by provider, where an empty set means every provider', () => {
    const row = makeCatalogRow({ id: 'm', providerId: 'openai' });
    expect(matchesCatalogFilters(row, withFilters({ providerIds: new Set(['openai']) }))).toBe(true);
    expect(matchesCatalogFilters(row, withFilters({ providerIds: new Set(['anthropic']) }))).toBe(false);
  });

  it('searches name, id, provider name, tagline and best-for tags with tokenised AND', () => {
    const row = makeCatalogRow({
      bestFor: ['Tool use'],
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      providerName: 'Anthropic',
      tagline: 'For complex agentic coding',
    });
    for (const query of ['claude opus', 'opus-5', 'anthropic', 'agentic', 'tool']) {
      expect(matchesCatalogFilters(row, withFilters({ query }))).toBe(true);
    }
    expect(matchesCatalogFilters(row, withFilters({ query: 'claude sonnet' }))).toBe(false);
  });

  it('composes every predicate with AND', () => {
    const row = makeCatalogRow({ contextWindow: 1_000_000, enabled: true, id: 'm', vision: 'supported' });
    const all = withFilters({ context: '1m', reasoning: true, status: 'enabled', vision: true });
    expect(matchesCatalogFilters(row, all)).toBe(true);
    expect(matchesCatalogFilters({ ...row, enabled: false }, all)).toBe(false);
    expect(matchesCatalogFilters({ ...row, vision: 'unsupported' }, all)).toBe(false);
    expect(matchesCatalogFilters({ ...row, contextWindow: 200_000 }, all)).toBe(false);
  });
});

describe('isCatalogFilterActive', () => {
  it('is false for the defaults and a whitespace query', () => {
    expect(isCatalogFilterActive(DEFAULT_CATALOG_FILTERS)).toBe(false);
    expect(isCatalogFilterActive(withFilters({ query: '   ' }))).toBe(false);
  });

  it.each([
    [{ query: 'x' }],
    [{ status: 'enabled' as const }],
    [{ type: 'chat' as const }],
    [{ vision: true }],
    [{ reasoning: true }],
    [{ context: '1m' as const }],
    [{ providerIds: new Set(['openai']) }],
  ])('is true for %o', (overrides) => {
    expect(isCatalogFilterActive(withFilters(overrides))).toBe(true);
  });
});

describe('describeActiveFilters / clearCatalogFilter', () => {
  it('describes each active filter as a removable chip and clears it', () => {
    const filters = withFilters({
      context: '200k',
      providerIds: new Set(['openai']),
      query: ' claude ',
      reasoning: true,
      status: 'disabled',
      type: 'embedding',
      vision: true,
    });
    const chips = describeActiveFilters(filters, new Map([['openai', 'OpenAI']]));
    expect(chips).toEqual([
      { key: 'query', label: '"claude"' },
      { key: 'status', label: 'Disabled' },
      { key: 'type', label: 'Embedding' },
      { key: 'vision', label: 'Vision' },
      { key: 'reasoning', label: 'Reasoning' },
      { key: 'context', label: 'Context ≥ 200K' },
      { key: 'providers', label: 'OpenAI' },
    ]);
    let cleared = filters;
    for (const chip of chips) {
      cleared = clearCatalogFilter(cleared, chip.key);
    }
    expect(isCatalogFilterActive(cleared)).toBe(false);
  });

  it('summarises more than two providers by count', () => {
    const chips = describeActiveFilters(
      withFilters({ providerIds: new Set(['a', 'b', 'c']) }),
      new Map()
    );
    expect(chips).toEqual([{ key: 'providers', label: '3 providers' }]);
  });
});

describe('parseContextBand', () => {
  it('accepts every option and rejects anything else', () => {
    expect(parseContextBand('any')).toBe('any');
    expect(parseContextBand('1m')).toBe('1m');
    expect(() => parseContextBand('2m')).toThrow('Unknown context band: 2m');
  });
});

describe('queryHitsIdOnly', () => {
  const row = { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' };
  it('is true when a word hits the id but not the name', () => {
    expect(queryHitsIdOnly(row, 'anthropic/')).toBe(true);
    expect(queryHitsIdOnly(row, 'opus-5')).toBe(true);
  });
  it('is false when every hit is also in the name, or the query is empty', () => {
    expect(queryHitsIdOnly(row, 'claude opus')).toBe(false);
    expect(queryHitsIdOnly(row, '')).toBe(false);
  });
});

describe('highlightSegments', () => {
  it('marks every occurrence of every query word, case-insensitively', () => {
    expect(highlightSegments('Claude Opus', 'opus CLA')).toEqual([
      { match: true, start: 0, text: 'Cla' },
      { match: false, start: 3, text: 'ude ' },
      { match: true, start: 7, text: 'Opus' },
    ]);
  });
  it('returns one unmarked segment without a query', () => {
    expect(highlightSegments('Claude', '  ')).toEqual([{ match: false, start: 0, text: 'Claude' }]);
  });
  it('merges overlapping matches', () => {
    expect(highlightSegments('aaa', 'aa')).toEqual([{ match: true, start: 0, text: 'aaa' }]);
  });
});
```

Create `packages/settings-ui/src/settings/models/__tests__/catalog-sections.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_FILTERS } from '../catalog-filters';
import type { CatalogRow } from '../catalog-projection';
import { buildCatalogView, sortCatalogRows, UNKNOWN_PROVIDER_SECTION_ID } from '../catalog-sections';
import { makeCatalogRow, makeDbProvider } from './catalog-test-harness';

const providers = [
  makeDbProvider('openai', 'OpenAI', 0),
  makeDbProvider('anthropic', 'Anthropic', 1),
  makeDbProvider('openrouter', 'OpenRouter', 2),
  makeDbProvider('transformers', 'Transformers.js', 3),
  makeDbProvider('cohere', 'Cohere', 4),
];

const rows: CatalogRow[] = [
  makeCatalogRow({ enabled: true, id: 'gpt-a', name: 'GPT A', providerId: 'openai', providerName: 'OpenAI' }),
  makeCatalogRow({ id: 'gpt-b', name: 'GPT B', providerId: 'openai', providerName: 'OpenAI' }),
  makeCatalogRow({ id: 'claude-a', name: 'Claude A', providerId: 'anthropic' }),
  makeCatalogRow({ id: 'or-a', name: 'Router A', providerId: 'openrouter', providerName: 'OpenRouter' }),
  makeCatalogRow({ id: 'mini', name: 'MiniLM', providerId: 'transformers', providerName: 'Transformers.js', type: 'embedding' }),
  makeCatalogRow({ id: 'ghost', name: 'Ghost', providerId: 'retired', providerName: 'Unknown provider' }),
];

describe('buildCatalogView', () => {
  it('groups rows by provider in DB order and puts unknown providers last', () => {
    const view = buildCatalogView({ filters: DEFAULT_CATALOG_FILTERS, providers, rows, sort: null });
    expect(view.sections.map((section) => section.providerId)).toEqual([
      'openai',
      'anthropic',
      'openrouter',
      'transformers',
      UNKNOWN_PROVIDER_SECTION_ID,
    ]);
    expect(view.sections[0]?.rows.map((row) => row.id)).toEqual(['gpt-a', 'gpt-b']);
  });

  it('omits providers that have no catalogued models', () => {
    const view = buildCatalogView({ filters: DEFAULT_CATALOG_FILTERS, providers, rows, sort: null });
    expect(view.providerStats.map((stat) => stat.providerId)).not.toContain('cohere');
  });

  it('labels each section with its provider runtime', () => {
    const view = buildCatalogView({ filters: DEFAULT_CATALOG_FILTERS, providers, rows, sort: null });
    const labels = Object.fromEntries(view.sections.map((s) => [s.providerId, s.runtimeLabel]));
    expect(labels).toEqual({
      [UNKNOWN_PROVIDER_SECTION_ID]: null,
      anthropic: 'Hosted',
      openai: 'Hosted',
      openrouter: 'Gateway',
      transformers: 'On device',
    });
  });

  it('hides sections without matches but keeps provider totals unfiltered', () => {
    const view = buildCatalogView({
      filters: { ...DEFAULT_CATALOG_FILTERS, query: 'gpt b' },
      providers,
      rows,
      sort: null,
    });
    expect(view.sections.map((section) => section.providerId)).toEqual(['openai']);
    expect(view.sections[0]).toMatchObject({ enabledCount: 1, totalCount: 2 });
    expect(view.sections[0]?.rows.map((row) => row.id)).toEqual(['gpt-b']);
    expect(view.providerStats).toHaveLength(5);
  });

  it('summarises the catalog with and without filters', () => {
    expect(
      buildCatalogView({ filters: DEFAULT_CATALOG_FILTERS, providers, rows, sort: null }).summary
    ).toEqual({
      enabledModels: 1,
      filtering: false,
      matchingModels: 6,
      matchingProviders: 5,
      totalModels: 6,
      totalProviders: 5,
    });
    expect(
      buildCatalogView({
        filters: { ...DEFAULT_CATALOG_FILTERS, type: 'embedding' },
        providers,
        rows,
        sort: null,
      }).summary
    ).toEqual({
      enabledModels: 1,
      filtering: true,
      matchingModels: 1,
      matchingProviders: 1,
      totalModels: 6,
      totalProviders: 5,
    });
  });
});

describe('sortCatalogRows', () => {
  const sortable = [
    makeCatalogRow({ contextWindow: 200_000, id: 'b', name: 'Beta', pricing: null }),
    makeCatalogRow({ contextWindow: null, id: 'n', name: 'Nil' }),
    makeCatalogRow({ contextWindow: 1_000_000, id: 'a', name: 'alpha' }),
    makeCatalogRow({ contextWindow: 200_000, id: 'c', name: 'Gamma' }),
  ];

  it('keeps catalog order when unsorted', () => {
    expect(sortCatalogRows(sortable, null)).toBe(sortable);
  });

  it('sorts numbers ascending and descending, absent last in BOTH directions, ties in catalog order', () => {
    const asc = sortCatalogRows(sortable, { column: 'context', direction: 'asc' });
    expect(asc.map((row) => row.id)).toEqual(['b', 'c', 'a', 'n']);
    const desc = sortCatalogRows(sortable, { column: 'context', direction: 'desc' });
    expect(desc.map((row) => row.id)).toEqual(['a', 'b', 'c', 'n']);
  });

  it('sorts names case-insensitively and price by the input rate', () => {
    expect(
      sortCatalogRows(sortable, { column: 'name', direction: 'asc' }).map((row) => row.id)
    ).toEqual(['a', 'b', 'c', 'n']);
    expect(
      sortCatalogRows(sortable, { column: 'price', direction: 'desc' }).map((row) => row.id)
    ).toEqual(['n', 'a', 'c', 'b']);
  });

  it('sorts inside each section only', () => {
    const view = buildCatalogView({
      filters: DEFAULT_CATALOG_FILTERS,
      providers,
      rows,
      sort: { column: 'name', direction: 'desc' },
    });
    expect(view.sections[0]?.rows.map((row) => row.id)).toEqual(['gpt-b', 'gpt-a']);
    expect(view.sections[1]?.providerId).toBe('anthropic');
  });
});
```

Price-sort note: every fixture row except `b` carries the harness default price (input $3), so `n`, `a` and `c` tie, keep catalog order, and the null price (`b`) goes last.

Create `packages/settings-ui/src/settings/models/__tests__/catalog-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatUsd, pluralize, pluralNoun } from '../catalog-format';

describe('formatUsd', () => {
  it.each([
    [15, '$15'],
    [2.5, '$2.50'],
    [0.4, '$0.40'],
    [1.25, '$1.25'],
    [0.075, '$0.075'],
    [0, '$0'],
  ])('%s → %s', (amount, expected) => {
    expect(formatUsd(amount)).toBe(expected);
  });
});

describe('pluralize', () => {
  it('uses the singular only for exactly one', () => {
    expect(pluralize(1, 'model')).toBe('1 model');
    expect(pluralize(0, 'model')).toBe('0 models');
    expect(pluralize(59, 'model')).toBe('59 models');
    expect(pluralNoun(2, 'provider')).toBe('providers');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/catalog-projection.test.ts src/settings/models/__tests__/catalog-filters.test.ts src/settings/models/__tests__/catalog-sections.test.ts src/settings/models/__tests__/catalog-format.test.ts`

Expected: FAIL. Each file reports `Failed to resolve import "../catalog-…"`.

- [ ] **Step 3: Implement the four modules**

Create `packages/settings-ui/src/settings/models/catalog-format.ts`:

```ts
/** "$15", "$2.50", "$0.075": whole dollars bare, cents to two places, finer rates as published. */
export function formatUsd(amount: number): string {
  if (Number.isInteger(amount)) {
    return `$${amount}`;
  }
  const cents = amount * 100;
  if (Math.abs(cents - Math.round(cents)) < 1e-9) {
    return `$${amount.toFixed(2)}`;
  }
  return `$${amount}`;
}

export function pluralNoun(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

export function pluralize(count: number, singular: string): string {
  return `${count} ${pluralNoun(count, singular)}`;
}
```

Create `packages/settings-ui/src/settings/models/catalog-projection.ts`:

```ts
import { isLocalModelProviderId } from '@brainstrike/app-state/models/local-model-utils';
import type { DbModel } from '@brainstrike/app-state/stores/model-registry-store';
import {
  type ModelReasoningSupport,
  type ReasoningControlsAvailability,
  resolveModelReasoningSupport,
  resolveReasoningControlsAvailability,
} from '@brainstrike/assistant-contract/model-reasoning';
import {
  findProviderDefinition,
  type ModelVisionSupport,
  type ProviderModelDefinition,
} from '@brainstrike/assistant-contract/provider-registry';

export type CatalogModelType = 'chat' | 'embedding';

export interface CatalogPricing {
  readonly cacheReadPerMTok: number | null;
  readonly cacheWritePerMTok: number | null;
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/**
 * One Model Catalog row: the DB row (the catalog of record — name, copy,
 * enabled state, order) joined with the static registry's facts (context,
 * pricing, capabilities). Absence is explicit: a fact the registry does not
 * publish is `null`, never 0 (BST-1805 design §2, principle 6).
 */
export interface CatalogRow {
  readonly bestFor: readonly string[];
  readonly contextWindow: number | null;
  readonly description: string | null;
  /** Embedding output dimension; `null` for chat rows. */
  readonly dimension: number | null;
  readonly enabled: boolean;
  readonly id: string;
  /** A downloadable on-device model (`local`, `transformers`). */
  readonly isLocal: boolean;
  readonly maxOutputTokens: number | null;
  readonly name: string;
  readonly pricing: CatalogPricing | null;
  readonly providerId: string;
  readonly providerName: string;
  /** `null` when there is no signal at all (embedding row, or provider absent from the registry). */
  readonly reasoning: ModelReasoningSupport | null;
  /** The offered effort/level ladder; only set when reasoning is `supported`. */
  readonly reasoningEfforts: readonly string[] | null;
  readonly recommended: boolean;
  /** Whether the static registry has an entry for this exact model. */
  readonly registered: boolean;
  readonly sizeLabel: string | null;
  readonly tagline: string | null;
  readonly type: CatalogModelType;
  readonly vision: ModelVisionSupport | null;
}

function findRegistryModel(model: DbModel): ProviderModelDefinition | undefined {
  return findProviderDefinition(model.providerId)?.models.find(
    (definition) => definition.id === model.id && definition.type === model.capabilities.type
  );
}

function toPricing(definition: ProviderModelDefinition | undefined): CatalogPricing | null {
  if (definition?.type !== 'llm' || !definition.pricing) {
    return null;
  }
  const { cacheReadPerMTok, cacheWritePerMTok, inputPerMTok, outputPerMTok } = definition.pricing;
  return {
    cacheReadPerMTok: cacheReadPerMTok ?? null,
    cacheWritePerMTok: cacheWritePerMTok ?? null,
    inputPerMTok,
    outputPerMTok,
  };
}

function effortLadder(controls: ReasoningControlsAvailability): readonly string[] {
  if (!controls.available) {
    return [];
  }
  switch (controls.family) {
    case 'google':
      return controls.levels;
    case 'local':
      return [];
    default:
      return controls.efforts;
  }
}

function resolveSizeLabel(parameters: DbModel['parameters']): string | null {
  const size = parameters?.['size'];
  return typeof size === 'string' ? size : null;
}

export function projectCatalogRow(model: DbModel, providerName: string): CatalogRow {
  const definition = findRegistryModel(model);
  const llm = definition?.type === 'llm' ? definition : undefined;
  const type: CatalogModelType = model.capabilities.type === 'embedding' ? 'embedding' : 'chat';
  const providerKnown = findProviderDefinition(model.providerId) !== undefined;
  const reasoning =
    type === 'chat' && providerKnown
      ? resolveModelReasoningSupport(model.providerId, model.id)
      : null;
  return {
    bestFor: Array.isArray(model.bestFor) ? model.bestFor : [],
    contextWindow: llm?.contextWindow ?? null,
    description: model.description,
    dimension: type === 'embedding' ? (model.capabilities.defaultDimension ?? null) : null,
    enabled: model.isEnabled,
    id: model.id,
    isLocal: isLocalModelProviderId(model.providerId),
    maxOutputTokens: llm?.maxOutputTokens ?? null,
    name: model.name,
    pricing: toPricing(definition),
    providerId: model.providerId,
    providerName,
    reasoning,
    reasoningEfforts:
      reasoning?.state === 'supported'
        ? effortLadder(resolveReasoningControlsAvailability(model.providerId, model.id))
        : null,
    recommended: definition?.default === true,
    registered: definition !== undefined,
    sizeLabel: resolveSizeLabel(model.parameters),
    tagline: model.tagline,
    type,
    vision: llm?.vision ?? null,
  };
}

/**
 * Memoised projection keyed on DbModel IDENTITY. The store replaces only the
 * toggled model's object, so a toggle re-projects one row and every other
 * CatalogRow — and the TreeNodes built from it — keeps its identity (TreeGrid
 * row-identity contract, docs/agents/ui-conventions.md).
 */
export function createCatalogProjector(): (model: DbModel, providerName: string) => CatalogRow {
  const cache = new WeakMap<DbModel, CatalogRow>();
  return (model, providerName) => {
    const cached = cache.get(model);
    if (cached && cached.providerName === providerName) {
      return cached;
    }
    const row = projectCatalogRow(model, providerName);
    cache.set(model, row);
    return row;
  };
}
```

Create `packages/settings-ui/src/settings/models/catalog-filters.ts`:

```ts
import { matchesModelQuery } from '@brainstrike/ui';
import type { CatalogRow } from './catalog-projection';

export type CatalogStatusFilter = 'all' | 'disabled' | 'enabled';
export type CatalogTypeFilter = 'all' | 'chat' | 'embedding';
export type CatalogContextBand = '128k' | '1m' | '200k' | 'any';

export interface CatalogFilters {
  readonly context: CatalogContextBand;
  /** Empty means every provider. */
  readonly providerIds: ReadonlySet<string>;
  readonly query: string;
  readonly reasoning: boolean;
  readonly status: CatalogStatusFilter;
  readonly type: CatalogTypeFilter;
  readonly vision: boolean;
}

export const DEFAULT_CATALOG_FILTERS: CatalogFilters = {
  context: 'any',
  providerIds: new Set<string>(),
  query: '',
  reasoning: false,
  status: 'all',
  type: 'all',
  vision: false,
};

/** Inclusive lower bounds: a band means "at least this many tokens". */
export const CONTEXT_BAND_MIN_TOKENS = {
  '128k': 128_000,
  '1m': 1_000_000,
  '200k': 200_000,
} as const satisfies Record<Exclude<CatalogContextBand, 'any'>, number>;

export const CONTEXT_BAND_LABELS = {
  '128k': '≥ 128K',
  '1m': '≥ 1M',
  '200k': '≥ 200K',
  any: 'Any',
} as const satisfies Record<CatalogContextBand, string>;

/** Display order for the Context select. */
export const CONTEXT_BAND_OPTIONS: readonly CatalogContextBand[] = ['any', '128k', '200k', '1m'];

export function parseContextBand(value: string): CatalogContextBand {
  const band = CONTEXT_BAND_OPTIONS.find((option) => option === value);
  if (band === undefined) {
    throw new Error(`Unknown context band: ${value}`);
  }
  return band;
}

function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function matchesContext(row: CatalogRow, band: CatalogContextBand): boolean {
  if (band === 'any') {
    return true;
  }
  return row.contextWindow !== null && row.contextWindow >= CONTEXT_BAND_MIN_TOKENS[band];
}

function matchesQuery(row: CatalogRow, query: string): boolean {
  return matchesModelQuery(
    {
      keywords: row.bestFor,
      label: row.name,
      modelId: row.id,
      providerId: row.providerId,
      providerName: row.providerName,
      tagline: row.tagline,
    },
    query
  );
}

export function matchesCatalogFilters(row: CatalogRow, filters: CatalogFilters): boolean {
  return (
    (filters.status === 'all' || row.enabled === (filters.status === 'enabled')) &&
    (filters.type === 'all' || row.type === filters.type) &&
    (!filters.vision || row.vision === 'supported') &&
    (!filters.reasoning || row.reasoning?.state === 'supported') &&
    matchesContext(row, filters.context) &&
    (filters.providerIds.size === 0 || filters.providerIds.has(row.providerId)) &&
    matchesQuery(row, filters.query)
  );
}

export function isCatalogFilterActive(filters: CatalogFilters): boolean {
  return (
    queryWords(filters.query).length > 0 ||
    filters.status !== 'all' ||
    filters.type !== 'all' ||
    filters.vision ||
    filters.reasoning ||
    filters.context !== 'any' ||
    filters.providerIds.size > 0
  );
}

export type CatalogFilterKey =
  | 'context'
  | 'providers'
  | 'query'
  | 'reasoning'
  | 'status'
  | 'type'
  | 'vision';

export interface CatalogFilterChip {
  readonly key: CatalogFilterKey;
  readonly label: string;
}

function describeProviders(
  providerIds: ReadonlySet<string>,
  providerNames: ReadonlyMap<string, string>
): string {
  if (providerIds.size > 2) {
    return `${providerIds.size} providers`;
  }
  return Array.from(providerIds, (id) => providerNames.get(id) ?? id).join(', ');
}

export function describeActiveFilters(
  filters: CatalogFilters,
  providerNames: ReadonlyMap<string, string>
): readonly CatalogFilterChip[] {
  const chips: CatalogFilterChip[] = [];
  const query = filters.query.trim();
  if (query) {
    chips.push({ key: 'query', label: `"${query}"` });
  }
  if (filters.status !== 'all') {
    chips.push({ key: 'status', label: filters.status === 'enabled' ? 'Enabled' : 'Disabled' });
  }
  if (filters.type !== 'all') {
    chips.push({ key: 'type', label: filters.type === 'chat' ? 'Chat' : 'Embedding' });
  }
  if (filters.vision) {
    chips.push({ key: 'vision', label: 'Vision' });
  }
  if (filters.reasoning) {
    chips.push({ key: 'reasoning', label: 'Reasoning' });
  }
  if (filters.context !== 'any') {
    chips.push({ key: 'context', label: `Context ${CONTEXT_BAND_LABELS[filters.context]}` });
  }
  if (filters.providerIds.size > 0) {
    chips.push({ key: 'providers', label: describeProviders(filters.providerIds, providerNames) });
  }
  return chips;
}

export function clearCatalogFilter(filters: CatalogFilters, key: CatalogFilterKey): CatalogFilters {
  switch (key) {
    case 'context':
      return { ...filters, context: 'any' };
    case 'providers':
      return { ...filters, providerIds: new Set<string>() };
    case 'query':
      return { ...filters, query: '' };
    case 'reasoning':
      return { ...filters, reasoning: false };
    case 'status':
      return { ...filters, status: 'all' };
    case 'type':
      return { ...filters, type: 'all' };
    case 'vision':
      return { ...filters, vision: false };
    default: {
      const exhaustive: never = key;
      throw new Error(`Unknown catalog filter: ${String(exhaustive)}`);
    }
  }
}

/**
 * True when a query word hits the model id but not the display name: the row
 * then shows its id instead of its tagline (design §4, "id on demand").
 */
export function queryHitsIdOnly(row: Pick<CatalogRow, 'id' | 'name'>, query: string): boolean {
  const name = row.name.toLowerCase();
  const id = row.id.toLowerCase();
  return queryWords(query).some((word) => id.includes(word) && !name.includes(word));
}

export interface HighlightSegment {
  readonly match: boolean;
  /** Offset into the source text; unique per segment, so it doubles as a React key. */
  readonly start: number;
  readonly text: string;
}

export function highlightSegments(text: string, query: string): readonly HighlightSegment[] {
  const words = queryWords(query);
  if (words.length === 0 || text.length === 0) {
    return [{ match: false, start: 0, text }];
  }
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    let from = lower.indexOf(word);
    while (from !== -1) {
      marked.fill(true, from, from + word.length);
      from = lower.indexOf(word, from + 1);
    }
  }
  const segments: HighlightSegment[] = [];
  let start = 0;
  for (let index = 1; index <= text.length; index += 1) {
    if (index === text.length || marked[index] !== marked[start]) {
      segments.push({ match: marked[start] === true, start, text: text.slice(start, index) });
      start = index;
    }
  }
  return segments;
}
```

Create `packages/settings-ui/src/settings/models/catalog-sections.ts`:

```ts
import { isLocalModelProviderId } from '@brainstrike/app-state/models/local-model-utils';
import type { DbProvider } from '@brainstrike/app-state/stores/model-registry-store';
import {
  findProviderDefinition,
  type ProviderRuntime,
} from '@brainstrike/assistant-contract/provider-registry';
import { type CatalogFilters, isCatalogFilterActive, matchesCatalogFilters } from './catalog-filters';
import type { CatalogRow } from './catalog-projection';

/** Section id for models whose provider row is missing (kept visible, never dropped). */
export const UNKNOWN_PROVIDER_SECTION_ID = '__unknown-provider__';
export const UNKNOWN_PROVIDER_NAME = 'Unknown provider';

export type CatalogSortColumn = 'context' | 'maxOutput' | 'name' | 'price';

export interface CatalogSort {
  readonly column: CatalogSortColumn;
  readonly direction: 'asc' | 'desc';
}

export interface CatalogProviderStat {
  /** Enabled models of this provider, over ALL its rows (never filtered). */
  readonly enabledCount: number;
  readonly providerId: string;
  readonly providerName: string;
  readonly totalCount: number;
}

export interface CatalogSection extends CatalogProviderStat {
  /** Matching rows in display order: catalog order unless a column sort is active. */
  readonly rows: readonly CatalogRow[];
  readonly runtimeLabel: string | null;
}

export interface CatalogSummary {
  readonly enabledModels: number;
  readonly filtering: boolean;
  readonly matchingModels: number;
  readonly matchingProviders: number;
  readonly totalModels: number;
  readonly totalProviders: number;
}

export interface CatalogView {
  /** Every provider that has at least one model, in DB order, with unfiltered counts. */
  readonly providerStats: readonly CatalogProviderStat[];
  /** Providers with at least one matching row. */
  readonly sections: readonly CatalogSection[];
  readonly summary: CatalogSummary;
}

const RUNTIME_LABELS: Record<ProviderRuntime, string> = {
  browser: 'On device',
  gateway: 'Gateway',
  hosted: 'Hosted',
  local: 'Local server',
};

function resolveRuntimeLabel(providerId: string): string | null {
  const definition = findProviderDefinition(providerId);
  if (definition) {
    return RUNTIME_LABELS[definition.runtime];
  }
  // DB-only providers (`transformers`) are classified by the canonical local
  // classifier rather than guessed.
  return isLocalModelProviderId(providerId) ? 'On device' : null;
}

function sortValue(row: CatalogRow, column: CatalogSortColumn): number | string | null {
  switch (column) {
    case 'context':
      return row.contextWindow;
    case 'maxOutput':
      return row.maxOutputTokens;
    case 'name':
      return row.name;
    case 'price':
      return row.pricing?.inputPerMTok ?? null;
    default: {
      const exhaustive: never = column;
      throw new Error(`Unknown catalog sort column: ${String(exhaustive)}`);
    }
  }
}

function compareValues(left: number | string, right: number | string): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Caller-owned sort within ONE section (TreeGrid sorting contract): values are
 * read once per row, absent values sort last in BOTH directions, and ties keep
 * catalog order.
 */
export function sortCatalogRows(
  rows: readonly CatalogRow[],
  sort: CatalogSort | null
): readonly CatalogRow[] {
  if (!sort) {
    return rows;
  }
  const direction = sort.direction === 'asc' ? 1 : -1;
  const keyed = rows.map((row, index) => ({ index, row, value: sortValue(row, sort.column) }));
  keyed.sort((left, right) => {
    if (left.value === null || right.value === null) {
      if (left.value === right.value) {
        return left.index - right.index;
      }
      return left.value === null ? 1 : -1;
    }
    const order = compareValues(left.value, right.value) * direction;
    return order === 0 ? left.index - right.index : order;
  });
  return keyed.map((entry) => entry.row);
}

export function buildCatalogView({
  filters,
  providers,
  rows,
  sort,
}: {
  readonly filters: CatalogFilters;
  readonly providers: readonly DbProvider[];
  readonly rows: readonly CatalogRow[];
  readonly sort: CatalogSort | null;
}): CatalogView {
  const knownProviderIds = new Set(providers.map((provider) => provider.id));
  const rowsByProvider = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    const key = knownProviderIds.has(row.providerId) ? row.providerId : UNKNOWN_PROVIDER_SECTION_ID;
    const bucket = rowsByProvider.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      rowsByProvider.set(key, [row]);
    }
  }

  const orderedProviders = [
    ...providers.map((provider) => ({ id: provider.id, name: provider.name })),
    { id: UNKNOWN_PROVIDER_SECTION_ID, name: UNKNOWN_PROVIDER_NAME },
  ];
  const providerStats: CatalogProviderStat[] = [];
  const sections: CatalogSection[] = [];
  for (const provider of orderedProviders) {
    const providerRows = rowsByProvider.get(provider.id);
    if (!providerRows) {
      continue;
    }
    const stat: CatalogProviderStat = {
      enabledCount: providerRows.filter((row) => row.enabled).length,
      providerId: provider.id,
      providerName: provider.name,
      totalCount: providerRows.length,
    };
    providerStats.push(stat);
    const matching = providerRows.filter((row) => matchesCatalogFilters(row, filters));
    if (matching.length === 0) {
      continue;
    }
    sections.push({
      ...stat,
      rows: sortCatalogRows(matching, sort),
      runtimeLabel:
        provider.id === UNKNOWN_PROVIDER_SECTION_ID ? null : resolveRuntimeLabel(provider.id),
    });
  }

  return {
    providerStats,
    sections,
    summary: {
      enabledModels: rows.filter((row) => row.enabled).length,
      filtering: isCatalogFilterActive(filters),
      matchingModels: sections.reduce((total, section) => total + section.rows.length, 0),
      matchingProviders: sections.length,
      totalModels: rows.length,
      totalProviders: providerStats.length,
    },
  };
}
```

- [ ] **Step 4: Delete the dead filter module**

```bash
grep -rn "model-filters" packages apps --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '/dist/'
# expect: only packages/settings-ui/src/settings/models/__tests__/model-filters.test.ts
git rm packages/settings-ui/src/settings/models/model-filters.ts packages/settings-ui/src/settings/models/__tests__/model-filters.test.ts
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/catalog-projection.test.ts src/settings/models/__tests__/catalog-filters.test.ts src/settings/models/__tests__/catalog-sections.test.ts src/settings/models/__tests__/catalog-format.test.ts`

Expected: PASS for all four files.

- [ ] **Step 6: Mutation checks (each must turn a test RED; revert after each)**

1. In `matchesContext`, change `>=` to `>`. The `128k at 128000 → true` case must fail.
2. In `matchesCatalogFilters`, change `row.reasoning?.state === 'supported'` to `row.reasoning !== null`. The "never lets an unknown reasoning state" test must fail.
3. In `sortCatalogRows`, change `return left.value === null ? 1 : -1;` to `return left.value === null ? -1 : 1;`. The "absent last in BOTH directions" test must fail.
4. In `projectCatalogRow`, change `pricing: toPricing(definition)` to `pricing: toPricing(definition) ?? { cacheReadPerMTok: null, cacheWritePerMTok: null, inputPerMTok: 0, outputPerMTok: 0 }`. The "never 0" test must fail.

After reverting each mutation, re-run the Step 5 command and confirm PASS.

- [ ] **Step 7: Run the full lane and type-check**

Run:
- `pnpm --filter @brainstrike/settings-ui test`
- `node scripts/run-turbo-command.mjs -- run type-check --filter=@brainstrike/settings-ui`

Expected: all PASS. `model-list.tsx` is untouched and still compiles.

- [ ] **Step 8: Commit**

```bash
pnpm exec biome check --write packages/settings-ui/src/settings/models/catalog-*.ts packages/settings-ui/src/settings/models/__tests__/catalog-*.ts
git add packages/settings-ui/src/settings/models
git commit -m "feat(BST-1805): add the Model Catalog data layer

Projection (DbModel + static registry), composable filters, per-provider
sections with unfiltered counts and caller-owned sort. Removes the dead
model-filters module.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Section expansion rules — defaults, filter sessions, Expand/Collapse all

**Files:**
- Create: `packages/settings-ui/src/settings/models/catalog-expansion.ts`
- Create: `packages/settings-ui/src/settings/models/use-catalog-expansion.ts`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-expansion.test.ts`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/use-catalog-expansion.test.tsx`

**Interfaces:**
- Consumes: `CatalogProviderStat` from `./catalog-sections` (Task 2).
- Produces:
  - Types: `CatalogExpansionState { manual: ReadonlySet<string> | null; sessionCollapsed: ReadonlySet<string> | null }`.
  - Constant: `INITIAL_CATALOG_EXPANSION`.
  - Pure functions:
    - `defaultManualExpansion(stats): ReadonlySet<string>`
    - `reconcileCatalogExpansion(state, stats, filtering): CatalogExpansionState`
    - `resolveExpandedSections(state, visibleSectionIds, filtering): ReadonlySet<string>`
    - `toggleCatalogSection(state, providerId, filtering)`
    - `expandAllCatalogSections(state, sectionIds, filtering)`
    - `collapseAllCatalogSections(state, sectionIds, filtering)`
  - Hook: `useCatalogExpansion({ filtering, providerStats, visibleSectionIds }): CatalogExpansionController`, where the controller is `{ collapseAll(): void; expandAll(): void; expandedSectionIds: ReadonlySet<string>; toggleSection(providerId: string): void }`.

Rules (design §3.3):
- **Seeding:** the first time the catalog has providers, expand every provider with at least one enabled model. If none has one, expand the first provider.
- **Filtering:** while any filter is active, every visible (matching) section is expanded except those the user collapsed during THIS filter session.
- **Ending a session:** clearing the filters ends the session and restores the untouched manual set.
- **Expand all / Collapse all** act on whichever set currently drives expansion (resolved decision 7).
- **Persistence:** expansion is component state only.

- [ ] **Step 1: Write the failing tests**

Create `packages/settings-ui/src/settings/models/__tests__/catalog-expansion.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  type CatalogExpansionState,
  collapseAllCatalogSections,
  defaultManualExpansion,
  expandAllCatalogSections,
  INITIAL_CATALOG_EXPANSION,
  reconcileCatalogExpansion,
  resolveExpandedSections,
  toggleCatalogSection,
} from '../catalog-expansion';
import type { CatalogProviderStat } from '../catalog-sections';

function stat(providerId: string, enabledCount: number): CatalogProviderStat {
  return { enabledCount, providerId, providerName: providerId, totalCount: 5 };
}

const stats = [stat('openai', 3), stat('anthropic', 0), stat('openrouter', 1)];

describe('defaultManualExpansion', () => {
  it('expands every provider with an enabled model', () => {
    expect([...defaultManualExpansion(stats)]).toEqual(['openai', 'openrouter']);
  });
  it('expands the first provider when nothing is enabled anywhere', () => {
    expect([...defaultManualExpansion([stat('a', 0), stat('b', 0)])]).toEqual(['a']);
  });
  it('expands nothing for an empty catalog', () => {
    expect(defaultManualExpansion([]).size).toBe(0);
  });
});

describe('reconcileCatalogExpansion', () => {
  it('returns the SAME object when nothing changes, so a render-phase adjust converges', () => {
    const seeded = reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, stats, false);
    expect(reconcileCatalogExpansion(seeded, stats, false)).toBe(seeded);
    const inSession = reconcileCatalogExpansion(seeded, stats, true);
    expect(reconcileCatalogExpansion(inSession, stats, true)).toBe(inSession);
  });

  it('waits for providers before seeding, then seeds once', () => {
    expect(reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, [], false)).toBe(
      INITIAL_CATALOG_EXPANSION
    );
    const seeded = reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, stats, false);
    const collapsedByUser: CatalogExpansionState = { ...seeded, manual: new Set<string>() };
    expect(reconcileCatalogExpansion(collapsedByUser, stats, false)).toBe(collapsedByUser);
  });

  it('seeds from unfiltered stats even when the first render is already filtering', () => {
    const state = reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, stats, true);
    expect([...(state.manual ?? [])]).toEqual(['openai', 'openrouter']);
    expect(state.sessionCollapsed?.size).toBe(0);
  });
});

describe('filter sessions', () => {
  const seeded = reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, stats, false);

  it('expands every matching section while filtering', () => {
    const session = reconcileCatalogExpansion(seeded, stats, true);
    expect([...resolveExpandedSections(session, ['anthropic', 'openrouter'], true)]).toEqual([
      'anthropic',
      'openrouter',
    ]);
  });

  it('keeps a section collapsed for the rest of the session, then restores the manual set', () => {
    let state = reconcileCatalogExpansion(seeded, stats, true);
    state = toggleCatalogSection(state, 'anthropic', true);
    // A query change inside the same session: still collapsed.
    expect(resolveExpandedSections(state, ['anthropic', 'openai'], true).has('anthropic')).toBe(false);
    // Clearing the filters ends the session; the manual set was never touched.
    state = reconcileCatalogExpansion(state, stats, false);
    expect(state.sessionCollapsed).toBeNull();
    expect([...resolveExpandedSections(state, ['openai', 'anthropic', 'openrouter'], false)]).toEqual([
      'openai',
      'openrouter',
    ]);
    // A new session starts fresh.
    state = reconcileCatalogExpansion(state, stats, true);
    expect(resolveExpandedSections(state, ['anthropic'], true).has('anthropic')).toBe(true);
  });
});

describe('Expand all / Collapse all', () => {
  const seeded = reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, stats, false);
  const all = ['openai', 'anthropic', 'openrouter'];

  it('act on the manual set when not filtering', () => {
    const expanded = expandAllCatalogSections(seeded, all, false);
    expect([...resolveExpandedSections(expanded, all, false)]).toEqual(all);
    const collapsed = collapseAllCatalogSections(expanded, all, false);
    expect(resolveExpandedSections(collapsed, all, false).size).toBe(0);
  });

  it('act on the session while filtering and leave the manual set alone', () => {
    const session = reconcileCatalogExpansion(seeded, stats, true);
    const collapsed = collapseAllCatalogSections(session, ['anthropic'], true);
    expect(resolveExpandedSections(collapsed, ['anthropic'], true).size).toBe(0);
    expect(collapsed.manual).toBe(seeded.manual);
    const expanded = expandAllCatalogSections(collapsed, ['anthropic'], true);
    expect([...resolveExpandedSections(expanded, ['anthropic'], true)]).toEqual(['anthropic']);
  });

  it('toggles the manual set when not filtering', () => {
    const toggled = toggleCatalogSection(seeded, 'anthropic', false);
    expect(resolveExpandedSections(toggled, all, false).has('anthropic')).toBe(true);
    expect(
      resolveExpandedSections(toggleCatalogSection(toggled, 'anthropic', false), all, false).has(
        'anthropic'
      )
    ).toBe(false);
  });
});
```

Create `packages/settings-ui/src/settings/models/__tests__/use-catalog-expansion.test.tsx`:

```tsx
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CatalogProviderStat } from '../catalog-sections';
import { useCatalogExpansion } from '../use-catalog-expansion';

const stats: CatalogProviderStat[] = [
  { enabledCount: 1, providerId: 'openai', providerName: 'OpenAI', totalCount: 2 },
  { enabledCount: 0, providerId: 'anthropic', providerName: 'Anthropic', totalCount: 2 },
];

interface Props {
  readonly filtering: boolean;
  readonly providerStats: readonly CatalogProviderStat[];
  readonly visibleSectionIds: readonly string[];
}

describe('useCatalogExpansion', () => {
  it('seeds from enabled providers once data arrives, then follows filter sessions', () => {
    const { rerender, result } = renderHook((props: Props) => useCatalogExpansion(props), {
      initialProps: { filtering: false, providerStats: [], visibleSectionIds: [] },
    });
    expect(result.current.expandedSectionIds.size).toBe(0);

    rerender({ filtering: false, providerStats: stats, visibleSectionIds: ['openai', 'anthropic'] });
    expect([...result.current.expandedSectionIds]).toEqual(['openai']);

    rerender({ filtering: true, providerStats: stats, visibleSectionIds: ['anthropic'] });
    expect([...result.current.expandedSectionIds]).toEqual(['anthropic']);

    act(() => result.current.toggleSection('anthropic'));
    expect(result.current.expandedSectionIds.has('anthropic')).toBe(false);

    rerender({ filtering: false, providerStats: stats, visibleSectionIds: ['openai', 'anthropic'] });
    expect([...result.current.expandedSectionIds]).toEqual(['openai']);
  });

  it('expands and collapses every visible section', () => {
    const { result } = renderHook(() =>
      useCatalogExpansion({
        filtering: false,
        providerStats: stats,
        visibleSectionIds: ['openai', 'anthropic'],
      })
    );
    act(() => result.current.expandAll());
    expect([...result.current.expandedSectionIds]).toEqual(['openai', 'anthropic']);
    act(() => result.current.collapseAll());
    expect(result.current.expandedSectionIds.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/catalog-expansion.test.ts src/settings/models/__tests__/use-catalog-expansion.test.tsx`

Expected: FAIL, because `../catalog-expansion` and `../use-catalog-expansion` do not resolve.

- [ ] **Step 3: Implement**

Create `packages/settings-ui/src/settings/models/catalog-expansion.ts`:

```ts
import type { CatalogProviderStat } from './catalog-sections';

/**
 * Model Catalog section expansion (BST-1805 design §3.3). Component state only:
 * persisting it would need factory-reset wiring (platform-contracts.md).
 */
export interface CatalogExpansionState {
  /** The user's expansion set; `null` until seeded from the first non-empty catalog. */
  readonly manual: ReadonlySet<string> | null;
  /** Sections collapsed during the CURRENT filter session; `null` outside a session. */
  readonly sessionCollapsed: ReadonlySet<string> | null;
}

export const INITIAL_CATALOG_EXPANSION: CatalogExpansionState = {
  manual: null,
  sessionCollapsed: null,
};

const NO_SECTIONS: ReadonlySet<string> = new Set<string>();

export function defaultManualExpansion(
  stats: readonly Pick<CatalogProviderStat, 'enabledCount' | 'providerId'>[]
): ReadonlySet<string> {
  const withEnabled = stats.filter((stat) => stat.enabledCount > 0).map((stat) => stat.providerId);
  if (withEnabled.length > 0) {
    return new Set(withEnabled);
  }
  const first = stats[0];
  return first ? new Set([first.providerId]) : NO_SECTIONS;
}

/**
 * Seeds the manual set once and opens/closes filter sessions. Returns the SAME
 * object when nothing changes, which is what lets `useCatalogExpansion` adjust
 * state during render and converge.
 */
export function reconcileCatalogExpansion(
  state: CatalogExpansionState,
  stats: readonly Pick<CatalogProviderStat, 'enabledCount' | 'providerId'>[],
  filtering: boolean
): CatalogExpansionState {
  const needsSeed = state.manual === null && stats.length > 0;
  const needsSessionStart = filtering && state.sessionCollapsed === null;
  const needsSessionEnd = !filtering && state.sessionCollapsed !== null;
  if (!(needsSeed || needsSessionStart || needsSessionEnd)) {
    return state;
  }
  let sessionCollapsed: ReadonlySet<string> | null = null;
  if (filtering) {
    sessionCollapsed = state.sessionCollapsed ?? new Set<string>();
  }
  return {
    manual: needsSeed ? defaultManualExpansion(stats) : state.manual,
    sessionCollapsed,
  };
}

export function resolveExpandedSections(
  state: CatalogExpansionState,
  visibleSectionIds: readonly string[],
  filtering: boolean
): ReadonlySet<string> {
  if (!filtering) {
    return state.manual ?? NO_SECTIONS;
  }
  const collapsed = state.sessionCollapsed ?? NO_SECTIONS;
  return new Set(visibleSectionIds.filter((id) => !collapsed.has(id)));
}

function withToggled(set: ReadonlySet<string> | null, id: string): ReadonlySet<string> {
  const next = new Set(set ?? NO_SECTIONS);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function toggleCatalogSection(
  state: CatalogExpansionState,
  providerId: string,
  filtering: boolean
): CatalogExpansionState {
  return filtering
    ? { ...state, sessionCollapsed: withToggled(state.sessionCollapsed, providerId) }
    : { ...state, manual: withToggled(state.manual, providerId) };
}

export function expandAllCatalogSections(
  state: CatalogExpansionState,
  sectionIds: readonly string[],
  filtering: boolean
): CatalogExpansionState {
  return filtering
    ? { ...state, sessionCollapsed: new Set<string>() }
    : { ...state, manual: new Set(sectionIds) };
}

export function collapseAllCatalogSections(
  state: CatalogExpansionState,
  sectionIds: readonly string[],
  filtering: boolean
): CatalogExpansionState {
  return filtering
    ? { ...state, sessionCollapsed: new Set(sectionIds) }
    : { ...state, manual: new Set<string>() };
}
```

Create `packages/settings-ui/src/settings/models/use-catalog-expansion.ts`:

```ts
import { useCallback, useState } from 'react';
import {
  type CatalogExpansionState,
  collapseAllCatalogSections,
  expandAllCatalogSections,
  INITIAL_CATALOG_EXPANSION,
  reconcileCatalogExpansion,
  resolveExpandedSections,
  toggleCatalogSection,
} from './catalog-expansion';
import type { CatalogProviderStat } from './catalog-sections';

export interface CatalogExpansionController {
  readonly collapseAll: () => void;
  readonly expandAll: () => void;
  readonly expandedSectionIds: ReadonlySet<string>;
  readonly toggleSection: (providerId: string) => void;
}

export function useCatalogExpansion({
  filtering,
  providerStats,
  visibleSectionIds,
}: {
  readonly filtering: boolean;
  readonly providerStats: readonly CatalogProviderStat[];
  readonly visibleSectionIds: readonly string[];
}): CatalogExpansionController {
  const [stored, setStored] = useState<CatalogExpansionState>(INITIAL_CATALOG_EXPANSION);
  // Derived state adjusted DURING RENDER — React's sanctioned alternative to a
  // syncing effect (react-hooks/set-state-in-effect). `reconcile` returns the
  // same object once settled, so this converges in one extra render.
  const state = reconcileCatalogExpansion(stored, providerStats, filtering);
  if (state !== stored) {
    setStored(state);
  }

  const toggleSection = useCallback(
    (providerId: string): void => {
      setStored((previous) => toggleCatalogSection(previous, providerId, filtering));
    },
    [filtering]
  );
  const expandAll = useCallback((): void => {
    setStored((previous) => expandAllCatalogSections(previous, visibleSectionIds, filtering));
  }, [filtering, visibleSectionIds]);
  const collapseAll = useCallback((): void => {
    setStored((previous) => collapseAllCatalogSections(previous, visibleSectionIds, filtering));
  }, [filtering, visibleSectionIds]);

  return {
    collapseAll,
    expandAll,
    expandedSectionIds: resolveExpandedSections(state, visibleSectionIds, filtering),
    toggleSection,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/catalog-expansion.test.ts src/settings/models/__tests__/use-catalog-expansion.test.tsx`

Expected: PASS.

- [ ] **Step 5: Mutation checks (revert after each)**

1. In `defaultManualExpansion`, change `stat.enabledCount > 0` to `stat.enabledCount >= 0`. "expands every provider with an enabled model" must fail.
2. In `reconcileCatalogExpansion`, delete the early `if (!(needsSeed || needsSessionStart || needsSessionEnd)) { return state; }`. The "returns the SAME object" test must fail, and the hook test fails with React's "Too many re-renders", which is exactly the loop the identity guarantee prevents.
3. In `resolveExpandedSections`, return `state.manual ?? NO_SECTIONS` unconditionally. "expands every matching section while filtering" must fail.

After reverting, re-run Step 4 and confirm PASS.

- [ ] **Step 6: Full lane**

Run:
- `pnpm --filter @brainstrike/settings-ui test`
- `node scripts/run-turbo-command.mjs -- run type-check --filter=@brainstrike/settings-ui`

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write packages/settings-ui/src/settings/models/catalog-expansion.ts packages/settings-ui/src/settings/models/use-catalog-expansion.ts packages/settings-ui/src/settings/models/__tests__/catalog-expansion.test.ts packages/settings-ui/src/settings/models/__tests__/use-catalog-expansion.test.tsx
git add packages/settings-ui/src/settings/models
git commit -m "feat(BST-1805): derive Model Catalog section expansion

Enabled providers open by default, filtering opens every match with a
per-session collapse set, and clearing restores the manual set.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Bulk enable/disable — one atomic store write, `toggleMany`, and Undo

**Files:**
- Modify: `packages/app-state/src/stores/model-registry-store.ts` (interface `ModelRegistryState` + store body)
- Modify: `packages/settings-ui/src/settings/models/use-model-toggle.ts` (full replacement below)
- Create: `packages/settings-ui/src/settings/models/use-model-bulk-toggle.tsx`
- Test (create): `packages/app-state/src/__tests__/model-registry-store-bulk.test.ts`
- Test (create): `packages/app-state/src/__tests__/model-registry-store-bulk.integration.test.ts`
- Test (modify): `packages/settings-ui/src/settings/models/__tests__/use-model-toggle.test.tsx`
- Test (modify): `packages/settings-ui/src/settings/models/__tests__/use-model-toggle-real-store.test.tsx`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/use-model-bulk-toggle.test.tsx`

**Interfaces:**
- Consumes: `pluralize`, `pluralNoun` from `./catalog-format` (Task 2).
- Produces:
  - Store: `setModelsEnabled(db: DbHandle, modelIds: readonly string[], enabled: boolean): Promise<ReadonlyMap<string, boolean>>`. It resolves with each id's PRIOR enabled state.
  - `use-model-toggle.ts`: `type ModelBulkToggleOutcome = { committed: false } | { committed: true; previous: ReadonlyMap<string, boolean> }`, and `ModelToggleController.toggleMany(modelIds: readonly string[], enabled: boolean): Promise<ModelBulkToggleOutcome>`, which never rejects.
  - `use-model-bulk-toggle.tsx`: `interface ModelBulkChange { enabled: boolean; modelIds: readonly string[]; scopeLabel: string }`, and `useModelBulkToggle(toggleMany): (change: ModelBulkChange) => Promise<boolean>`.

- [ ] **Step 1: Write the failing store tests**

Create `packages/app-state/src/__tests__/model-registry-store-bulk.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  useModelRegistryStore,
} from '../stores/model-registry-store';
import { __resetSettingsTestOverridesForTests } from '../testing/e2e-settings-test-overrides';

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

function model(id: string, isEnabled: boolean): DbModel {
  return {
    bestFor: null,
    capabilities: { type: 'llm' },
    description: null,
    icon: null,
    id,
    isEnabled,
    name: id,
    parameters: null,
    providerId: 'openai',
    sortOrder: 0,
    tagline: null,
  };
}

function enabledStates(): Record<string, boolean> {
  return Object.fromEntries(
    useModelRegistryStore.getState().models.map((entry) => [entry.id, entry.isEnabled])
  );
}

// The scheduled refresh never settles, so any restore we observe is the
// store's own synchronous rollback, not the refresh.
function neverSettles(): Promise<never> {
  return new Promise<never>(() => {
    // intentionally pending
  });
}

describe('model-registry-store setModelsEnabled (BST-1805)', () => {
  beforeEach(() => {
    __resetModelRegistryStoreForTests();
    __resetSettingsTestOverridesForTests();
    useModelRegistryStore.setState({ models: [model('a', false), model('b', true), model('c', false)] });
  });

  it('writes every id in ONE atomic statement and resolves with the prior states', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'a' }, { id: 'b' }] });
    const previous = await useModelRegistryStore
      .getState()
      .setModelsEnabled({ query } as never, ['a', 'b'], true);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain('WHERE id = ANY($2)');
    expect(sql).toContain('(SELECT count(*) FROM models WHERE id = ANY($2)) = $3');
    expect(params).toEqual([true, ['a', 'b'], 2]);
    expect([...previous]).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(enabledStates()).toEqual({ a: true, b: true, c: false });
  });

  it('restores the exact prior per-id states synchronously when the write rejects', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockReturnValueOnce(neverSettles());
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ query } as never, ['a', 'b', 'c'], true)
    ).rejects.toThrow('disk full');
    expect(enabledStates()).toEqual({ a: false, b: true, c: false });
  });

  it('treats a short RETURNING set as a failure and restores', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockReturnValueOnce(neverSettles());
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ query } as never, ['a', 'c'], true)
    ).rejects.toThrow('nothing was changed');
    expect(enabledStates()).toEqual({ a: false, b: true, c: false });
  });

  it('refuses ids the loaded registry does not hold, without writing', async () => {
    const query = vi.fn();
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ query } as never, ['a', 'zzz'], true)
    ).rejects.toThrow('zzz');
    expect(query).not.toHaveBeenCalled();
    expect(enabledStates()).toEqual({ a: false, b: true, c: false });
  });

  it('refuses an empty id list without writing', async () => {
    const query = vi.fn();
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ query } as never, [], true)
    ).rejects.toThrow('at least one model');
    expect(query).not.toHaveBeenCalled();
  });

  it('dedupes repeated ids', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'a' }] });
    await useModelRegistryStore.getState().setModelsEnabled({ query } as never, ['a', 'a'], true);
    expect(query.mock.calls[0]?.[1]).toEqual([true, ['a'], 1]);
  });

  it('schedules a registry refresh after a failure', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ query } as never, ['a'], true)
    ).rejects.toThrow('disk full');
    await vi.waitFor(() => {
      expect(useModelRegistryStore.getState().hasLoaded).toBe(true);
    });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
```

Create `packages/app-state/src/__tests__/model-registry-store-bulk.integration.test.ts`:

```ts
// @vitest-environment node
/**
 * BST-1805: `setModelsEnabled` against a REAL PGlite database built with the
 * production entry points (`createEnginePglite` + `migrate`), proving the one
 * atomic statement — `id = ANY($2)` plus the count guard — on the real schema.
 * The mocked suite (model-registry-store-bulk.test.ts) cannot prove the SQL.
 */
import { migrate } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { DbHandle } from '@brainstrike/db/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  useModelRegistryStore,
} from '../stores/model-registry-store';

type EnginePglite = Awaited<ReturnType<typeof createEnginePglite>>;

interface ModelRow {
  readonly id: string;
  readonly is_enabled: boolean;
  readonly name: string;
  readonly provider_id: string;
  readonly sort_order: number;
  readonly touched: boolean;
}

// Both ship `is_enabled = false` and untouched (pinned by the BST-1794
// integration suite, model-registry-store.integration.test.ts).
const TARGET_IDS = ['claude-opus-5', 'gpt-6-astra'] as const;

async function readRows(db: EnginePglite, ids: readonly string[]): Promise<ModelRow[]> {
  const result = await db.query<ModelRow>(
    `SELECT id, name, provider_id, sort_order, is_enabled, updated_at > created_at AS touched
     FROM models WHERE id = ANY($1) ORDER BY id`,
    [ids]
  );
  return result.rows;
}

function toStoreModel(row: ModelRow): DbModel {
  return {
    bestFor: null,
    capabilities: { type: 'llm' },
    description: null,
    icon: null,
    id: row.id,
    isEnabled: row.is_enabled,
    name: row.name,
    parameters: null,
    providerId: row.provider_id,
    sortOrder: row.sort_order,
    tagline: null,
  };
}

describe('setModelsEnabled against a real PGlite database (BST-1805)', () => {
  let db: EnginePglite;

  beforeEach(async () => {
    db = await createEnginePglite();
    await migrate(db);
    __resetModelRegistryStoreForTests();
  });

  afterEach(async () => {
    // A failure schedules fetchRegistry; let it settle before closing the database.
    await vi.waitFor(() => {
      expect(useModelRegistryStore.getState().isLoading).toBe(false);
    });
    await db.close();
  });

  it('enables every id in one statement, marks the choice, and returns the prior states', async () => {
    const before = await readRows(db, TARGET_IDS);
    expect(before.map((row) => row.is_enabled)).toEqual([false, false]);
    useModelRegistryStore.setState({ models: before.map(toStoreModel) });

    const previous = await useModelRegistryStore
      .getState()
      .setModelsEnabled(db as unknown as DbHandle, TARGET_IDS, true);

    expect(Object.fromEntries(previous)).toEqual({ 'claude-opus-5': false, 'gpt-6-astra': false });
    for (const row of await readRows(db, TARGET_IDS)) {
      expect(row.is_enabled, row.id).toBe(true);
      expect(row.touched, row.id).toBe(true);
    }
  });

  it('writes NOTHING when one id is missing from the database, and restores the store', async () => {
    const [opus] = await readRows(db, ['claude-opus-5']);
    if (!opus) {
      throw new Error('expected migrations to seed claude-opus-5');
    }
    useModelRegistryStore.setState({
      models: [toStoreModel(opus), { ...toStoreModel(opus), id: 'not-in-the-database' }],
    });

    await expect(
      useModelRegistryStore
        .getState()
        .setModelsEnabled(db as unknown as DbHandle, ['claude-opus-5', 'not-in-the-database'], true)
    ).rejects.toThrow('nothing was changed');

    const [after] = await readRows(db, ['claude-opus-5']);
    expect(after?.is_enabled).toBe(false);
    expect(after?.touched).toBe(false);
    expect(
      useModelRegistryStore.getState().models.find((entry) => entry.id === 'claude-opus-5')?.isEnabled
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the store tests to verify they fail**

Run:
- `pnpm --filter @brainstrike/app-state exec vitest run src/__tests__/model-registry-store-bulk.test.ts`
- `pnpm --filter @brainstrike/app-state exec vitest run --config vitest.integration.config.mts src/__tests__/model-registry-store-bulk.integration.test.ts`

Expected: FAIL with `setModelsEnabled is not a function`.

- [ ] **Step 3: Implement `setModelsEnabled`**

In `packages/app-state/src/stores/model-registry-store.ts`, add this member to `interface ModelRegistryState`, directly after `setModelCacheDir: (dir: string) => void;`:

```ts
  /**
   * Enables or disables many models in ONE atomic statement (BST-1805) and
   * resolves with each id's PRIOR enabled state, for Undo. Rejects — after
   * restoring those exact states and scheduling a registry refresh — when the
   * write fails, when an id is not in the loaded registry, or when any id is
   * missing from the database (in which case nothing is written).
   */
  setModelsEnabled: (
    db: DbHandle,
    modelIds: readonly string[],
    enabled: boolean
  ) => Promise<ReadonlyMap<string, boolean>>;
```

In the store body, add this property directly after the `setModelCacheDir: (dir: string) => { … },` property:

```ts
      setModelsEnabled: async (db: DbHandle, modelIds: readonly string[], enabled: boolean) => {
        const uniqueIds = Array.from(new Set(modelIds));
        if (uniqueIds.length === 0) {
          throw new Error('Choose at least one model to update.');
        }
        const modelsById = new Map(get().models.map((model) => [model.id, model]));
        const previous = new Map<string, boolean>();
        const unknownIds: string[] = [];
        for (const id of uniqueIds) {
          const model = modelsById.get(id);
          if (model) {
            previous.set(id, model.isEnabled);
          } else {
            unknownIds.push(id);
          }
        }
        if (unknownIds.length > 0) {
          throw new Error(`These models are not in the loaded registry: ${unknownIds.join(', ')}`);
        }

        const applyStates = (resolve: (id: string) => boolean): void => {
          set((state) => ({
            models: state.models.map((model) =>
              previous.has(model.id) ? { ...model, isEnabled: resolve(model.id) } : model
            ),
          }));
        };

        // Optimistic update.
        applyStates(() => enabled);
        try {
          // ONE statement for every id. The count guard makes it all-or-nothing:
          // if any id is missing from the table, no row is updated, so a short
          // RETURNING set can never be a partial write.
          const result = await db.query<{ id: string }>(
            `UPDATE models SET is_enabled = $1, updated_at = NOW()
             WHERE id = ANY($2)
               AND (SELECT count(*) FROM models WHERE id = ANY($2)) = $3
             RETURNING id`,
            [enabled, uniqueIds, uniqueIds.length]
          );
          if (result.rows.length !== uniqueIds.length) {
            throw new Error(
              'Some of these models are missing from the database, so nothing was changed.'
            );
          }
          await syncDurableDatabaseWrites(db);
          return previous;
        } catch (error) {
          logger.error('Failed to update models', error);
          applyStates((id) => previous.get(id) === true);
          void get().fetchRegistry(db);
          throw error;
        }
      },
```

- [ ] **Step 4: Run the store tests to verify they pass**

Run the two Step 2 commands again. Expected: PASS for both files.

- [ ] **Step 5: Store mutation checks (revert after each)**

1. Delete `applyStates((id) => previous.get(id) === true);` from the `catch`. The "restores the exact prior per-id states" and "short RETURNING" unit tests must fail.
2. Delete the line `AND (SELECT count(*) FROM models WHERE id = ANY($2)) = $3` and change the params to `[enabled, uniqueIds]`. The integration test "writes NOTHING when one id is missing" must fail, because `claude-opus-5` is enabled.

After reverting both, re-run the Step 2 commands and confirm PASS.

- [ ] **Step 6: Write the failing hook tests**

In `packages/settings-ui/src/settings/models/__tests__/use-model-toggle.test.tsx`, replace the store mock block

```ts
vi.mock('@brainstrike/app-state/stores/model-registry-store', () => ({
  useModelRegistryStore: (selector: (state: { toggleModel: typeof toggleModel }) => unknown) =>
    selector({ toggleModel }),
}));

import { useModelToggle } from '../use-model-toggle';
```

with

```ts
const setModelsEnabled =
  vi.fn<(db: unknown, ids: readonly string[], enabled: boolean) => Promise<ReadonlyMap<string, boolean>>>();

vi.mock('@brainstrike/app-state/stores/model-registry-store', () => ({
  useModelRegistryStore: (
    selector: (state: {
      setModelsEnabled: typeof setModelsEnabled;
      toggleModel: typeof toggleModel;
    }) => unknown
  ) => selector({ setModelsEnabled, toggleModel }),
}));

import { type ModelBulkToggleOutcome, useModelToggle } from '../use-model-toggle';
```

In its `beforeEach`, add `setModelsEnabled.mockReset();`. Then append at the end of the file:

```ts
describe('useModelToggle.toggleMany (BST-1805)', () => {
  beforeEach(() => {
    toast.mockClear();
    setModelsEnabled.mockReset();
    db = { query: vi.fn() };
  });

  it('resolves committed with the prior states once the single write commits', async () => {
    const previous = new Map([
      ['a', false],
      ['b', true],
    ]);
    setModelsEnabled.mockResolvedValue(previous);
    const { result } = renderHook(() => useModelToggle());
    let outcome: ModelBulkToggleOutcome | undefined;
    await act(async () => {
      outcome = await result.current.toggleMany(['a', 'b'], true);
    });
    expect(outcome).toEqual({ committed: true, previous });
    expect(setModelsEnabled).toHaveBeenCalledTimes(1);
    expect(setModelsEnabled).toHaveBeenCalledWith(db, ['a', 'b'], true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('resolves uncommitted and toasts when the write is rejected', async () => {
    setModelsEnabled.mockRejectedValue(new Error('disk full'));
    const { result } = renderHook(() => useModelToggle());
    let outcome: ModelBulkToggleOutcome | undefined;
    await act(async () => {
      outcome = await result.current.toggleMany(['a', 'b'], false);
    });
    expect(outcome).toEqual({ committed: false });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'disk full',
        title: 'Could not disable 2 models',
        variant: 'destructive',
      })
    );
  });

  it('refuses without writing when the database is not ready', async () => {
    db = null;
    const { result } = renderHook(() => useModelToggle());
    let outcome: ModelBulkToggleOutcome | undefined;
    await act(async () => {
      outcome = await result.current.toggleMany(['a'], true);
    });
    expect(outcome).toEqual({ committed: false });
    expect(setModelsEnabled).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });

  it('marks every id busy while the write is in flight and releases them after', async () => {
    let finish: (value: ReadonlyMap<string, boolean>) => void = () => undefined;
    setModelsEnabled.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const { result } = renderHook(() => useModelToggle());
    let pending: Promise<ModelBulkToggleOutcome> | undefined;
    act(() => {
      pending = result.current.toggleMany(['a', 'b'], true);
    });
    expect([...result.current.busyModelIds].sort()).toEqual(['a', 'b']);
    await act(async () => {
      finish(new Map());
      await pending;
    });
    expect(result.current.busyModelIds.size).toBe(0);
  });
});
```

In `packages/settings-ui/src/settings/models/__tests__/use-model-toggle-real-store.test.tsx`, change `import { useModelToggle } from '../use-model-toggle';` to `import { type ModelBulkToggleOutcome, useModelToggle } from '../use-model-toggle';`. Then add this test inside the existing `describe`, after the existing `it`:

```ts
  it('toggleMany resolves uncommitted, toasts, and leaves the store restored when the write rejects', async () => {
    const { result } = renderHook(() => useModelToggle());

    let outcome: ModelBulkToggleOutcome | undefined;
    await act(async () => {
      outcome = await result.current.toggleMany(['claude-opus-5'], true);
    });

    expect(outcome).toEqual({ committed: false });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'disk full',
        title: 'Could not enable this model',
        variant: 'destructive',
      })
    );
    expect(useModelRegistryStore.getState().models[0]?.isEnabled).toBe(false);
    expect(result.current.busyModelIds.has('claude-opus-5')).toBe(false);
  });
```

Create `packages/settings-ui/src/settings/models/__tests__/use-model-bulk-toggle.test.tsx`:

```tsx
import { act, renderHook } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelBulkToggleOutcome } from '../use-model-toggle';

const toast = vi.fn();

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ toast }),
}));

import { useModelBulkToggle } from '../use-model-bulk-toggle';

const toggleMany =
  vi.fn<(modelIds: readonly string[], enabled: boolean) => Promise<ModelBulkToggleOutcome>>();

function undoActionOf(callIndex: number): () => void {
  const options = toast.mock.calls[callIndex]?.[0] as
    | { action?: ReactElement<{ onClick?: () => void }> }
    | undefined;
  const onClick = options?.action?.props.onClick;
  if (!onClick) {
    throw new Error(`toast #${callIndex} carries no Undo action`);
  }
  return onClick;
}

describe('useModelBulkToggle', () => {
  beforeEach(() => {
    toast.mockReset();
    toggleMany.mockReset();
  });

  it('writes once and offers Undo on success', async () => {
    toggleMany.mockResolvedValue({
      committed: true,
      previous: new Map([
        ['a', true],
        ['b', true],
      ]),
    });
    const { result } = renderHook(() => useModelBulkToggle(toggleMany));
    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current({ enabled: false, modelIds: ['a', 'b'], scopeLabel: 'OpenRouter' });
    });
    expect(applied).toBe(true);
    expect(toggleMany).toHaveBeenCalledTimes(1);
    expect(toggleMany).toHaveBeenCalledWith(['a', 'b'], false);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Disabled 2 OpenRouter models' })
    );
    expect(undoActionOf(0)).toBeTypeOf('function');
  });

  it('shows no success toast when the write is not committed', async () => {
    toggleMany.mockResolvedValue({ committed: false });
    const { result } = renderHook(() => useModelBulkToggle(toggleMany));
    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current({ enabled: true, modelIds: ['a'], scopeLabel: 'OpenAI' });
    });
    expect(applied).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('Undo restores mixed prior states in at most two writes', async () => {
    toggleMany.mockResolvedValueOnce({
      committed: true,
      previous: new Map([
        ['a', true],
        ['b', false],
        ['c', true],
      ]),
    });
    const { result } = renderHook(() => useModelBulkToggle(toggleMany));
    await act(async () => {
      await result.current({ enabled: true, modelIds: ['a', 'b', 'c'], scopeLabel: 'Anthropic' });
    });
    toggleMany.mockResolvedValue({ committed: true, previous: new Map() });

    act(() => undoActionOf(0)());

    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledTimes(2);
    });
    expect(toggleMany).toHaveBeenCalledTimes(3);
    expect(toggleMany).toHaveBeenNthCalledWith(2, ['a', 'c'], true);
    expect(toggleMany).toHaveBeenNthCalledWith(3, ['b'], false);
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Restored 3 models' }));
  });

  it('does not claim a restore when an Undo write fails', async () => {
    toggleMany.mockResolvedValueOnce({ committed: true, previous: new Map([['a', true]]) });
    const { result } = renderHook(() => useModelBulkToggle(toggleMany));
    await act(async () => {
      await result.current({ enabled: false, modelIds: ['a'], scopeLabel: 'OpenAI' });
    });
    toggleMany.mockResolvedValue({ committed: false });

    act(() => undoActionOf(0)());

    await vi.waitFor(() => {
      expect(toggleMany).toHaveBeenCalledTimes(2);
    });
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 7: Run the hook tests to verify they fail**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/use-model-toggle.test.tsx src/settings/models/__tests__/use-model-toggle-real-store.test.tsx src/settings/models/__tests__/use-model-bulk-toggle.test.tsx`

Expected: FAIL. `toggleMany` is not a function, and `../use-model-bulk-toggle` does not resolve.

- [ ] **Step 8: Implement the hooks**

Replace `packages/settings-ui/src/settings/models/use-model-toggle.ts` with:

```ts
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useToast } from '@brainstrike/ui';
import { useCallback, useState } from 'react';

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const DATABASE_NOT_READY = 'The model database is not ready yet. Try again in a moment.';

/** A bulk write's result. `previous` holds each id's enabled state before the write, for Undo. */
export type ModelBulkToggleOutcome =
  | { readonly committed: false }
  | { readonly committed: true; readonly previous: ReadonlyMap<string, boolean> };

export interface ModelToggleController {
  /** Model ids with a write in flight; their switches disable. */
  readonly busyModelIds: ReadonlySet<string>;
  /**
   * Resolves `true` once the write commits and `false` after a destructive
   * toast. It never rejects, so a caller can act on success without a second
   * error path.
   */
  readonly toggle: (modelId: string, enabled: boolean) => Promise<boolean>;
  /**
   * One database write for many models (BST-1805), with `toggle`'s contract:
   * every id is busy while the write is in flight, a failure raises a
   * destructive toast, and the promise never rejects.
   */
  readonly toggleMany: (
    modelIds: readonly string[],
    enabled: boolean
  ) => Promise<ModelBulkToggleOutcome>;
}

function describeModels(count: number): string {
  return count === 1 ? 'this model' : `${count} models`;
}

function errorDescription(error: unknown): string {
  return error instanceof Error ? error.message : 'The change was not saved.';
}

/**
 * Enabling/disabling catalogued models, shared by the Provider Hub cards and
 * the Model Catalog so the two surfaces cannot drift in how a write is
 * attempted, reported, or refused (BST-1358 review).
 *
 * NO SILENT FALLBACKS on either arm:
 *
 * - A missing database is surfaced, not ignored. Both surfaces previously
 *   returned early when `db` was null, so the switch snapped back with no
 *   explanation.
 * - A rejected write is surfaced too. Both surfaces previously dropped the
 *   rejection, leaving the UI showing a state the database never accepted.
 */
export function useModelToggle(): ModelToggleController {
  const db = usePGliteDatabase();
  const toggleModel = useModelRegistryStore((state) => state.toggleModel);
  const setModelsEnabled = useModelRegistryStore((state) => state.setModelsEnabled);
  const { toast } = useToast();
  const [busyModelIds, setBusyModelIds] = useState<ReadonlySet<string>>(EMPTY_IDS);

  const markBusy = useCallback((modelIds: readonly string[], busy: boolean): void => {
    setBusyModelIds((current) => {
      const next = new Set(current);
      for (const id of modelIds) {
        if (busy) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }
      return next;
    });
  }, []);

  const toggle = useCallback(
    async (modelId: string, enabled: boolean): Promise<boolean> => {
      if (!db) {
        toast({
          description: DATABASE_NOT_READY,
          title: 'Could not update model',
          variant: 'destructive',
        });
        return false;
      }
      markBusy([modelId], true);
      try {
        await toggleModel(db, modelId, enabled);
        return true;
      } catch (error: unknown) {
        toast({
          description: errorDescription(error),
          title: `Could not ${enabled ? 'enable' : 'disable'} this model`,
          variant: 'destructive',
        });
        return false;
      } finally {
        markBusy([modelId], false);
      }
    },
    [db, markBusy, toast, toggleModel]
  );

  const toggleMany = useCallback(
    async (modelIds: readonly string[], enabled: boolean): Promise<ModelBulkToggleOutcome> => {
      if (!db) {
        toast({
          description: DATABASE_NOT_READY,
          title: 'Could not update models',
          variant: 'destructive',
        });
        return { committed: false };
      }
      markBusy(modelIds, true);
      try {
        const previous = await setModelsEnabled(db, modelIds, enabled);
        return { committed: true, previous };
      } catch (error: unknown) {
        toast({
          description: errorDescription(error),
          title: `Could not ${enabled ? 'enable' : 'disable'} ${describeModels(modelIds.length)}`,
          variant: 'destructive',
        });
        return { committed: false };
      } finally {
        markBusy(modelIds, false);
      }
    },
    [db, markBusy, setModelsEnabled, toast]
  );

  return { busyModelIds, toggle, toggleMany };
}
```

Create `packages/settings-ui/src/settings/models/use-model-bulk-toggle.tsx`:

```tsx
import { ToastAction, useToast } from '@brainstrike/ui';
import { useCallback } from 'react';
import { pluralize, pluralNoun } from './catalog-format';
import type { ModelToggleController } from './use-model-toggle';

export interface ModelBulkChange {
  readonly enabled: boolean;
  /** Only the ids whose state actually changes (the caller filters). */
  readonly modelIds: readonly string[];
  /** Who the change is about: "OpenRouter" → "Disabled 59 OpenRouter models". */
  readonly scopeLabel: string;
}

function groupByPreviousState(previous: ReadonlyMap<string, boolean>): {
  readonly disable: string[];
  readonly enable: string[];
} {
  const enable: string[] = [];
  const disable: string[] = [];
  for (const [id, wasEnabled] of previous) {
    if (wasEnabled) {
      enable.push(id);
    } else {
      disable.push(id);
    }
  }
  return { disable, enable };
}

/**
 * Bulk enable/disable with Undo (BST-1805 design §6). The write goes through
 * `toggleMany` (one DB statement). On success an Undo toast restores each
 * model's exact prior state in at most two writes. Failures are reported by
 * `toggleMany`'s own destructive toast, so this never adds a second one.
 */
export function useModelBulkToggle(
  toggleMany: ModelToggleController['toggleMany']
): (change: ModelBulkChange) => Promise<boolean> {
  const { toast } = useToast();

  const undo = useCallback(
    async (previous: ReadonlyMap<string, boolean>): Promise<void> => {
      const { disable, enable } = groupByPreviousState(previous);
      const reEnabled = enable.length > 0 ? await toggleMany(enable, true) : null;
      const reDisabled = disable.length > 0 ? await toggleMany(disable, false) : null;
      if (reEnabled?.committed === false || reDisabled?.committed === false) {
        return;
      }
      toast({ title: `Restored ${pluralize(previous.size, 'model')}` });
    },
    [toast, toggleMany]
  );

  return useCallback(
    async ({ enabled, modelIds, scopeLabel }: ModelBulkChange): Promise<boolean> => {
      const outcome = await toggleMany(modelIds, enabled);
      if (!outcome.committed) {
        return false;
      }
      const { previous } = outcome;
      toast({
        action: (
          <ToastAction
            altText={`Undo: restore ${pluralize(previous.size, 'model')}`}
            data-testid="model-bulk-undo"
            onClick={() => {
              void undo(previous);
            }}
          >
            Undo
          </ToastAction>
        ),
        title: `${enabled ? 'Enabled' : 'Disabled'} ${previous.size} ${scopeLabel} ${pluralNoun(previous.size, 'model')}`,
      });
      return true;
    },
    [toast, toggleMany, undo]
  );
}
```

- [ ] **Step 9: Run the hook tests to verify they pass**

Run the Step 7 command again. Expected: PASS for all three files.

- [ ] **Step 10: Hook mutation check (revert after)**

In `groupByPreviousState`, swap the pushes (`disable.push(id)` for enabled, `enable.push(id)` otherwise). "Undo restores mixed prior states" must fail. Revert it and confirm PASS.

- [ ] **Step 11: Full lanes and type-check**

Run:
- `pnpm --filter @brainstrike/app-state test`
- `pnpm --filter @brainstrike/app-state test:integration`
- `pnpm --filter @brainstrike/settings-ui test`
- `node scripts/run-turbo-command.mjs -- run type-check --filter=@brainstrike/app-state --filter=@brainstrike/settings-ui --filter=@brainstrike/app-shell`

The app-shell filter matters because its hooks consume `useModelToggle`. Expected: all PASS.

- [ ] **Step 12: Commit**

```bash
pnpm exec biome check --write packages/app-state/src/stores/model-registry-store.ts packages/app-state/src/__tests__/model-registry-store-bulk.test.ts packages/app-state/src/__tests__/model-registry-store-bulk.integration.test.ts packages/settings-ui/src/settings/models/use-model-toggle.ts packages/settings-ui/src/settings/models/use-model-bulk-toggle.tsx packages/settings-ui/src/settings/models/__tests__/use-model-toggle.test.tsx packages/settings-ui/src/settings/models/__tests__/use-model-toggle-real-store.test.tsx packages/settings-ui/src/settings/models/__tests__/use-model-bulk-toggle.test.tsx
git add packages/app-state packages/settings-ui/src/settings/models
git commit -m "feat(BST-1805): add one-write bulk model enable/disable with Undo

setModelsEnabled updates every id in one all-or-nothing statement,
restores exact prior states on failure, and returns them for Undo.
useModelToggle gains toggleMany; useModelBulkToggle adds the Undo toast.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Settings shell — opt-in `layout: 'workspace'` and `headerActions`

**Files:**
- Modify: `packages/settings-ui/src/settings-page-content.tsx` (the `SettingsCategory` interface, plus the `<section>` block at the end of `SettingsPageContent`)
- Test (modify): `packages/settings-ui/src/__tests__/settings-page-content.test.tsx`

**Interfaces:**
- Produces:
  - `export type SettingsCategoryLayout = 'document' | 'workspace'`
  - `SettingsCategory.layout?: SettingsCategoryLayout` (default `'document'`)
  - `SettingsCategory.headerActions?: ReactNode`
- DOM contract (used by Task 10's E2E): the category container keeps `data-testid="settings-category-<id>"` and gains `data-layout`. The header row is `data-testid="settings-category-header-<id>"`.

`document` keeps today's centred `mx-auto max-w-3xl` column, and the section scrolls. `workspace` drops the width cap, makes the category a full-height flex column, and turns the section into `overflow-hidden`, so the category owns its own scroll. That removes the double scrollbar.

- [ ] **Step 1: Write the failing tests**

In `packages/settings-ui/src/__tests__/settings-page-content.test.tsx`, add inside `describe('SettingsPageContent', () => { … })`, after the `'shows empty state when categories are missing'` test:

```tsx
  it('keeps the document layout by default', () => {
    render(<SettingsPageContent categories={[makeCategory('advanced', 'Advanced')]} />);

    const category = screen.getByTestId('settings-category-advanced');
    expect(category).toHaveAttribute('data-layout', 'document');
    expect(category.className).toContain('max-w-3xl');
    expect(category.closest('section')?.className).toContain('overflow-y-auto');
  });

  it('renders a workspace category full width and lets it own scrolling (BST-1805)', () => {
    const workspace: SettingsCategory = {
      ...makeCategory('models', 'Model Catalog'),
      layout: 'workspace',
    };
    render(<SettingsPageContent categories={[workspace]} />);

    const category = screen.getByTestId('settings-category-models');
    expect(category).toHaveAttribute('data-layout', 'workspace');
    expect(category.className).not.toContain('max-w-3xl');
    expect(category.className).toContain('flex-1');
    const section = category.closest('section');
    expect(section?.className).toContain('overflow-hidden');
    expect(section?.className).not.toContain('overflow-y-auto');
  });

  it('renders header actions beside the category title', () => {
    const withActions: SettingsCategory = {
      ...makeCategory('models', 'Model Catalog', 'Browse models'),
      headerActions: <button type="button">Refresh</button>,
    };
    render(<SettingsPageContent categories={[withActions]} />);

    const header = screen.getByTestId('settings-category-header-models');
    expect(within(header).getByRole('heading', { name: 'Model Catalog' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/__tests__/settings-page-content.test.tsx`

Expected: FAIL. There is no `data-layout` attribute, a type error on `layout`/`headerActions`, and no `settings-category-header-models` test id.

- [ ] **Step 3: Implement**

In `packages/settings-ui/src/settings-page-content.tsx`:

(a) Directly above `export interface SettingsCategory {`, add:

```ts
/**
 * `document` (default): a centred `max-w-3xl` column; the page scrolls.
 * `workspace`: full width and height; the category owns its own scrolling
 * (BST-1805 — the Model Catalog's single scroll owner).
 */
export type SettingsCategoryLayout = 'document' | 'workspace';
```

(b) Inside `interface SettingsCategory`, add these two members in sorted position: `headerActions` after `description`, and `layout` after `keywords`.

```ts
  /** Optional controls rendered at the right of the category title (e.g. Refresh). */
  headerActions?: ReactNode;
```

```ts
  /** How the category's content is laid out; defaults to `document`. */
  layout?: SettingsCategoryLayout;
```

(c) Replace the whole `<section …>…</section>` element at the end of the component's returned JSX with:

```tsx
      <section
        className={cn(
          'min-h-0 px-8 lg:px-10',
          activeCategory?.layout === 'workspace' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'
        )}
        style={{ paddingBlock: '2rem' }}
      >
        {filteredCategories.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Try adjusting your search to find settings.
          </div>
        ) : activeCategory ? (
          <div
            className={
              activeCategory.layout === 'workspace'
                ? 'flex min-h-0 w-full flex-1 flex-col gap-5'
                : 'mx-auto max-w-3xl space-y-7'
            }
            data-layout={activeCategory.layout ?? 'document'}
            data-testid={`settings-category-${activeCategory.id}`}
          >
            <div
              className="flex shrink-0 items-start justify-between gap-4 border-border/60 border-b pb-5"
              data-testid={`settings-category-header-${activeCategory.id}`}
            >
              <div className="min-w-0">
                <h2 className="font-semibold text-xl tracking-tight">{activeCategory.title}</h2>
                {activeCategory.description ? (
                  <p className="mt-1.5 max-w-2xl text-muted-foreground text-sm leading-relaxed">
                    {activeCategory.description}
                  </p>
                ) : null}
              </div>
              {activeCategory.headerActions ? (
                <div className="flex shrink-0 items-center gap-2">{activeCategory.headerActions}</div>
              ) : null}
            </div>
            <div
              className={
                activeCategory.layout === 'workspace' ? 'flex min-h-0 flex-1 flex-col' : 'space-y-6'
              }
            >
              {activeCategory.content}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Select a setting category to view its options.
          </div>
        )}
      </section>
```

`cn` is already imported from `@brainstrike/ui` at the top of the file. In the test, `@brainstrike/ui` is mocked with a `cn` that joins truthy strings, which works unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/__tests__/settings-page-content.test.tsx`

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Mutation check (revert after)**

Replace the `activeCategory.layout === 'workspace' ? … : 'mx-auto max-w-3xl space-y-7'` class expression with the literal `'mx-auto max-w-3xl space-y-7'`. The workspace test must fail. Revert it and confirm PASS.

- [ ] **Step 6: Full lane and type-check**

Run:
- `pnpm --filter @brainstrike/settings-ui test`
- `node scripts/run-turbo-command.mjs -- run type-check --filter=@brainstrike/settings-ui --filter=@brainstrike/web --filter=@brainstrike/desktop`

Expected: all PASS. No app uses `layout` yet.

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write packages/settings-ui/src/settings-page-content.tsx packages/settings-ui/src/__tests__/settings-page-content.test.tsx
git add packages/settings-ui/src/settings-page-content.tsx packages/settings-ui/src/__tests__/settings-page-content.test.tsx
git commit -m "feat(BST-1805): let a settings category opt into a full-size workspace layout

Adds SettingsCategory.layout ('document' | 'workspace') and headerActions.
Every existing category keeps the centred document layout.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: Catalog rows — nodes, cells, details row, width tiers, column header

**Files:**
- Create: `packages/settings-ui/src/settings/models/catalog-nodes.ts`
- Create: `packages/settings-ui/src/settings/models/use-catalog-row-actions.ts`
- Create: `packages/settings-ui/src/settings/models/catalog-model-details.tsx`
- Create: `packages/settings-ui/src/settings/models/catalog-columns.tsx`
- Create: `packages/settings-ui/src/settings/models/use-scrollbar-gutter-width.ts`
- Create: `packages/settings-ui/src/settings/models/catalog-column-header.tsx`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-dom-harness.ts`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-nodes.test.ts`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-columns.test.tsx`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-column-header.test.tsx`

**Interfaces:**
- Consumes:
  - `CatalogRow` (Task 2), `highlightSegments`, `queryHitsIdOnly` (Task 2), `formatUsd` (Task 2), `CatalogSort`, `CatalogSortColumn` (Task 2).
  - From `@brainstrike/ui`: `formatTokenCount` (Task 1), `TreeTable`, `TreeTableColumn`, `TreeTableCellProps`, `TreeNode`, `Switch`, `Badge`, `Button`, `CopyTextButton`, `useResizeObserver`, `getNextTreeTableSortDirection`, `getTreeTableAriaSortValue`, `getTreeTableSortButtonLabel`, `SortState`.
- Produces:
  - `catalog-nodes.ts`: `CatalogNodeData = { kind: 'detail' | 'model'; row: CatalogRow }` (a discriminated union), `CatalogRowNodes { detail; model }`, `createCatalogNodeCache(): (row: CatalogRow) => CatalogRowNodes`, `buildSectionNodes(rows, getNodes): TreeNode<CatalogNodeData>[]`.
  - `use-catalog-row-actions.ts`: `CatalogRowActions` (fields `busyModelIds`, `downloadedModels`, `downloadProgress`, `isDownloading`, `modelCacheDir`, `onDownload`, `onToggle`, `onToggleDetails`, `query`, `showTagline`, `showTypeTag`), `CatalogRowActionsContext`, `useCatalogRowActions()`.
  - `catalog-columns.tsx`: `CatalogWidthTier = 'medium' | 'narrow' | 'wide'`, `CatalogColumnId`, `CatalogColumnLayout`, `resolveCatalogWidthTier(width): CatalogWidthTier`, `getCatalogColumnLayout(tier)`, `getCatalogColumns(tier): TreeTableColumn<CatalogNodeData>[]`. The return value is identity-stable per tier.
  - `catalog-model-details.tsx`: `CatalogModelDetails({ row })`.
  - `use-scrollbar-gutter-width.ts`: `useScrollbarGutterWidth(scrollerRef): number`.
  - `catalog-column-header.tsx`: `CatalogColumnHeader({ layout, onSortChange, scrollerRef, sort })`.
  - Test harness: `createMockCatalogVirtualizer`, `installCatalogDomStubs({ width })`, `makeRowActions(overrides?)`.

Design notes:
- **Why a context for row state:** `busyModelIds`, download progress and the query change often, and cells read them. Putting them in `CatalogRowActionsContext` keeps the column definitions MODULE-LEVEL constants (identity-stable). If they lived in the column closures, every change would rebuild the columns and re-render every row (TreeGrid row-identity contract). Only rows that are actually mounted (windowed) consume the context.
- **Why no tree column:** every column sets `isTreeColumn: false`, so TreeTable renders no indentation or chevron. The row's own disclosure in the Actions column toggles the details child through `onToggleDetails`. The keyboard (→/←) goes through TreeTable's `onToggleExpand` on the same set (Task 7).
- **Row pitch:** each cell line is `h-[35px]`, and the collapsed 1px row border makes the pitch 36px. Task 10 measures that pitch. `rowHeight` stays a per-type estimate.

- [ ] **Step 1: Write the DOM harness**

Create `packages/settings-ui/src/settings/models/__tests__/catalog-dom-harness.ts`:

```ts
import { vi } from 'vitest';
import type { CatalogRowActions } from '../use-catalog-row-actions';

const MOCK_ROW_PITCH = 36;

/**
 * jsdom has no layout, so the real virtualizer renders nothing. This stand-in
 * renders every row (same approach as the log viewer's harness); the real
 * windowing is proven in the web E2E (Task 10).
 */
export function createMockCatalogVirtualizer({ count }: { readonly count: number }) {
  return {
    getTotalSize: () => count * MOCK_ROW_PITCH,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        end: (index + 1) * MOCK_ROW_PITCH,
        index,
        key: index,
        lane: 0,
        size: MOCK_ROW_PITCH,
        start: index * MOCK_ROW_PITCH,
      })),
    measure: () => undefined,
    measureElement: () => undefined,
    measurementsCache: [],
    scrollToIndex: () => undefined,
    scrollToOffset: () => undefined,
  };
}

/**
 * ResizeObserver stub. With a `width`, every observed element immediately
 * reports that content width — this is how tests mock the catalog container
 * width (design §11: "container width mocked"). With `null` it never reports.
 */
export function installCatalogDomStubs({ width }: { readonly width: number | null }): void {
  class StubResizeObserver {
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    disconnect(): void {
      // nothing is really observed
    }

    observe(target: Element): void {
      if (width === null) {
        return;
      }
      const entry = {
        borderBoxSize: [],
        contentBoxSize: [],
        contentRect: { bottom: 600, height: 600, left: 0, right: width, top: 0, width, x: 0, y: 0 },
        devicePixelContentBoxSize: [],
        target,
      } as unknown as ResizeObserverEntry;
      this.callback([entry], this as unknown as ResizeObserver);
    }

    unobserve(): void {
      // nothing is really observed
    }
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
}

export function makeRowActions(overrides: Partial<CatalogRowActions> = {}): CatalogRowActions {
  return {
    busyModelIds: new Set<string>(),
    downloadedModels: {},
    downloadProgress: {},
    isDownloading: {},
    modelCacheDir: null,
    onDownload: vi.fn(),
    onToggle: vi.fn(),
    onToggleDetails: vi.fn(),
    query: '',
    showTagline: true,
    showTypeTag: true,
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/settings-ui/src/settings/models/__tests__/catalog-nodes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildSectionNodes, createCatalogNodeCache } from '../catalog-nodes';
import { makeCatalogRow } from './catalog-test-harness';

describe('createCatalogNodeCache', () => {
  it('builds a model node with a details child', () => {
    const row = makeCatalogRow({ id: 'gpt-a' });
    const nodes = createCatalogNodeCache()(row);
    expect(nodes.model).toMatchObject({ depth: 0, hasChildren: true, id: 'gpt-a', parentId: null, type: 'model' });
    expect(nodes.detail).toMatchObject({
      depth: 1,
      hasChildren: false,
      id: 'gpt-a::details',
      parentId: 'gpt-a',
      type: 'detail',
    });
    expect(nodes.model.data).toEqual({ kind: 'model', row });
    expect(nodes.detail.data).toEqual({ kind: 'detail', row });
  });

  it('returns the SAME nodes for the same row identity, and new nodes for a replaced row', () => {
    const getNodes = createCatalogNodeCache();
    const row = makeCatalogRow({ id: 'gpt-a' });
    expect(getNodes(row)).toBe(getNodes(row));
    expect(getNodes({ ...row, enabled: true }).model).not.toBe(getNodes(row).model);
  });
});

describe('buildSectionNodes', () => {
  it('lists each model node followed by its details node', () => {
    const getNodes = createCatalogNodeCache();
    const rows = [makeCatalogRow({ id: 'a' }), makeCatalogRow({ id: 'b' })];
    expect(buildSectionNodes(rows, getNodes).map((node) => node.id)).toEqual([
      'a',
      'a::details',
      'b',
      'b::details',
    ]);
  });
});
```

Create `packages/settings-ui/src/settings/models/__tests__/catalog-columns.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { TreeTable } from '@brainstrike/ui';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CatalogWidthTier,
  getCatalogColumnLayout,
  getCatalogColumns,
  resolveCatalogWidthTier,
} from '../catalog-columns';
import { buildSectionNodes, createCatalogNodeCache } from '../catalog-nodes';
import type { CatalogRow } from '../catalog-projection';
import { type CatalogRowActions, CatalogRowActionsContext } from '../use-catalog-row-actions';
import { installCatalogDomStubs, makeRowActions } from './catalog-dom-harness';
import { makeCatalogRow } from './catalog-test-harness';

vi.mock('@tanstack/react-virtual', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual');
  const { createMockCatalogVirtualizer } =
    await vi.importActual<typeof import('./catalog-dom-harness')>('./catalog-dom-harness');
  return { ...actual, useVirtualizer: createMockCatalogVirtualizer };
});

beforeAll(() => {
  installCatalogDomStubs({ width: null });
});

function renderRows(
  rows: readonly CatalogRow[],
  options: {
    readonly actions?: Partial<CatalogRowActions>;
    readonly expandedIds?: readonly string[];
    readonly tier?: CatalogWidthTier;
  } = {}
) {
  return render(
    <CatalogRowActionsContext value={makeRowActions(options.actions)}>
      <TreeTable
        ariaLabel="Test models"
        columns={getCatalogColumns(options.tier ?? 'wide')}
        expandedIds={new Set(options.expandedIds ?? [])}
        nodes={buildSectionNodes(rows, createCatalogNodeCache())}
        onToggleExpand={vi.fn()}
        scrollParentRef={{ current: document.createElement('div') }}
        showHeader={false}
        windowingStrategy="virtual"
      />
    </CatalogRowActionsContext>
  );
}

const TERRA = makeCatalogRow({
  contextWindow: 1_050_000,
  id: 'gpt-5.6-terra',
  maxOutputTokens: 128_000,
  name: 'GPT-5.6 Terra',
  pricing: { cacheReadPerMTok: null, cacheWritePerMTok: null, inputPerMTok: 2.5, outputPerMTok: 15 },
  providerId: 'openai',
  recommended: true,
  tagline: 'Most capable for everyday work',
});

describe('resolveCatalogWidthTier', () => {
  it.each([
    [1200, 'wide'],
    [900, 'wide'],
    [899, 'medium'],
    [640, 'medium'],
    [639, 'narrow'],
    [525, 'narrow'],
  ] as const)('%i px → %s', (width, tier) => {
    expect(resolveCatalogWidthTier(width)).toBe(tier);
  });
});

describe('catalog column layouts', () => {
  it('drops Max out below 900px and Price below 640px', () => {
    expect(getCatalogColumnLayout('wide').map((column) => column.id)).toEqual([
      'enabled',
      'model',
      'capabilities',
      'context',
      'maxOutput',
      'price',
      'actions',
    ]);
    expect(getCatalogColumnLayout('medium').map((column) => column.id)).toEqual([
      'enabled',
      'model',
      'capabilities',
      'context',
      'price',
      'actions',
    ]);
    expect(getCatalogColumnLayout('narrow').map((column) => column.id)).toEqual([
      'enabled',
      'model',
      'capabilities',
      'context',
      'actions',
    ]);
    expect(getCatalogColumnLayout('narrow').find((column) => column.id === 'capabilities')?.label).toBe(
      'Caps'
    );
  });

  it('returns identity-stable column definitions per tier', () => {
    expect(getCatalogColumns('wide')).toBe(getCatalogColumns('wide'));
    expect(getCatalogColumns('narrow')).toBe(getCatalogColumns('narrow'));
  });
});

describe('catalog model rows', () => {
  it('renders one line: switch, name, tag, tagline, capabilities, context, max out and price', () => {
    renderRows([TERRA]);
    const cell = screen.getByTestId('model-row-gpt-5.6-terra');
    expect(within(cell).getByText('GPT-5.6 Terra')).toHaveAttribute('title', 'gpt-5.6-terra');
    expect(within(cell).getByText('Recommended')).toBeInTheDocument();
    expect(within(cell).getByText('Most capable for everyday work')).toBeInTheDocument();
    expect(screen.getByText('1,050,000 token context window')).toBeInTheDocument();
    expect(screen.getByText('128,000 token max output')).toBeInTheDocument();
    expect(screen.getByText('input $2.50, output $15 per million tokens')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Vision supported' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Reasoning supported' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable GPT-5.6 Terra' })).toHaveAttribute(
      'data-testid',
      'model-toggle-gpt-5.6-terra'
    );
  });

  it('shows an explicit dash for every unpublished fact, never 0', () => {
    renderRows([
      makeCatalogRow({
        contextWindow: null,
        id: 'bare',
        maxOutputTokens: null,
        pricing: null,
        reasoning: null,
        vision: null,
      }),
    ]);
    expect(screen.getByText('No published context window')).toBeInTheDocument();
    expect(screen.getByText('No published max output')).toBeInTheDocument();
    expect(screen.getByText('No published price')).toBeInTheDocument();
    expect(screen.getByText('No published capabilities')).toBeInTheDocument();
    const row = screen.getByTestId('model-row-bare').closest('tr');
    expect(row?.textContent).not.toMatch(/\$0|(^|\D)0K/);
  });

  it('labels an unknown reasoning state "unverified"', () => {
    renderRows([
      makeCatalogRow({ id: 'or', reasoning: { reason: 'openrouter-undeclared', state: 'unknown' } }),
    ]);
    expect(screen.getByRole('img', { name: 'Reasoning unverified' })).toBeInTheDocument();
  });

  it('renders Free only when both rates are zero', () => {
    renderRows([
      makeCatalogRow({
        id: 'free',
        pricing: { cacheReadPerMTok: null, cacheWritePerMTok: null, inputPerMTok: 0, outputPerMTok: 0 },
      }),
    ]);
    expect(screen.getByText('Free')).toBeInTheDocument();
  });

  it('shows embedding dimensions and the Embedding tag while Type is All', () => {
    renderRows(
      [makeCatalogRow({ dimension: 1536, id: 'text-embedding-3-small', reasoning: null, type: 'embedding', vision: null })],
      { actions: { showTypeTag: true } }
    );
    expect(screen.getByText('1536-dimension embeddings')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('model-row-text-embedding-3-small')).getByText('Embedding')
    ).toBeInTheDocument();
  });

  it('drops the Embedding tag once Type is filtered', () => {
    renderRows([makeCatalogRow({ dimension: 1536, id: 'emb', type: 'embedding' })], {
      actions: { showTypeTag: false },
    });
    expect(within(screen.getByTestId('model-row-emb')).queryByText('Embedding')).not.toBeInTheDocument();
  });

  it('swaps the tagline for the highlighted id when the query hits only the id', () => {
    renderRows(
      [makeCatalogRow({ id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', tagline: 'For complex agentic coding' })],
      { actions: { query: 'anthropic/' } }
    );
    const cell = screen.getByTestId('model-row-anthropic/claude-opus-5');
    expect(within(cell).queryByText('For complex agentic coding')).not.toBeInTheDocument();
    expect(cell.querySelector('mark')?.textContent).toBe('anthropic/');
  });

  it('highlights query matches in the name', () => {
    renderRows([makeCatalogRow({ id: 'claude-opus-5', name: 'Claude Opus 5' })], {
      actions: { query: 'opus' },
    });
    expect(screen.getByTestId('model-row-claude-opus-5').querySelector('mark')?.textContent).toBe('Opus');
  });

  it('hides Max out and Price at the narrow tier, and the tagline when showTagline is off', () => {
    renderRows([makeCatalogRow({ id: 'm', name: 'M', tagline: 'A tagline' })], {
      actions: { showTagline: false },
      tier: 'narrow',
    });
    expect(screen.queryByText(/token max output/)).not.toBeInTheDocument();
    expect(screen.queryByText(/per million tokens/)).not.toBeInTheDocument();
    expect(screen.queryByText('A tagline')).not.toBeInTheDocument();
  });

  it('routes the switch through onToggle', async () => {
    const onToggle = vi.fn();
    renderRows([makeCatalogRow({ id: 'm', name: 'M' })], { actions: { onToggle } });
    await userEvent.click(screen.getByRole('switch', { name: 'Enable M' }));
    expect(onToggle).toHaveBeenCalledWith('m', true);
  });

  it('disables the switch while its write is in flight', () => {
    renderRows([makeCatalogRow({ id: 'm', name: 'M' })], {
      actions: { busyModelIds: new Set(['m']) },
    });
    const busy = screen.getByRole('switch', { name: 'Enable M' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
  });

  it('toggles details from the row disclosure', async () => {
    const onToggleDetails = vi.fn();
    renderRows([makeCatalogRow({ id: 'm', name: 'M' })], { actions: { onToggleDetails } });
    const disclosure = screen.getByRole('button', { name: 'Show details for M' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(disclosure);
    expect(onToggleDetails).toHaveBeenCalledWith('m');
  });

  it('offers a sized download for a local model', async () => {
    const onDownload = vi.fn();
    renderRows([makeCatalogRow({ id: 'gemma', isLocal: true, name: 'Gemma', sizeLabel: '1.2 GB' })], {
      actions: { onDownload },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Download Gemma (1.2 GB)' }));
    expect(onDownload).toHaveBeenCalledWith('gemma');
  });

  it('shows download progress, then a downloaded mark', () => {
    const row = makeCatalogRow({ id: 'gemma', isLocal: true, name: 'Gemma' });
    const { unmount } = renderRows([row], {
      actions: { downloadProgress: { gemma: 40 }, isDownloading: { gemma: true } },
    });
    expect(screen.getByText('40%')).toBeInTheDocument();
    unmount();
    renderRows([row], { actions: { downloadedModels: { gemma: true } } });
    expect(screen.getByRole('img', { name: 'Gemma downloaded' })).toBeInTheDocument();
  });
});

describe('catalog details row', () => {
  it('renders every fact in full, spanning the whole row', () => {
    renderRows(
      [
        makeCatalogRow({
          bestFor: ['Coding'],
          contextWindow: 1_050_000,
          description: 'A frontier model.',
          id: 'claude-opus-5',
          maxOutputTokens: 128_000,
          name: 'Claude Opus 5',
          pricing: { cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25, inputPerMTok: 5, outputPerMTok: 25 },
          reasoningEfforts: ['low', 'high'],
        }),
      ],
      { expandedIds: ['claude-opus-5'] }
    );
    const details = screen.getByTestId('model-details-claude-opus-5');
    expect(within(details).getByText('claude-opus-5')).toBeInTheDocument();
    expect(within(details).getByRole('button', { name: 'Copy model ID claude-opus-5' })).toBeInTheDocument();
    expect(within(details).getByText('1,050,000 · 128,000 tokens')).toBeInTheDocument();
    expect(within(details).getByText('Input $5 · Output $25 per 1M tokens')).toBeInTheDocument();
    expect(within(details).getByText('Cache read $0.50')).toBeInTheDocument();
    expect(within(details).getByText('Cache write $6.25')).toBeInTheDocument();
    expect(within(details).getByText('high')).toBeInTheDocument();
    expect(within(details).getByText('Coding')).toBeInTheDocument();
    expect(within(details).getByText('A frontier model.')).toBeInTheDocument();
    expect(details.closest('td')).toHaveAttribute(
      'colspan',
      String(getCatalogColumnLayout('wide').length)
    );
  });

  it('says Unverified for an unknown reasoning state and Not published for missing facts', () => {
    renderRows(
      [
        makeCatalogRow({
          contextWindow: null,
          id: 'or',
          maxOutputTokens: null,
          pricing: null,
          reasoning: { reason: 'openrouter-undeclared', state: 'unknown' },
          reasoningEfforts: null,
        }),
      ],
      { expandedIds: ['or'] }
    );
    const details = screen.getByTestId('model-details-or');
    expect(within(details).getByText('Unverified')).toBeInTheDocument();
    expect(within(details).getByText('Not published')).toBeInTheDocument();
    expect(within(details).getByText('No published price')).toBeInTheDocument();
  });

  it('shows the cache path for a downloaded local model', () => {
    renderRows([makeCatalogRow({ id: 'gemma', isLocal: true })], {
      actions: { downloadedModels: { gemma: true }, modelCacheDir: '/models' },
      expandedIds: ['gemma'],
    });
    expect(within(screen.getByTestId('model-details-gemma')).getByText('/models/gemma')).toBeInTheDocument();
  });
});
```

Create `packages/settings-ui/src/settings/models/__tests__/catalog-column-header.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CatalogColumnHeader } from '../catalog-column-header';
import { getCatalogColumnLayout } from '../catalog-columns';
import { installCatalogDomStubs } from './catalog-dom-harness';

beforeAll(() => {
  installCatalogDomStubs({ width: null });
});

const scrollerRef = { current: null };

describe('CatalogColumnHeader', () => {
  it('is ONE presentational table whose sort controls stay in the accessibility tree', () => {
    const { container } = render(
      <CatalogColumnHeader
        layout={getCatalogColumnLayout('wide')}
        onSortChange={vi.fn()}
        scrollerRef={scrollerRef}
        sort={null}
      />
    );
    expect(container.querySelectorAll('table[role="presentation"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Model: sort ascending' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Context: sort ascending' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Max output: sort ascending' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Price: sort ascending' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Capabilities/ })).not.toBeInTheDocument();
  });

  it('cycles ascending → descending → catalog order', async () => {
    const onSortChange = vi.fn();
    const layout = getCatalogColumnLayout('wide');
    const { rerender } = render(
      <CatalogColumnHeader layout={layout} onSortChange={onSortChange} scrollerRef={scrollerRef} sort={null} />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Context: sort ascending' }));
    expect(onSortChange).toHaveBeenLastCalledWith({ column: 'context', direction: 'asc' });

    rerender(
      <CatalogColumnHeader
        layout={layout}
        onSortChange={onSortChange}
        scrollerRef={scrollerRef}
        sort={{ column: 'context', direction: 'asc' }}
      />
    );
    const ascending = screen.getByRole('button', { name: 'Context: sorted ascending; sort descending' });
    expect(ascending.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(ascending);
    expect(onSortChange).toHaveBeenLastCalledWith({ column: 'context', direction: 'desc' });

    rerender(
      <CatalogColumnHeader
        layout={layout}
        onSortChange={onSortChange}
        scrollerRef={scrollerRef}
        sort={{ column: 'context', direction: 'desc' }}
      />
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Context: sorted descending; restore default order' })
    );
    expect(onSortChange).toHaveBeenLastCalledWith(null);
  });

  it('renders the narrow tier with the compact Caps label and no Price or Max out', () => {
    render(
      <CatalogColumnHeader
        layout={getCatalogColumnLayout('narrow')}
        onSortChange={vi.fn()}
        scrollerRef={scrollerRef}
        sort={null}
      />
    );
    expect(screen.getByText('Caps')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Price/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Max output/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/catalog-nodes.test.ts src/settings/models/__tests__/catalog-columns.test.tsx src/settings/models/__tests__/catalog-column-header.test.tsx`

Expected: FAIL, because `../catalog-nodes`, `../catalog-columns` and `../catalog-column-header` do not resolve.

- [ ] **Step 4: Implement `catalog-nodes.ts` and `use-catalog-row-actions.ts`**

Create `packages/settings-ui/src/settings/models/catalog-nodes.ts`:

```ts
import type { TreeNode } from '@brainstrike/ui';
import type { CatalogRow } from './catalog-projection';

export type CatalogNodeData =
  | { readonly kind: 'detail'; readonly row: CatalogRow }
  | { readonly kind: 'model'; readonly row: CatalogRow };

export interface CatalogRowNodes {
  readonly detail: TreeNode<CatalogNodeData>;
  readonly model: TreeNode<CatalogNodeData>;
}

/**
 * Identity-stable TreeNodes per CatalogRow identity. TreeTable's flatten-level
 * reuse requires `a.node === b.node` (TreeGrid row-identity contract), so a
 * toggle rebuilds exactly one row's nodes and nothing else.
 */
export function createCatalogNodeCache(): (row: CatalogRow) => CatalogRowNodes {
  const cache = new WeakMap<CatalogRow, CatalogRowNodes>();
  return (row) => {
    const cached = cache.get(row);
    if (cached) {
      return cached;
    }
    const nodes: CatalogRowNodes = {
      detail: {
        data: { kind: 'detail', row },
        depth: 1,
        hasChildren: false,
        id: `${row.id}::details`,
        parentId: row.id,
        type: 'detail',
      },
      model: {
        data: { kind: 'model', row },
        depth: 0,
        hasChildren: true,
        id: row.id,
        parentId: null,
        type: 'model',
      },
    };
    cache.set(row, nodes);
    return nodes;
  };
}

export function buildSectionNodes(
  rows: readonly CatalogRow[],
  getNodes: (row: CatalogRow) => CatalogRowNodes
): TreeNode<CatalogNodeData>[] {
  return rows.flatMap((row) => {
    const nodes = getNodes(row);
    return [nodes.model, nodes.detail];
  });
}
```

Create `packages/settings-ui/src/settings/models/use-catalog-row-actions.ts`:

```ts
import { createContext, useContext } from 'react';

/**
 * Live per-row state the catalog cells read. It lives in context, not in the
 * column closures, so the column definitions stay module-level constants and a
 * busy/download/query change never rebuilds the columns (TreeGrid row-identity
 * contract).
 */
export interface CatalogRowActions {
  readonly busyModelIds: ReadonlySet<string>;
  readonly downloadedModels: Readonly<Record<string, boolean>>;
  readonly downloadProgress: Readonly<Record<string, number>>;
  readonly isDownloading: Readonly<Record<string, boolean>>;
  readonly modelCacheDir: string | null;
  readonly onDownload: (modelId: string) => void;
  readonly onToggle: (modelId: string, enabled: boolean) => void;
  readonly onToggleDetails: (modelId: string) => void;
  /** The deferred search query, for highlighting and "id on demand". */
  readonly query: string;
  /** False at the narrow tier (< 640px). */
  readonly showTagline: boolean;
  /** True while the Type filter is All. */
  readonly showTypeTag: boolean;
}

export const CatalogRowActionsContext = createContext<CatalogRowActions | null>(null);

export function useCatalogRowActions(): CatalogRowActions {
  const actions = useContext(CatalogRowActionsContext);
  if (!actions) {
    throw new Error('Model Catalog cells must render inside CatalogRowActionsContext.');
  }
  return actions;
}
```

- [ ] **Step 5: Implement `catalog-model-details.tsx`**

Create `packages/settings-ui/src/settings/models/catalog-model-details.tsx`:

```tsx
import { Badge, CopyTextButton } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import { formatUsd } from './catalog-format';
import type { CatalogPricing, CatalogRow } from './catalog-projection';
import { useCatalogRowActions } from './use-catalog-row-actions';

const fullNumber = new Intl.NumberFormat('en-US');

function Fact({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-xs">{children}</dd>
    </div>
  );
}

function Chips({ values }: { readonly values: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value) => (
        <Badge className="h-5 px-1.5 font-normal text-[10px]" key={value} variant="outline">
          {value}
        </Badge>
      ))}
    </div>
  );
}

function formatWindow(row: CatalogRow): string {
  if (row.contextWindow === null && row.maxOutputTokens === null) {
    return 'Not published';
  }
  const context = row.contextWindow === null ? '—' : fullNumber.format(row.contextWindow);
  const output = row.maxOutputTokens === null ? '—' : fullNumber.format(row.maxOutputTokens);
  return `${context} · ${output} tokens`;
}

function pricingLines(pricing: CatalogPricing | null): string[] {
  if (!pricing) {
    return ['No published price'];
  }
  const lines = [
    `Input ${formatUsd(pricing.inputPerMTok)} · Output ${formatUsd(pricing.outputPerMTok)} per 1M tokens`,
  ];
  if (pricing.cacheReadPerMTok !== null) {
    lines.push(`Cache read ${formatUsd(pricing.cacheReadPerMTok)}`);
  }
  if (pricing.cacheWritePerMTok !== null) {
    lines.push(`Cache write ${formatUsd(pricing.cacheWritePerMTok)}`);
  }
  return lines;
}

function ReasoningFact({ row }: { readonly row: CatalogRow }) {
  if (row.reasoning === null) {
    return null;
  }
  let content: ReactNode;
  switch (row.reasoning.state) {
    case 'supported':
      content =
        row.reasoningEfforts && row.reasoningEfforts.length > 0 ? (
          <Chips values={row.reasoningEfforts} />
        ) : (
          'Supported'
        );
      break;
    case 'unknown':
      content = 'Unverified';
      break;
    case 'unsupported':
      content = 'Not supported';
      break;
    default: {
      const exhaustive: never = row.reasoning;
      throw new Error(`Unknown reasoning support: ${JSON.stringify(exhaustive)}`);
    }
  }
  return <Fact label="Reasoning effort">{content}</Fact>;
}

function resolveCachePath(
  row: CatalogRow,
  downloaded: boolean,
  modelCacheDir: string | null
): string | null {
  if (!(row.isLocal && downloaded)) {
    return null;
  }
  return modelCacheDir ? `${modelCacheDir}/${row.id}` : 'Cached in system default';
}

/** The inline details row (a level-2 TreeTable row spanning every column). */
export function CatalogModelDetails({ row }: { readonly row: CatalogRow }) {
  const { downloadedModels, modelCacheDir } = useCatalogRowActions();
  const cachePath = resolveCachePath(row, downloadedModels[row.id] === true, modelCacheDir);
  return (
    <div className="space-y-3 py-3 pr-4 pl-[60px]" data-testid={`model-details-${row.id}`}>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-6 gap-y-3">
        <Fact label="Model ID">
          <span className="inline-flex max-w-full items-center gap-1">
            <code className="truncate font-mono text-xs">{row.id}</code>
            <CopyTextButton ariaLabel={`Copy model ID ${row.id}`} text={row.id} />
          </span>
        </Fact>
        {row.type === 'chat' ? (
          <Fact label="Context · Max output">{formatWindow(row)}</Fact>
        ) : (
          <Fact label="Dimensions">
            {row.dimension === null ? 'Not published' : fullNumber.format(row.dimension)}
          </Fact>
        )}
        <Fact label="Pricing">
          {pricingLines(row.pricing).map((line) => (
            <span className="block" key={line}>
              {line}
            </span>
          ))}
        </Fact>
        <ReasoningFact row={row} />
        {row.bestFor.length > 0 ? (
          <Fact label="Best for">
            <Chips values={row.bestFor} />
          </Fact>
        ) : null}
        {cachePath ? (
          <Fact label="Cache path">
            <code className="break-all font-mono text-[11px]">{cachePath}</code>
          </Fact>
        ) : null}
      </dl>
      {row.description ? (
        <p className="max-w-prose text-muted-foreground text-xs leading-relaxed">{row.description}</p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Implement `catalog-columns.tsx`**

Create `packages/settings-ui/src/settings/models/catalog-columns.tsx`:

```tsx
import {
  Badge,
  Button,
  cn,
  formatTokenCount,
  Switch,
  type TreeTableCellProps,
  type TreeTableColumn,
} from '@brainstrike/ui';
import { Check, ChevronDown, Download, Eye, Loader2, Sun } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { highlightSegments, queryHitsIdOnly } from './catalog-filters';
import { formatUsd } from './catalog-format';
import { CatalogModelDetails } from './catalog-model-details';
import type { CatalogNodeData } from './catalog-nodes';
import type { CatalogRow } from './catalog-projection';
import type { CatalogSortColumn } from './catalog-sections';
import { useCatalogRowActions } from './use-catalog-row-actions';

export type CatalogWidthTier = 'medium' | 'narrow' | 'wide';

export type CatalogColumnId =
  | 'actions'
  | 'capabilities'
  | 'context'
  | 'enabled'
  | 'maxOutput'
  | 'model'
  | 'price';

export interface CatalogColumnLayout {
  readonly align: 'center' | 'left' | 'right';
  readonly id: CatalogColumnId;
  /** Visible header text; empty for the switch and actions columns. */
  readonly label: string;
  /** Accessible name of the column's sort control. */
  readonly name: string;
  readonly sortColumn: CatalogSortColumn | null;
  /** Fixed width in px; `null` for the flexible Model column (the table-fixed remainder). */
  readonly width: number | null;
}

/** Catalog CONTAINER widths, not viewport widths (design §5, Responsive). */
const WIDE_MIN_WIDTH_PX = 900;
const MEDIUM_MIN_WIDTH_PX = 640;

export function resolveCatalogWidthTier(width: number): CatalogWidthTier {
  if (width >= WIDE_MIN_WIDTH_PX) {
    return 'wide';
  }
  if (width >= MEDIUM_MIN_WIDTH_PX) {
    return 'medium';
  }
  return 'narrow';
}

const ENABLED_COLUMN: CatalogColumnLayout = {
  align: 'center',
  id: 'enabled',
  label: '',
  name: 'Enabled',
  sortColumn: null,
  width: 60,
};
const MODEL_COLUMN: CatalogColumnLayout = {
  align: 'left',
  id: 'model',
  label: 'Model',
  name: 'Model',
  sortColumn: 'name',
  width: null,
};
const CAPABILITIES_COLUMN: CatalogColumnLayout = {
  align: 'left',
  id: 'capabilities',
  label: 'Capabilities',
  name: 'Capabilities',
  sortColumn: null,
  width: 96,
};
const COMPACT_CAPABILITIES_COLUMN: CatalogColumnLayout = {
  ...CAPABILITIES_COLUMN,
  label: 'Caps',
  width: 72,
};
const CONTEXT_COLUMN: CatalogColumnLayout = {
  align: 'right',
  id: 'context',
  label: 'Context',
  name: 'Context',
  sortColumn: 'context',
  width: 80,
};
const MAX_OUTPUT_COLUMN: CatalogColumnLayout = {
  align: 'right',
  id: 'maxOutput',
  label: 'Max out',
  name: 'Max output',
  sortColumn: 'maxOutput',
  width: 84,
};
const PRICE_COLUMN: CatalogColumnLayout = {
  align: 'right',
  id: 'price',
  label: '$ / 1M in · out',
  name: 'Price',
  sortColumn: 'price',
  width: 128,
};
const ACTIONS_COLUMN: CatalogColumnLayout = {
  align: 'right',
  id: 'actions',
  label: '',
  name: 'Actions',
  sortColumn: null,
  width: 88,
};

const COLUMN_LAYOUTS: Record<CatalogWidthTier, readonly CatalogColumnLayout[]> = {
  medium: [ENABLED_COLUMN, MODEL_COLUMN, CAPABILITIES_COLUMN, CONTEXT_COLUMN, PRICE_COLUMN, ACTIONS_COLUMN],
  narrow: [ENABLED_COLUMN, MODEL_COLUMN, COMPACT_CAPABILITIES_COLUMN, CONTEXT_COLUMN, ACTIONS_COLUMN],
  wide: [
    ENABLED_COLUMN,
    MODEL_COLUMN,
    CAPABILITIES_COLUMN,
    CONTEXT_COLUMN,
    MAX_OUTPUT_COLUMN,
    PRICE_COLUMN,
    ACTIONS_COLUMN,
  ],
};

export function getCatalogColumnLayout(tier: CatalogWidthTier): readonly CatalogColumnLayout[] {
  return COLUMN_LAYOUTS[tier];
}

/**
 * One cell line. 35px of content plus the row's 1px collapsed border paints a
 * 36px pitch; Task 10's E2E measures it (docs/agents/ui-conventions.md, "Row
 * height and painted geometry"). If that measurement disagrees, fix THIS value.
 */
const ROW_LINE = 'flex h-[35px] items-center';

function HighlightedText({ query, text }: { readonly query: string; readonly text: string }) {
  return (
    <>
      {highlightSegments(text, query).map((segment) =>
        segment.match ? (
          <mark
            className="rounded-[2px] bg-yellow-300/60 text-inherit dark:bg-yellow-400/30"
            key={segment.start}
          >
            {segment.text}
          </mark>
        ) : (
          <Fragment key={segment.start}>{segment.text}</Fragment>
        )
      )}
    </>
  );
}

/** An unpublished fact: a visible dash, with the reason for screen readers and on hover. */
function Absent({ title }: { readonly title: string }) {
  return (
    <span className="text-muted-foreground text-xs" title={title}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}

function EnabledCell({ row }: { readonly row: CatalogRow }) {
  const { busyModelIds, onToggle } = useCatalogRowActions();
  const busy = busyModelIds.has(row.id);
  return (
    <div className={cn(ROW_LINE, 'justify-center')}>
      <Switch
        aria-busy={busy}
        aria-label={`Enable ${row.name}`}
        checked={row.enabled}
        data-testid={`model-toggle-${row.id}`}
        disabled={busy}
        onCheckedChange={(checked) => onToggle(row.id, checked)}
      />
    </div>
  );
}

function ModelCell({ row }: { readonly row: CatalogRow }) {
  const { query, showTagline, showTypeTag } = useCatalogRowActions();
  const showId = queryHitsIdOnly(row, query);
  let secondary: string | null = null;
  if (showId) {
    secondary = row.id;
  } else if (showTagline) {
    secondary = row.tagline;
  }
  return (
    // `model-row-<id>` is kept for E2E continuity; TreeTable owns the <tr>.
    <div className={cn(ROW_LINE, 'min-w-0 gap-2')} data-testid={`model-row-${row.id}`}>
      <span className="truncate font-medium text-[13px]" title={row.id}>
        <HighlightedText query={query} text={row.name} />
      </span>
      {row.recommended ? (
        <Badge className="h-5 shrink-0 px-1.5 text-[10px]" variant="secondary">
          Recommended
        </Badge>
      ) : null}
      {showTypeTag && row.type === 'embedding' ? (
        <Badge className="h-5 shrink-0 px-1.5 text-[10px]" variant="outline">
          Embedding
        </Badge>
      ) : null}
      {secondary ? (
        <span className={cn('min-w-0 truncate text-muted-foreground text-xs', showId && 'font-mono')}>
          <HighlightedText query={query} text={secondary} />
        </span>
      ) : null}
    </div>
  );
}

type CapabilityState = 'supported' | 'unknown' | 'unsupported';

const CAPABILITY_COPY: Record<CapabilityState, string> = {
  supported: 'supported',
  unknown: 'unverified',
  unsupported: 'not supported',
};

const CAPABILITY_CLASS: Record<CapabilityState, string> = {
  supported: 'text-foreground',
  unknown: 'border border-muted-foreground/60 border-dashed text-muted-foreground',
  unsupported: 'text-muted-foreground/35',
};

function CapabilityIcon({
  icon,
  label,
  state,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly state: CapabilityState | null;
}) {
  if (state === null) {
    return null;
  }
  const description = `${label} ${CAPABILITY_COPY[state]}`;
  return (
    <span
      aria-label={description}
      className={cn('inline-flex size-5 items-center justify-center rounded', CAPABILITY_CLASS[state])}
      role="img"
      title={description}
    >
      {icon}
    </span>
  );
}

function CapabilitiesCell({ row }: { readonly row: CatalogRow }) {
  if (row.type === 'embedding') {
    return (
      <div className={ROW_LINE}>
        {row.dimension === null ? (
          <Absent title="No published dimensions" />
        ) : (
          <span className="text-muted-foreground text-xs tabular-nums">
            <span aria-hidden="true">{row.dimension}-d</span>
            <span className="sr-only">{`${row.dimension}-dimension embeddings`}</span>
          </span>
        )}
      </div>
    );
  }
  if (row.vision === null && row.reasoning === null) {
    return (
      <div className={ROW_LINE}>
        <Absent title="No published capabilities" />
      </div>
    );
  }
  return (
    <div className={cn(ROW_LINE, 'gap-1.5')}>
      <CapabilityIcon
        icon={<Eye aria-hidden="true" className="size-3.5" />}
        label="Vision"
        state={row.vision}
      />
      <CapabilityIcon
        icon={<Sun aria-hidden="true" className="size-3.5" />}
        label="Reasoning"
        state={row.reasoning?.state ?? null}
      />
    </div>
  );
}

function TokenCell({ label, value }: { readonly label: string; readonly value: number | null }) {
  return (
    <div className={cn(ROW_LINE, 'justify-end')}>
      {value === null ? (
        <Absent title={`No published ${label}`} />
      ) : (
        <span className="text-xs tabular-nums">
          <span aria-hidden="true">{formatTokenCount(value)}</span>
          <span className="sr-only">{`${value.toLocaleString('en-US')} token ${label}`}</span>
        </span>
      )}
    </div>
  );
}

function PriceCell({ row }: { readonly row: CatalogRow }) {
  const { pricing } = row;
  if (!pricing) {
    return (
      <div className={cn(ROW_LINE, 'justify-end')}>
        <Absent title="No published price" />
      </div>
    );
  }
  if (pricing.inputPerMTok === 0 && pricing.outputPerMTok === 0) {
    return (
      <div className={cn(ROW_LINE, 'justify-end')}>
        <span className="text-xs">Free</span>
      </div>
    );
  }
  const input = formatUsd(pricing.inputPerMTok);
  const output = formatUsd(pricing.outputPerMTok);
  return (
    <div className={cn(ROW_LINE, 'justify-end')}>
      <span className="text-xs tabular-nums">
        <span aria-hidden="true">
          {input} <span className="text-muted-foreground">· {output}</span>
        </span>
        <span className="sr-only">{`input ${input}, output ${output} per million tokens`}</span>
      </span>
    </div>
  );
}

function DownloadControl({ row }: { readonly row: CatalogRow }) {
  const { downloadedModels, downloadProgress, isDownloading, onDownload } = useCatalogRowActions();
  if (isDownloading[row.id] === true) {
    const progress = downloadProgress[row.id];
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground text-xs tabular-nums">
        <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
        {progress === undefined ? 'Starting…' : `${progress}%`}
      </span>
    );
  }
  if (downloadedModels[row.id] === true) {
    return (
      <span
        aria-label={`${row.name} downloaded`}
        className="inline-flex items-center text-green-600 dark:text-green-400"
        role="img"
        title="Downloaded"
      >
        <Check aria-hidden="true" className="size-3.5" />
      </span>
    );
  }
  const label = row.sizeLabel ? `Download ${row.name} (${row.sizeLabel})` : `Download ${row.name}`;
  return (
    <Button
      aria-label={label}
      className="size-7"
      data-testid={`model-download-${row.id}`}
      onClick={() => onDownload(row.id)}
      size="icon-xs"
      title={label}
      variant="ghost"
    >
      <Download aria-hidden="true" className="size-3.5" />
    </Button>
  );
}

function ActionsCell({ isExpanded, row }: { readonly isExpanded: boolean; readonly row: CatalogRow }) {
  const { onToggleDetails } = useCatalogRowActions();
  return (
    <div className={cn(ROW_LINE, 'justify-end gap-1')}>
      {row.isLocal ? <DownloadControl row={row} /> : null}
      <Button
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Hide' : 'Show'} details for ${row.name}`}
        className="size-7"
        data-testid={`model-details-toggle-${row.id}`}
        onClick={() => onToggleDetails(row.id)}
        size="icon-xs"
        variant="ghost"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
            isExpanded && 'rotate-180'
          )}
        />
      </Button>
    </div>
  );
}

function renderCell(id: CatalogColumnId, { isExpanded, node }: TreeTableCellProps<CatalogNodeData>): ReactNode {
  const { row } = node.data;
  switch (id) {
    case 'actions':
      return <ActionsCell isExpanded={isExpanded} row={row} />;
    case 'capabilities':
      return <CapabilitiesCell row={row} />;
    case 'context':
      return <TokenCell label="context window" value={row.contextWindow} />;
    case 'enabled':
      return <EnabledCell row={row} />;
    case 'maxOutput':
      return <TokenCell label="max output" value={row.maxOutputTokens} />;
    case 'model':
      return <ModelCell row={row} />;
    case 'price':
      return <PriceCell row={row} />;
    default: {
      const exhaustive: never = id;
      throw new Error(`Unknown catalog column: ${String(exhaustive)}`);
    }
  }
}

function buildColumns(layout: readonly CatalogColumnLayout[]): TreeTableColumn<CatalogNodeData>[] {
  return layout.map((column, index) => ({
    cell: (props: TreeTableCellProps<CatalogNodeData>) =>
      index === 0 && props.node.data.kind === 'detail' ? (
        <CatalogModelDetails row={props.node.data.row} />
      ) : (
        renderCell(column.id, props)
      ),
    className: 'px-2 py-0',
    // The details row is one cell spanning every column.
    ...(index === 0
      ? {
          colSpan: ({ node }: TreeTableCellProps<CatalogNodeData>) =>
            node.data.kind === 'detail' ? layout.length : 1,
        }
      : {}),
    id: column.id,
    // No tree column: the row's own disclosure (Actions) opens details.
    isTreeColumn: false,
    ...(column.width === null ? {} : { width: column.width }),
  }));
}

/** Module-level, so every tier's column array is identity-stable (TreeGrid row-identity contract). */
const COLUMNS: Record<CatalogWidthTier, TreeTableColumn<CatalogNodeData>[]> = {
  medium: buildColumns(COLUMN_LAYOUTS.medium),
  narrow: buildColumns(COLUMN_LAYOUTS.narrow),
  wide: buildColumns(COLUMN_LAYOUTS.wide),
};

export function getCatalogColumns(tier: CatalogWidthTier): TreeTableColumn<CatalogNodeData>[] {
  return COLUMNS[tier];
}
```

- [ ] **Step 7: Implement the gutter hook and the column header**

Create `packages/settings-ui/src/settings/models/use-scrollbar-gutter-width.ts`:

```ts
import { useResizeObserver } from '@brainstrike/ui';
import { type RefObject, useCallback, useState } from 'react';

/**
 * Width the scroller's vertical scrollbar takes from its content box: 0 with
 * overlay scrollbars, about 15px with classic ones. The column header sits
 * OUTSIDE the scroller and pads by this so its columns align with the rows.
 * Mirrors the Explorer forest header's private measurement
 * (file-explorer-ui/src/shell/explorer-column-header.tsx).
 */
export function useScrollbarGutterWidth(scrollerRef: RefObject<HTMLElement | null>): number {
  const [gutterWidth, setGutterWidth] = useState(0);
  useResizeObserver(
    scrollerRef,
    useCallback(() => {
      const scroller = scrollerRef.current;
      if (!scroller) {
        return;
      }
      const next = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
      setGutterWidth((previous) => (Math.abs(previous - next) < 1 ? previous : next));
    }, [scrollerRef])
  );
  return gutterWidth;
}
```

Create `packages/settings-ui/src/settings/models/catalog-column-header.tsx`:

```tsx
import {
  cn,
  getNextTreeTableSortDirection,
  getTreeTableAriaSortValue,
  getTreeTableSortButtonLabel,
  type SortState,
} from '@brainstrike/ui';
import type { RefObject } from 'react';
import type { CatalogColumnLayout } from './catalog-columns';
import type { CatalogSort, CatalogSortColumn } from './catalog-sections';
import { useScrollbarGutterWidth } from './use-scrollbar-gutter-width';

export interface CatalogColumnHeaderProps {
  readonly layout: readonly CatalogColumnLayout[];
  readonly onSortChange: (next: CatalogSort | null) => void;
  readonly scrollerRef: RefObject<HTMLElement | null>;
  readonly sort: CatalogSort | null;
}

const ALIGN_CLASS: Record<CatalogColumnLayout['align'], string> = {
  center: 'text-center',
  left: 'text-left',
  right: 'text-right',
};

/**
 * ONE header above the shared scroller: the catalog renders N provider
 * treegrids in one scroll owner, so N sticky table headers would stack
 * (Explorer forest precedent, docs/agents/ui-conventions.md → Explorer tree
 * GRID). `role="presentation"` because one header cannot be ARIA-associated
 * with N grids; the sort buttons stay real controls, and every cell describes
 * itself with sr-only text. It aligns by construction: the same `table-fixed` +
 * `<colgroup>` widths and the cell padding, minus the scroller's gutter.
 */
export function CatalogColumnHeader({ layout, onSortChange, scrollerRef, sort }: CatalogColumnHeaderProps) {
  const gutterWidth = useScrollbarGutterWidth(scrollerRef);
  const sortState: SortState = { columnId: sort?.column ?? null, direction: sort?.direction ?? null };

  const handleSort = (column: CatalogSortColumn): void => {
    const current = sort?.column === column ? sort.direction : null;
    const next = getNextTreeTableSortDirection(current);
    onSortChange(next === null ? null : { column, direction: next });
  };

  return (
    <div
      className="shrink-0 border-b bg-muted/30"
      data-testid="model-catalog-column-header"
      style={{ paddingRight: gutterWidth }}
    >
      <table className="w-full table-fixed" role="presentation">
        <colgroup>
          {layout.map((column) => (
            <col key={column.id} style={column.width === null ? undefined : { width: `${column.width}px` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {layout.map((column) => {
              const sortColumn = column.sortColumn;
              return (
                <th
                  aria-sort={sortColumn ? getTreeTableAriaSortValue(sortColumn, sortState) : undefined}
                  className={cn(
                    'h-8 px-2 font-medium text-[11px] text-muted-foreground uppercase tracking-wide',
                    ALIGN_CLASS[column.align]
                  )}
                  data-column-id={column.id}
                  key={column.id}
                >
                  {sortColumn ? (
                    <button
                      aria-label={getTreeTableSortButtonLabel(column.name, sortColumn, sortState)}
                      className={cn(
                        'inline-flex h-full cursor-pointer items-center gap-1 uppercase tracking-wide',
                        column.align === 'right' && 'justify-end'
                      )}
                      onClick={() => handleSort(sortColumn)}
                      type="button"
                    >
                      {column.label}
                      {sortState.columnId === sortColumn && sortState.direction ? (
                        <span aria-hidden="true">{sortState.direction === 'asc' ? '↑' : '↓'}</span>
                      ) : null}
                    </button>
                  ) : (
                    <span aria-hidden="true" className="truncate">
                      {column.label}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
      </table>
    </div>
  );
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/catalog-nodes.test.ts src/settings/models/__tests__/catalog-columns.test.tsx src/settings/models/__tests__/catalog-column-header.test.tsx`

Expected: PASS. If no row renders at all, the `@tanstack/react-virtual` mock did not apply to `@brainstrike/ui`'s import. Confirm with `pnpm --filter @brainstrike/settings-ui exec node -e "console.log(require.resolve('@tanstack/react-virtual'))"` and the same from `packages/ui`: both must resolve to the same `.pnpm` path. Report a mismatch instead of working around it.

- [ ] **Step 9: Mutation checks (revert after each)**

1. In `PriceCell`, replace `if (!pricing) { … }` with `if (!pricing) { return <div className={cn(ROW_LINE, 'justify-end')}><span className="text-xs">$0</span></div>; }`. "shows an explicit dash … never 0" must fail.
2. In `CAPABILITY_COPY`, change `unknown: 'unverified'` to `unknown: 'not supported'`. "labels an unknown reasoning state" must fail.
3. In `buildColumns`, drop the `colSpan` spread. "renders every fact in full, spanning the whole row" must fail.

After reverting, re-run Step 8 and confirm PASS.

- [ ] **Step 10: Full lane and type-check**

Run:
- `pnpm --filter @brainstrike/settings-ui test`
- `node scripts/run-turbo-command.mjs -- run type-check --filter=@brainstrike/settings-ui`

Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
pnpm exec biome check --write packages/settings-ui/src/settings/models/catalog-nodes.ts packages/settings-ui/src/settings/models/use-catalog-row-actions.ts packages/settings-ui/src/settings/models/catalog-model-details.tsx packages/settings-ui/src/settings/models/catalog-columns.tsx packages/settings-ui/src/settings/models/use-scrollbar-gutter-width.ts packages/settings-ui/src/settings/models/catalog-column-header.tsx packages/settings-ui/src/settings/models/__tests__/catalog-dom-harness.ts packages/settings-ui/src/settings/models/__tests__/catalog-nodes.test.ts packages/settings-ui/src/settings/models/__tests__/catalog-columns.test.tsx packages/settings-ui/src/settings/models/__tests__/catalog-column-header.test.tsx
git add packages/settings-ui/src/settings/models
git commit -m "feat(BST-1805): add one-line catalog rows, details row and column header

Identity-stable TreeNodes and module-level columns per width tier;
unpublished facts render as an explicit dash, unknown reasoning as
unverified; one presentational header aligned to the shared scroller.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Provider section — sticky header, enabled meter, bulk actions, section TreeTable

**Files:**
- Create: `packages/settings-ui/src/settings/models/catalog-section.tsx`
- Modify: `docs/agents/ui-conventions.md` (§ Scroll ownership: add the catalog as a sanctioned shared-scroller consumer)
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-section.test.tsx`

**Interfaces:**
- Consumes:
  - `CatalogSection` (the model type), `CatalogRow`, `CatalogNodeData`, `CatalogRowNodes`, `buildSectionNodes`, `createCatalogNodeCache`, and `getCatalogColumns` (Tasks 2 and 6).
  - `STICKY_SECTION_HEADER_LAYER_CLASS` (Task 1), and `PROVIDER_COLOR_MAP`, `ProviderIcon`, `TreeTable` from `@brainstrike/ui`.
- Produces: `CatalogSection(props: CatalogSectionProps)`, with these props:
  - `busyModelIds: ReadonlySet<string>`
  - `columns: TreeTableColumn<CatalogNodeData>[]`
  - `compact: boolean` (narrow tier: no runtime tag, no meter)
  - `detailsOpenIds: ReadonlySet<string>`
  - `expanded: boolean`
  - `filtering: boolean`
  - `getNodes: (row) => CatalogRowNodes`
  - `onBulkChange: (section, enabled: boolean) => void`
  - `onToggleDetails: (modelId: string) => void`
  - `onToggleModel: (modelId: string, enabled: boolean) => void`
  - `onToggleSection: (providerId: string) => void`
  - `scrollParentRef: RefObject<HTMLElement | null>`
  - `section: CatalogSection`
- Test ids:
  - `model-catalog-section-<providerId>`
  - `model-catalog-section-header-<providerId>`
  - `model-catalog-section-toggle-<providerId>`
  - `model-catalog-section-count-<providerId>`
  - `model-catalog-enable-<providerId>`
  - `model-catalog-disable-<providerId>`

Contract points (design §6, §7, §8):
- **Header structure:** the header is `sticky top-0` IN FLOW inside the shared scroller, so the next header pushes it out.
- **Disclosure:** the header wraps an `<h3>` holding ONE disclosure button (`aria-expanded`, `aria-controls`). The bulk buttons sit BESIDE that button, not nested in it.
- **Section table:** each expanded section is a TreeTable `role="treegrid"` named `"<Provider> models"`. It uses `scrollParentRef` and `windowingStrategy="virtual"`, sets `showHeader={false}`, and uses the per-type `rowHeight` estimate.
- **Keyboard:**
  - **Space** toggles the focused row's switch through `onCheckboxSpace`.
  - **Enter** toggles details through `onSelect`, with `selectionMode="single"`, `selectedId={null}` and `selectOnRowClick={false}`, so a pointer click on a row selects nothing.
  - **→ and ←** open and close details through `onToggleExpand`.
- **Bulk buttons:** the labels read "Enable all"/"Disable all", or "Enable N shown"/"Disable N shown" while filtering. A button is disabled when none of the shown rows would change.

- [ ] **Step 1: Write the failing tests**

Create `packages/settings-ui/src/settings/models/__tests__/catalog-section.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { STICKY_SECTION_HEADER_LAYER_CLASS } from '@brainstrike/ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getCatalogColumns } from '../catalog-columns';
import { createCatalogNodeCache } from '../catalog-nodes';
import { CatalogSection, type CatalogSectionProps } from '../catalog-section';
import type { CatalogSection as CatalogSectionModel } from '../catalog-sections';
import { CatalogRowActionsContext } from '../use-catalog-row-actions';
import { installCatalogDomStubs, makeRowActions } from './catalog-dom-harness';
import { makeCatalogRow } from './catalog-test-harness';

vi.mock('@tanstack/react-virtual', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual');
  const { createMockCatalogVirtualizer } =
    await vi.importActual<typeof import('./catalog-dom-harness')>('./catalog-dom-harness');
  return { ...actual, useVirtualizer: createMockCatalogVirtualizer };
});

beforeAll(() => {
  installCatalogDomStubs({ width: null });
});

const SECTION: CatalogSectionModel = {
  enabledCount: 1,
  providerId: 'openai',
  providerName: 'OpenAI',
  rows: [
    makeCatalogRow({ enabled: true, id: 'gpt-a', name: 'GPT A', providerId: 'openai' }),
    makeCatalogRow({ enabled: false, id: 'gpt-b', name: 'GPT B', providerId: 'openai' }),
  ],
  runtimeLabel: 'Hosted',
  totalCount: 3,
};

function renderSection(overrides: Partial<CatalogSectionProps> = {}) {
  const props: CatalogSectionProps = {
    busyModelIds: new Set<string>(),
    columns: getCatalogColumns('wide'),
    compact: false,
    detailsOpenIds: new Set<string>(),
    expanded: true,
    filtering: false,
    getNodes: createCatalogNodeCache(),
    onBulkChange: vi.fn(),
    onToggleDetails: vi.fn(),
    onToggleModel: vi.fn(),
    onToggleSection: vi.fn(),
    scrollParentRef: { current: document.createElement('div') },
    section: SECTION,
    ...overrides,
  };
  render(
    <CatalogRowActionsContext value={makeRowActions()}>
      <CatalogSection {...props} />
    </CatalogRowActionsContext>
  );
  return props;
}

describe('CatalogSection header', () => {
  it('is a sticky, token-layered header with one disclosure inside an h3', async () => {
    const props = renderSection();
    const header = screen.getByTestId('model-catalog-section-header-openai');
    // Pin the literal classes (Tailwind scans source text; see ui-conventions).
    expect(header.className).toContain('sticky');
    expect(header.className).toContain('top-0');
    expect(header.className).toContain(STICKY_SECTION_HEADER_LAYER_CLASS);

    const heading = within(header).getByRole('heading', { level: 3 });
    const disclosure = within(heading).getByRole('button', { name: /OpenAI/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const regionId = disclosure.getAttribute('aria-controls');
    expect(regionId).toBeTruthy();
    expect(document.getElementById(regionId ?? '')).toContainElement(
      screen.getByRole('treegrid', { name: 'OpenAI models' })
    );
    expect(within(heading).queryByRole('button', { name: /Enable/ })).not.toBeInTheDocument();

    await userEvent.click(disclosure);
    expect(props.onToggleSection).toHaveBeenCalledWith('openai');
  });

  it('shows the runtime tag, the enabled meter text, and unfiltered bulk labels', () => {
    renderSection();
    const header = screen.getByTestId('model-catalog-section-header-openai');
    expect(within(header).getByText('Hosted')).toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-section-count-openai')).toHaveTextContent('1 / 3 enabled');
    expect(within(header).getByRole('button', { name: 'Enable all' })).toBeEnabled();
    expect(within(header).getByRole('button', { name: 'Disable all' })).toBeEnabled();
    expect(within(header).queryByText(/shown/)).not.toBeInTheDocument();
  });

  it('scopes the labels to the shown rows while filtering', () => {
    renderSection({ filtering: true });
    const header = screen.getByTestId('model-catalog-section-header-openai');
    expect(within(header).getByText('2 shown')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Enable 2 shown' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Disable 2 shown' })).toBeInTheDocument();
  });

  it('disables a bulk action with nothing to change and reports the section otherwise', async () => {
    const allOn: CatalogSectionModel = {
      ...SECTION,
      rows: [makeCatalogRow({ enabled: true, id: 'gpt-a', name: 'GPT A' })],
    };
    const props = renderSection({ section: allOn });
    expect(screen.getByTestId('model-catalog-enable-openai')).toBeDisabled();
    await userEvent.click(screen.getByTestId('model-catalog-disable-openai'));
    expect(props.onBulkChange).toHaveBeenCalledWith(allOn, false);
  });

  it('drops the runtime tag and meter in compact mode but keeps counts and bulk actions', () => {
    renderSection({ compact: true });
    const header = screen.getByTestId('model-catalog-section-header-openai');
    expect(within(header).queryByText('Hosted')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-section-count-openai')).toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-enable-openai')).toBeInTheDocument();
  });

  it('renders no treegrid while collapsed', () => {
    renderSection({ expanded: false });
    expect(screen.queryByRole('treegrid')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-section-toggle-openai')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
});

describe('CatalogSection keyboard', () => {
  it('Space toggles the focused row, Enter and → open its details', () => {
    const props = renderSection();
    const grid = screen.getByRole('treegrid', { name: 'OpenAI models' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' }); // activates roving focus on the first row
    fireEvent.keyDown(grid, { key: ' ' });
    expect(props.onToggleModel).toHaveBeenCalledWith('gpt-a', false);
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(props.onToggleDetails).toHaveBeenLastCalledWith('gpt-a');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(props.onToggleDetails).toHaveBeenLastCalledWith('gpt-a');
  });

  it('Space does nothing while that row is busy', () => {
    const props = renderSection({ busyModelIds: new Set(['gpt-a']) });
    const grid = screen.getByRole('treegrid', { name: 'OpenAI models' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: ' ' });
    expect(props.onToggleModel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/catalog-section.test.tsx`

Expected: FAIL, because `../catalog-section` does not resolve.

- [ ] **Step 3: Implement**

Create `packages/settings-ui/src/settings/models/catalog-section.tsx`:

```tsx
import {
  Badge,
  Button,
  cn,
  PROVIDER_COLOR_MAP,
  ProviderIcon,
  STICKY_SECTION_HEADER_LAYER_CLASS,
  type TreeNode,
  TreeTable,
  type TreeTableColumn,
} from '@brainstrike/ui';
import { ChevronRight } from 'lucide-react';
import { type CSSProperties, type RefObject, useCallback, useId, useMemo } from 'react';
import { buildSectionNodes, type CatalogNodeData, type CatalogRowNodes } from './catalog-nodes';
import type { CatalogRow } from './catalog-projection';
import type { CatalogSection as CatalogSectionModel } from './catalog-sections';

/** First-paint estimates only; TreeTable measures the real rows (TreeGrid row-height contract). */
const ROW_HEIGHT_ESTIMATES = { detail: 132, model: 36 };

function rowClassName(node: TreeNode<CatalogNodeData>): string {
  if (node.data.kind === 'detail') {
    return 'cursor-default bg-muted/20 hover:bg-muted/20';
  }
  return node.data.row.enabled ? 'bg-primary/5' : '';
}

type ProviderTileStyle = CSSProperties & Record<'--provider-dark' | '--provider-light', string>;

function ProviderTile({ providerId }: { readonly providerId: string }) {
  const pair = PROVIDER_COLOR_MAP[providerId];
  const style: ProviderTileStyle | undefined = pair
    ? { '--provider-dark': pair.dark, '--provider-light': pair.light }
    : undefined;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md border bg-background',
        pair ? 'text-(--provider-light) dark:text-(--provider-dark)' : 'text-muted-foreground'
      )}
      style={style}
    >
      <ProviderIcon className="size-3.5" providerId={providerId} />
    </span>
  );
}

/** Decorative; the adjacent "n / total enabled" text carries the meaning. */
function EnabledMeter({ enabled, total }: { readonly enabled: number; readonly total: number }) {
  const percent = total === 0 ? 0 : Math.round((enabled / total) * 100);
  return (
    <span aria-hidden="true" className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted">
      <span className="block h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
    </span>
  );
}

export interface CatalogSectionProps {
  readonly busyModelIds: ReadonlySet<string>;
  readonly columns: TreeTableColumn<CatalogNodeData>[];
  /** Narrow tier: drop the runtime tag and meter, keep counts and bulk actions. */
  readonly compact: boolean;
  readonly detailsOpenIds: ReadonlySet<string>;
  readonly expanded: boolean;
  readonly filtering: boolean;
  readonly getNodes: (row: CatalogRow) => CatalogRowNodes;
  readonly onBulkChange: (section: CatalogSectionModel, enabled: boolean) => void;
  readonly onToggleDetails: (modelId: string) => void;
  readonly onToggleModel: (modelId: string, enabled: boolean) => void;
  readonly onToggleSection: (providerId: string) => void;
  /** The catalog's single scroll owner (shared-scroller mode). */
  readonly scrollParentRef: RefObject<HTMLElement | null>;
  readonly section: CatalogSectionModel;
}

export function CatalogSection({
  busyModelIds,
  columns,
  compact,
  detailsOpenIds,
  expanded,
  filtering,
  getNodes,
  onBulkChange,
  onToggleDetails,
  onToggleModel,
  onToggleSection,
  scrollParentRef,
  section,
}: CatalogSectionProps) {
  const regionId = useId();
  const nodes = useMemo(() => buildSectionNodes(section.rows, getNodes), [getNodes, section.rows]);
  const rowsById = useMemo(
    () => new Map(section.rows.map((row) => [row.id, row])),
    [section.rows]
  );

  // Space on a focused row toggles its switch (the checkbox-list pattern);
  // Space on a details row is not consumed.
  const handleSpace = useCallback(
    (nodeId: string): boolean => {
      const row = rowsById.get(nodeId);
      if (!row) {
        return false;
      }
      if (!busyModelIds.has(row.id)) {
        onToggleModel(row.id, !row.enabled);
      }
      return true;
    },
    [busyModelIds, onToggleModel, rowsById]
  );

  // Enter (TreeTable "activate") toggles the details row.
  const handleActivate = useCallback(
    (nodeId: string | null): void => {
      if (nodeId !== null && rowsById.has(nodeId)) {
        onToggleDetails(nodeId);
      }
    },
    [onToggleDetails, rowsById]
  );

  const shown = section.rows.length;
  const canEnable = section.rows.some((row) => !row.enabled);
  const canDisable = section.rows.some((row) => row.enabled);
  const { providerId } = section;

  return (
    <section className="border-b last:border-b-0" data-testid={`model-catalog-section-${providerId}`}>
      <div
        className={cn(
          'sticky top-0 flex h-11 items-center gap-3 border-b bg-card px-3',
          STICKY_SECTION_HEADER_LAYER_CLASS
        )}
        data-testid={`model-catalog-section-header-${providerId}`}
      >
        <h3 className="min-w-0">
          <button
            aria-controls={regionId}
            aria-expanded={expanded}
            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            data-testid={`model-catalog-section-toggle-${providerId}`}
            onClick={() => onToggleSection(providerId)}
            type="button"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
                expanded && 'rotate-90'
              )}
            />
            <ProviderTile providerId={providerId} />
            <span className="truncate font-semibold text-sm">{section.providerName}</span>
            {!compact && section.runtimeLabel ? (
              <Badge
                className="h-5 shrink-0 px-1.5 font-medium text-[10px] uppercase tracking-wide"
                variant="outline"
              >
                {section.runtimeLabel}
              </Badge>
            ) : null}
          </button>
        </h3>
        {compact ? null : <EnabledMeter enabled={section.enabledCount} total={section.totalCount} />}
        <span
          className="shrink-0 text-muted-foreground text-xs tabular-nums"
          data-testid={`model-catalog-section-count-${providerId}`}
        >
          <span className="font-semibold text-foreground">{section.enabledCount}</span> /{' '}
          {section.totalCount} enabled
        </span>
        {filtering ? (
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{shown} shown</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            data-testid={`model-catalog-enable-${providerId}`}
            disabled={!canEnable}
            onClick={() => onBulkChange(section, true)}
            size="xs"
            variant="ghost"
          >
            {filtering ? `Enable ${shown} shown` : 'Enable all'}
          </Button>
          <Button
            data-testid={`model-catalog-disable-${providerId}`}
            disabled={!canDisable}
            onClick={() => onBulkChange(section, false)}
            size="xs"
            variant="ghost"
          >
            {filtering ? `Disable ${shown} shown` : 'Disable all'}
          </Button>
        </div>
      </div>
      <div hidden={!expanded} id={regionId}>
        {expanded ? (
          <TreeTable
            ariaLabel={`${section.providerName} models`}
            columns={columns}
            expandedIds={detailsOpenIds}
            maxHeight="none"
            nodes={nodes}
            onCheckboxSpace={handleSpace}
            onSelect={handleActivate}
            onToggleExpand={onToggleDetails}
            overscan={8}
            rowClassName={rowClassName}
            rowHeight={ROW_HEIGHT_ESTIMATES}
            scrollParentRef={scrollParentRef}
            selectOnRowClick={false}
            selectedId={null}
            selectionMode="single"
            showHeader={false}
            windowingStrategy="virtual"
          />
        ) : null}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/catalog-section.test.tsx`

Expected: PASS.

- [ ] **Step 5: Mutation checks (revert after each)**

1. In `handleSpace`, change `onToggleModel(row.id, !row.enabled)` to `onToggleModel(row.id, row.enabled)`. "Space toggles the focused row" must fail.
2. Remove `STICKY_SECTION_HEADER_LAYER_CLASS` from the header's `cn(...)`. The sticky header test must fail.
3. Change `disabled={!canEnable}` to `disabled={false}`. "disables a bulk action with nothing to change" must fail.

After reverting, re-run Step 4 and confirm PASS.

- [ ] **Step 6: Record the new shared-scroller consumer in the contract**

In `docs/agents/ui-conventions.md`, § Scroll ownership, append this bullet after the existing second bullet (the one that begins "When MULTIPLE TreeTables stack in one scrolling column"):

```markdown
- The Model Catalog (`settings-ui/src/settings/models/model-catalog.tsx`) is the
  second shared-scroller consumer: one TreeTable per expanded provider section,
  ONE presentational column header above the scroller (Explorer forest shape),
  and in-flow `sticky top-0` provider headers layered with
  `STICKY_SECTION_HEADER_LAYER_CLASS`. Row pitch is pinned by
  `apps/web/e2e/settings-models-and-providers.test.ts`.
```

- [ ] **Step 7: Full lane and type-check**

Run:
- `pnpm --filter @brainstrike/settings-ui test`
- `node scripts/run-turbo-command.mjs -- run type-check --filter=@brainstrike/settings-ui`

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
pnpm exec biome check --write packages/settings-ui/src/settings/models/catalog-section.tsx packages/settings-ui/src/settings/models/__tests__/catalog-section.test.tsx
git add packages/settings-ui/src/settings/models/catalog-section.tsx packages/settings-ui/src/settings/models/__tests__/catalog-section.test.tsx docs/agents/ui-conventions.md
git commit -m "feat(BST-1805): add foldable provider sections with sticky headers and bulk actions

One windowed TreeTable per section in the shared scroller; Space toggles,
Enter and arrows open details; bulk actions scope to shown rows.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Toolbar — search, segments, capability chips, context and provider filters, result bar

**Files:**
- Create: `packages/settings-ui/src/settings/models/catalog-toolbar.tsx`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/catalog-toolbar.test.tsx`

**Interfaces:**
- Consumes:
  - From Task 2: `CatalogFilters`, `CatalogFilterChip`, `CatalogFilterKey`, `CatalogStatusFilter`, `CatalogTypeFilter`, `CatalogContextBand`, `CONTEXT_BAND_LABELS`, `CONTEXT_BAND_OPTIONS`, `parseContextBand`, `CatalogProviderStat`, `CatalogSummary`, `pluralNoun`.
  - `SettingsSearchIcon` and `SETTINGS_SEARCH_INPUT_STYLE` (existing, `../settings-search-*`).
- Produces: `CatalogToolbar(props: CatalogToolbarProps)`, with these props:
  - `chips: readonly CatalogFilterChip[]`
  - `compact: boolean`
  - `filters: CatalogFilters`
  - `onClearAll(): void`
  - `onClearChip(key: CatalogFilterKey): void`
  - `onCollapseAll(): void`
  - `onExpandAll(): void`
  - `onFiltersChange(next: CatalogFilters): void`
  - `providerOptions: readonly CatalogProviderStat[]`
  - `searchInputRef: RefObject<HTMLInputElement | null>`
  - `summary: CatalogSummary`
- Test ids:
  - `model-catalog-toolbar`
  - `model-catalog-search` (role `searchbox`, name "Search models")
  - `model-catalog-summary`
  - `model-catalog-clear-filters`
  - `model-catalog-providers-trigger`
  - `model-catalog-filters-trigger` (compact only)
  - `model-catalog-context-trigger`
  - `model-catalog-expand-all`
  - `model-catalog-collapse-all`

Behaviour (design §4):
- **Search:** `Esc` clears the query, and a second `Esc` blurs the field. The `/` hint is decorative; the `/` key itself is wired in Task 9.
- **Segments:** Status (All / Enabled / Disabled) and Type (All / Chat / Embedding, default All) are native radio groups. Arrow keys come for free, with no new primitive.
- **Chips:** Vision and Reasoning are `aria-pressed` toggle chips.
- **Context:** a `Select` with Any, ≥ 128K, ≥ 200K and ≥ 1M.
- **Providers:** a `Popover` holding a checkbox list with per-provider counts.
- **Compact mode (< 640 px):** Vision, Reasoning, Context and Providers collapse into ONE "Filters" popover with a count badge, and the search spans the full row.
- **Result bar:** `aria-live="polite"`. It reads `122 models · 10 providers · 27 enabled`, or `17 of 122 models match · 3 providers`. It shows removable chips and Clear filters, with Expand all / Collapse all at the right.
- No `transform` is added to any `PopoverTrigger`/`SelectTrigger`. `Button`'s own `kinetic-depress` rule already excludes open anchors.

- [ ] **Step 1: Write the failing tests**

Create `packages/settings-ui/src/settings/models/__tests__/catalog-toolbar.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CatalogFilters,
  DEFAULT_CATALOG_FILTERS,
  describeActiveFilters,
} from '../catalog-filters';
import type { CatalogProviderStat, CatalogSummary } from '../catalog-sections';
import { CatalogToolbar } from '../catalog-toolbar';
import { installCatalogDomStubs } from './catalog-dom-harness';

beforeAll(() => {
  installCatalogDomStubs({ width: null });
});

const PROVIDERS: CatalogProviderStat[] = [
  { enabledCount: 1, providerId: 'openai', providerName: 'OpenAI', totalCount: 15 },
  { enabledCount: 0, providerId: 'anthropic', providerName: 'Anthropic', totalCount: 7 },
];

const UNFILTERED: CatalogSummary = {
  enabledModels: 27,
  filtering: false,
  matchingModels: 122,
  matchingProviders: 10,
  totalModels: 122,
  totalProviders: 10,
};

const FILTERED: CatalogSummary = {
  enabledModels: 27,
  filtering: true,
  matchingModels: 17,
  matchingProviders: 3,
  totalModels: 122,
  totalProviders: 10,
};

function Harness({
  compact = false,
  initial = DEFAULT_CATALOG_FILTERS,
  onChange,
  summary = UNFILTERED,
}: {
  readonly compact?: boolean;
  readonly initial?: CatalogFilters;
  readonly onChange?: (next: CatalogFilters) => void;
  readonly summary?: CatalogSummary;
}) {
  const [filters, setFilters] = useState<CatalogFilters>(initial);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  return (
    <CatalogToolbar
      chips={describeActiveFilters(filters, new Map([['openai', 'OpenAI']]))}
      compact={compact}
      filters={filters}
      onClearAll={() => setFilters(DEFAULT_CATALOG_FILTERS)}
      onClearChip={vi.fn()}
      onCollapseAll={vi.fn()}
      onExpandAll={vi.fn()}
      onFiltersChange={(next) => {
        setFilters(next);
        onChange?.(next);
      }}
      providerOptions={PROVIDERS}
      searchInputRef={searchInputRef}
      summary={summary}
    />
  );
}

describe('CatalogToolbar', () => {
  it('summarises the unfiltered catalog', () => {
    render(<Harness />);
    expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent(
      '122 models · 10 providers · 27 enabled'
    );
    expect(screen.getByTestId('model-catalog-summary')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByTestId('model-catalog-clear-filters')).not.toBeInTheDocument();
  });

  it('summarises matches while filtering and offers Clear filters', () => {
    render(<Harness initial={{ ...DEFAULT_CATALOG_FILTERS, vision: true }} summary={FILTERED} />);
    expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent(
      '17 of 122 models match · 3 providers'
    );
    expect(screen.getByTestId('model-catalog-clear-filters')).toBeInTheDocument();
  });

  it('types into search, then Esc clears and a second Esc blurs', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const search = screen.getByRole('searchbox', { name: 'Search models' });
    await userEvent.type(search, 'claude');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'claude' }));
    await userEvent.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(search).not.toHaveFocus();
  });

  it('switches status and type with native radio groups (Type defaults to All)', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const type = screen.getByRole('radiogroup', { name: 'Type' });
    expect(within(type).getByRole('radio', { name: 'All' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Enabled' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'enabled' }));
    await userEvent.click(within(type).getByRole('radio', { name: 'Embedding' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'embedding' }));
  });

  it('toggles the Vision and Reasoning chips', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const vision = screen.getByRole('button', { name: 'Vision' });
    expect(vision).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(vision);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ vision: true }));
    expect(screen.getByRole('button', { name: 'Vision' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Reasoning' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ reasoning: true }));
  });

  it('filters by provider from the Providers popover', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByTestId('model-catalog-providers-trigger'));
    await userEvent.click(await screen.findByRole('checkbox', { name: /OpenAI/ }));
    const last = onChange.mock.lastCall?.[0] as CatalogFilters | undefined;
    expect([...(last?.providerIds ?? [])]).toEqual(['openai']);
  });

  it('removes one chip or clears every filter', async () => {
    const onClearChip = vi.fn();
    const filters: CatalogFilters = { ...DEFAULT_CATALOG_FILTERS, query: 'claude', vision: true };
    render(
      <CatalogToolbar
        chips={describeActiveFilters(filters, new Map())}
        compact={false}
        filters={filters}
        onClearAll={vi.fn()}
        onClearChip={onClearChip}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
        onFiltersChange={vi.fn()}
        providerOptions={PROVIDERS}
        searchInputRef={{ current: null }}
        summary={FILTERED}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter Vision' }));
    expect(onClearChip).toHaveBeenCalledWith('vision');
    expect(screen.getByText('"claude"')).toBeInTheDocument();
  });

  it('collapses Vision, Reasoning, Context and Providers into one Filters popover in compact mode', async () => {
    render(<Harness compact initial={{ ...DEFAULT_CATALOG_FILTERS, reasoning: true, vision: true }} />);
    expect(screen.queryByRole('button', { name: 'Vision' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-catalog-providers-trigger')).not.toBeInTheDocument();
    const trigger = screen.getByTestId('model-catalog-filters-trigger');
    expect(trigger).toHaveTextContent('Filters2');
    await userEvent.click(trigger);
    expect(await screen.findByRole('button', { name: 'Vision' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('checkbox', { name: /Anthropic/ })).toBeInTheDocument();
  });

  it('wires Expand all and Collapse all', async () => {
    const onExpandAll = vi.fn();
    const onCollapseAll = vi.fn();
    render(
      <CatalogToolbar
        chips={[]}
        compact={false}
        filters={DEFAULT_CATALOG_FILTERS}
        onClearAll={vi.fn()}
        onClearChip={vi.fn()}
        onCollapseAll={onCollapseAll}
        onExpandAll={onExpandAll}
        onFiltersChange={vi.fn()}
        providerOptions={PROVIDERS}
        searchInputRef={{ current: null }}
        summary={UNFILTERED}
      />
    );
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    await userEvent.click(screen.getByTestId('model-catalog-collapse-all'));
    expect(onExpandAll).toHaveBeenCalledTimes(1);
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/catalog-toolbar.test.tsx`

Expected: FAIL, because `../catalog-toolbar` does not resolve.

- [ ] **Step 3: Implement**

Create `packages/settings-ui/src/settings/models/catalog-toolbar.tsx`:

```tsx
import {
  Badge,
  Button,
  Checkbox,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, Eye, SlidersHorizontal, Sun, X } from 'lucide-react';
import { type ReactNode, type RefObject, useId } from 'react';
import { SettingsSearchIcon } from '../settings-search-icon';
import { SETTINGS_SEARCH_INPUT_STYLE } from '../settings-search-layout';
import {
  type CatalogContextBand,
  type CatalogFilterChip,
  type CatalogFilterKey,
  type CatalogFilters,
  type CatalogStatusFilter,
  type CatalogTypeFilter,
  CONTEXT_BAND_LABELS,
  CONTEXT_BAND_OPTIONS,
  parseContextBand,
} from './catalog-filters';
import { pluralNoun } from './catalog-format';
import type { CatalogProviderStat, CatalogSummary } from './catalog-sections';

interface SegmentOption<T extends string> {
  readonly label: string;
  readonly value: T;
}

const STATUS_OPTIONS: readonly SegmentOption<CatalogStatusFilter>[] = [
  { label: 'All', value: 'all' },
  { label: 'Enabled', value: 'enabled' },
  { label: 'Disabled', value: 'disabled' },
];

const TYPE_OPTIONS: readonly SegmentOption<CatalogTypeFilter>[] = [
  { label: 'All', value: 'all' },
  { label: 'Chat', value: 'chat' },
  { label: 'Embedding', value: 'embedding' },
];

/** A segmented control built from a native radio group: arrow keys and semantics come free. */
function Segmented<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  readonly label: string;
  readonly onChange: (next: T) => void;
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
}) {
  const name = useId();
  return (
    <div
      aria-label={label}
      className="inline-flex h-8 shrink-0 items-center rounded-lg border bg-muted/40 p-0.5"
      role="radiogroup"
    >
      {options.map((option) => (
        <label
          className="flex h-full cursor-pointer items-center rounded-md px-2.5 text-muted-foreground text-xs transition-colors has-[:checked]:bg-background has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50 has-[:checked]:text-foreground has-[:checked]:shadow-xs"
          key={option.value}
        >
          <input
            checked={value === option.value}
            className="sr-only"
            name={name}
            onChange={() => onChange(option.value)}
            type="radio"
            value={option.value}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

function ToggleChip({
  icon,
  label,
  onPressedChange,
  pressed,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly onPressedChange: (pressed: boolean) => void;
  readonly pressed: boolean;
}) {
  return (
    <Button
      aria-pressed={pressed}
      className={cn(
        'h-8 gap-1.5 px-3 text-xs',
        pressed && 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/15'
      )}
      onClick={() => onPressedChange(!pressed)}
      size="sm"
      variant="outline"
    >
      {icon}
      {label}
    </Button>
  );
}

function ContextSelect({
  onChange,
  value,
}: {
  readonly onChange: (next: CatalogContextBand) => void;
  readonly value: CatalogContextBand;
}) {
  return (
    <Select onValueChange={(next) => onChange(parseContextBand(next))} value={value}>
      <SelectTrigger
        aria-label="Minimum context window"
        className="w-auto gap-1.5 text-xs"
        data-testid="model-catalog-context-trigger"
        size="sm"
      >
        <span className="text-muted-foreground">Context:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CONTEXT_BAND_OPTIONS.map((band) => (
          <SelectItem key={band} value={band}>
            {CONTEXT_BAND_LABELS[band]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ProvidersList({
  onChange,
  options,
  selected,
}: {
  readonly onChange: (next: ReadonlySet<string>) => void;
  readonly options: readonly CatalogProviderStat[];
  readonly selected: ReadonlySet<string>;
}) {
  const toggle = (providerId: string, checked: boolean): void => {
    const next = new Set(selected);
    if (checked) {
      next.add(providerId);
    } else {
      next.delete(providerId);
    }
    onChange(next);
  };
  return (
    <div className="max-h-72 space-y-0.5 overflow-y-auto">
      {options.map((option) => (
        <label
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
          key={option.providerId}
        >
          <Checkbox
            checked={selected.has(option.providerId)}
            onCheckedChange={(checked) => toggle(option.providerId, checked === true)}
          />
          <span className="min-w-0 flex-1 truncate">{option.providerName}</span>
          <span className="text-muted-foreground text-xs tabular-nums">{option.totalCount}</span>
        </label>
      ))}
    </div>
  );
}

function ProvidersPopover({
  onChange,
  options,
  selected,
}: {
  readonly onChange: (next: ReadonlySet<string>) => void;
  readonly options: readonly CatalogProviderStat[];
  readonly selected: ReadonlySet<string>;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className="h-8 gap-1.5 px-3 text-xs"
          data-testid="model-catalog-providers-trigger"
          size="sm"
          variant="outline"
        >
          Providers
          <span className="text-muted-foreground">{selected.size === 0 ? 'All' : selected.size}</span>
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <ProvidersList onChange={onChange} options={options} selected={selected} />
      </PopoverContent>
    </Popover>
  );
}

function SummaryText({ summary }: { readonly summary: CatalogSummary }) {
  if (!summary.filtering) {
    return (
      <>
        <span className="font-semibold text-foreground">{summary.totalModels}</span>{' '}
        {pluralNoun(summary.totalModels, 'model')} · {summary.totalProviders}{' '}
        {pluralNoun(summary.totalProviders, 'provider')} ·{' '}
        <span className="font-semibold text-foreground">{summary.enabledModels}</span> enabled
      </>
    );
  }
  return (
    <>
      <span className="font-semibold text-foreground">{summary.matchingModels}</span> of{' '}
      {summary.totalModels} {pluralNoun(summary.totalModels, 'model')} match ·{' '}
      {summary.matchingProviders} {pluralNoun(summary.matchingProviders, 'provider')}
    </>
  );
}

export interface CatalogToolbarProps {
  readonly chips: readonly CatalogFilterChip[];
  /** Narrow tier (< 640px catalog width). */
  readonly compact: boolean;
  readonly filters: CatalogFilters;
  readonly onClearAll: () => void;
  readonly onClearChip: (key: CatalogFilterKey) => void;
  readonly onCollapseAll: () => void;
  readonly onExpandAll: () => void;
  readonly onFiltersChange: (next: CatalogFilters) => void;
  readonly providerOptions: readonly CatalogProviderStat[];
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  readonly summary: CatalogSummary;
}

export function CatalogToolbar({
  chips,
  compact,
  filters,
  onClearAll,
  onClearChip,
  onCollapseAll,
  onExpandAll,
  onFiltersChange,
  providerOptions,
  searchInputRef,
  summary,
}: CatalogToolbarProps) {
  const update = <K extends keyof CatalogFilters>(key: K, value: CatalogFilters[K]): void => {
    onFiltersChange({ ...filters, [key]: value });
  };

  const visionChip = (
    <ToggleChip
      icon={<Eye aria-hidden="true" className="size-3.5" />}
      label="Vision"
      onPressedChange={(pressed) => update('vision', pressed)}
      pressed={filters.vision}
    />
  );
  const reasoningChip = (
    <ToggleChip
      icon={<Sun aria-hidden="true" className="size-3.5" />}
      label="Reasoning"
      onPressedChange={(pressed) => update('reasoning', pressed)}
      pressed={filters.reasoning}
    />
  );
  const contextSelect = (
    <ContextSelect onChange={(band) => update('context', band)} value={filters.context} />
  );
  const activeFilterCount = [
    filters.vision,
    filters.reasoning,
    filters.context !== 'any',
    filters.providerIds.size > 0,
  ].filter(Boolean).length;

  return (
    <div className="flex shrink-0 flex-col gap-2" data-testid="model-catalog-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        <div className={cn('relative', compact ? 'w-full' : 'w-72 shrink-0')}>
          <SettingsSearchIcon />
          <Input
            aria-label="Search models"
            className="h-8 pr-8 text-sm"
            data-testid="model-catalog-search"
            onChange={(event) => update('query', event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') {
                return;
              }
              if (filters.query) {
                event.preventDefault();
                update('query', '');
                return;
              }
              event.currentTarget.blur();
            }}
            placeholder="Search name, id, provider…"
            ref={searchInputRef}
            role="searchbox"
            style={SETTINGS_SEARCH_INPUT_STYLE}
            value={filters.query}
          />
          <kbd
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground"
          >
            /
          </kbd>
        </div>
        <Segmented
          label="Status"
          onChange={(status) => update('status', status)}
          options={STATUS_OPTIONS}
          value={filters.status}
        />
        <Segmented
          label="Type"
          onChange={(type) => update('type', type)}
          options={TYPE_OPTIONS}
          value={filters.type}
        />
        {compact ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                className="h-8 gap-1.5 px-3 text-xs"
                data-testid="model-catalog-filters-trigger"
                size="sm"
                variant="outline"
              >
                <SlidersHorizontal aria-hidden="true" className="size-3.5" />
                Filters
                {activeFilterCount > 0 ? (
                  <Badge className="h-4 px-1 text-[10px]" variant="secondary">
                    {activeFilterCount}
                  </Badge>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-3 p-3">
              <div className="flex flex-wrap items-center gap-2">
                {visionChip}
                {reasoningChip}
                {contextSelect}
              </div>
              <div className="space-y-1">
                <p className="font-medium text-muted-foreground text-xs">Providers</p>
                <ProvidersList
                  onChange={(ids) => update('providerIds', ids)}
                  options={providerOptions}
                  selected={filters.providerIds}
                />
              </div>
            </PopoverContent>
          </Popover>
        ) : (
          <>
            {visionChip}
            {reasoningChip}
            {contextSelect}
            <ProvidersPopover
              onChange={(ids) => update('providerIds', ids)}
              options={providerOptions}
              selected={filters.providerIds}
            />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <p aria-live="polite" className="text-muted-foreground" data-testid="model-catalog-summary">
          <SummaryText summary={summary} />
        </p>
        {chips.map((chip) => (
          <span
            className="inline-flex h-6 items-center gap-1 rounded-full border bg-muted/40 pr-1 pl-2.5"
            key={chip.key}
          >
            {chip.label}
            <button
              aria-label={`Remove filter ${chip.label}`}
              className="rounded-full p-0.5 hover:bg-accent"
              onClick={() => onClearChip(chip.key)}
              type="button"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </span>
        ))}
        {summary.filtering ? (
          <Button
            className="h-6 px-1.5 text-xs"
            data-testid="model-catalog-clear-filters"
            onClick={onClearAll}
            size="xs"
            variant="link"
          >
            Clear filters
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button data-testid="model-catalog-expand-all" onClick={onExpandAll} size="xs" variant="ghost">
            <ChevronsUpDown aria-hidden="true" />
            Expand all
          </Button>
          <Button
            data-testid="model-catalog-collapse-all"
            onClick={onCollapseAll}
            size="xs"
            variant="ghost"
          >
            <ChevronsDownUp aria-hidden="true" />
            Collapse all
          </Button>
        </div>
      </div>
    </div>
  );
}
```

Note: the kbd hint's `-translate-y-1/2` is on a non-interactive decoration, not on a popup anchor.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/catalog-toolbar.test.tsx`

Expected: PASS.

- [ ] **Step 5: Mutation checks (revert after each)**

1. In the search `onKeyDown`, delete the `if (filters.query) { … }` block. "Esc clears and a second Esc blurs" must fail.
2. Change `compact ? ( <Popover>…` so it always renders the non-compact branch (replace the condition with `false`). The compact test must fail.

After reverting, re-run Step 4 and confirm PASS.

- [ ] **Step 6: Full lane and type-check**

Run:
- `pnpm --filter @brainstrike/settings-ui test`
- `node scripts/run-turbo-command.mjs -- run type-check --filter=@brainstrike/settings-ui`

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write packages/settings-ui/src/settings/models/catalog-toolbar.tsx packages/settings-ui/src/settings/models/__tests__/catalog-toolbar.test.tsx
git add packages/settings-ui/src/settings/models/catalog-toolbar.tsx packages/settings-ui/src/settings/models/__tests__/catalog-toolbar.test.tsx
git commit -m "feat(BST-1805): add the Model Catalog filter toolbar and result bar

Search with Esc clear, status/type segments, Vision/Reasoning chips,
context bands, provider picker, live counts and removable chips; one
compact Filters popover below 640px.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Compose the catalog — scroll owner, width tier, `/` shortcut, page, header actions, app wiring

**Files:**
- Create: `packages/settings-ui/src/settings/models/model-catalog.tsx`
- Create: `packages/settings-ui/src/settings/models/model-cache-directory-popover.tsx`
- Modify (full replacement): `packages/settings-ui/src/settings/models/model-selection-page.tsx`
- Delete: `packages/settings-ui/src/settings/models/model-list.tsx`
- Delete: `packages/settings-ui/src/settings/models/__tests__/model-list.test.tsx`
- Modify: `apps/web/src/app/settings/page-content.tsx` (the Model Catalog category entry and its imports)
- Modify: `apps/desktop/src/renderer/components/settings/page-content.tsx` (the Model Catalog category entry and its imports)
- Modify (mock only):
  - `apps/web/src/app/settings/__tests__/page-content.test.tsx`
  - `apps/web/src/app/__tests__/document-title.test.tsx`
  - `apps/desktop/src/__tests__/renderer/components/settings/page-content.test.tsx`
  - `apps/desktop/src/__tests__/renderer/components/settings/page-content-operations.test.tsx`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/model-catalog.test.tsx`
- Test (create): `packages/settings-ui/src/settings/models/__tests__/model-cache-directory-popover.test.tsx`

**Interfaces:**
- Consumes: every earlier task's exports. The exact names are imported in the code below.
- Produces:
  - `ModelCatalog(props: ModelCatalogProps)`, with these props:
    - `busyModelIds`
    - `downloadedModels`
    - `downloadProgress`
    - `isDownloading`
    - `loaded: boolean`
    - `modelCacheDir: string | null`
    - `models: readonly DbModel[]`
    - `onBulkChange(change: ModelBulkChange): void`
    - `onDownload(modelId): void`
    - `onRefresh(): void`
    - `onToggle(modelId, enabled): void`
    - `providers: readonly DbProvider[]`
  - `ModelCacheDirectoryPopover()`.
  - `model-selection-page.tsx` exports exactly two components: `ModelSelectionPage()` (no props) and `ModelCatalogHeaderActions()`.
- Test ids: `model-catalog` (with `data-width-tier`), `model-catalog-scroll`, `model-catalog-empty`, `model-catalog-no-matches`, `model-cache-dir-trigger`, `model-cache-dir-input`, `model-cache-dir-select`, `model-registry-refresh`, `model-registry-error`, `model-registry-retry`.

Composition contract:
- **Scroll owner:** `model-catalog-scroll` is the ONE scroll owner. Every expanded `CatalogSection` receives it as `scrollParentRef`, and `CatalogColumnHeader` sits above it and measures its gutter.
- **Width tier:** the tier is measured on the catalog CONTAINER with `useResizeObserver` (a container query, not a viewport media query). Until the first measurement lands (one frame), the layout is `wide`.
- **Search:** it is deferred with `useDeferredValue`. The deferred query drives filtering and highlighting; the chips reflect the immediate filters.
- **`/` shortcut:** it focuses search unless focus is already in an editable element. Settings is a keep-mounted shell tab (`root-layout-content.tsx` `KeepMountedRoute`), so the handler also ignores `/` while the catalog sits under an `aria-hidden` route.

- [ ] **Step 1: Write the failing tests**

Create `packages/settings-ui/src/settings/models/__tests__/model-catalog.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalog, type ModelCatalogProps } from '../model-catalog';
import { installCatalogDomStubs } from './catalog-dom-harness';
import { makeDbModel, makeDbProvider } from './catalog-test-harness';

vi.mock('@tanstack/react-virtual', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual');
  const { createMockCatalogVirtualizer } =
    await vi.importActual<typeof import('./catalog-dom-harness')>('./catalog-dom-harness');
  return { ...actual, useVirtualizer: createMockCatalogVirtualizer };
});

const PROVIDERS = [
  makeDbProvider('openai', 'OpenAI', 0),
  makeDbProvider('anthropic', 'Anthropic', 1),
  makeDbProvider('openrouter', 'OpenRouter', 2),
];

// Real registry ids, so the projection joins real facts.
const MODELS = [
  makeDbModel({ id: 'gpt-5.6-terra', isEnabled: true, name: 'GPT-5.6 Terra', providerId: 'openai', sortOrder: 0 }),
  makeDbModel({
    capabilities: { defaultDimension: 1536, type: 'embedding' },
    id: 'text-embedding-3-small',
    name: 'text-embedding-3-small',
    providerId: 'openai',
    sortOrder: 1,
  }),
  makeDbModel({ id: 'claude-opus-5', name: 'Claude Opus 5', providerId: 'anthropic', sortOrder: 2 }),
  makeDbModel({ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', providerId: 'anthropic', sortOrder: 3 }),
  makeDbModel({ id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', providerId: 'openrouter', sortOrder: 4 }),
];

function catalogProps(overrides: Partial<ModelCatalogProps> = {}): ModelCatalogProps {
  return {
    busyModelIds: new Set<string>(),
    downloadedModels: {},
    downloadProgress: {},
    isDownloading: {},
    loaded: true,
    modelCacheDir: null,
    models: MODELS,
    onBulkChange: vi.fn(),
    onDownload: vi.fn(),
    onRefresh: vi.fn(),
    onToggle: vi.fn(),
    providers: PROVIDERS,
    ...overrides,
  };
}

function sectionToggle(providerId: string): HTMLElement {
  return screen.getByTestId(`model-catalog-section-toggle-${providerId}`);
}

function search(): HTMLElement {
  return screen.getByRole('searchbox', { name: 'Search models' });
}

beforeEach(() => {
  installCatalogDomStubs({ width: null });
});

afterEach(() => {
  installCatalogDomStubs({ width: null });
});

describe('ModelCatalog default view', () => {
  it('expands providers with an enabled model and collapses the rest', () => {
    render(<ModelCatalog {...catalogProps()} />);
    expect(sectionToggle('openai')).toHaveAttribute('aria-expanded', 'true');
    expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
    expect(sectionToggle('openrouter')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('model-row-gpt-5.6-terra')).toBeInTheDocument();
    expect(screen.queryByTestId('model-row-claude-opus-5')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent(
      '5 models · 3 providers · 1 enabled'
    );
  });

  it('expands the first provider when nothing is enabled anywhere', () => {
    render(
      <ModelCatalog
        {...catalogProps({ models: MODELS.map((model) => ({ ...model, isEnabled: false })) })}
      />
    );
    expect(sectionToggle('openai')).toHaveAttribute('aria-expanded', 'true');
    expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps Type at All and tags embedding rows, until Chat is chosen', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    expect(
      within(screen.getByTestId('model-row-text-embedding-3-small')).getByText('Embedding')
    ).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Type' })).getByRole('radio', { name: 'Chat' })
    );
    await waitFor(() => {
      expect(screen.queryByTestId('model-row-text-embedding-3-small')).not.toBeInTheDocument();
    });
  });

  it('keeps row order stable when a model is toggled', async () => {
    const props = catalogProps();
    const { rerender } = render(<ModelCatalog {...props} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Enable text-embedding-3-small' }));
    expect(props.onToggle).toHaveBeenCalledWith('text-embedding-3-small', true);
    rerender(
      <ModelCatalog
        {...props}
        models={MODELS.map((model) =>
          model.id === 'text-embedding-3-small' ? { ...model, isEnabled: true } : model
        )}
      />
    );
    const openai = screen.getByTestId('model-catalog-section-openai');
    expect(
      Array.from(openai.querySelectorAll('[data-testid^="model-row-"]'), (element) =>
        element.getAttribute('data-testid')
      )
    ).toEqual(['model-row-gpt-5.6-terra', 'model-row-text-embedding-3-small']);
  });

  it('opens a details row from the row disclosure', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show details for GPT-5.6 Terra' }));
    expect(await screen.findByTestId('model-details-gpt-5.6-terra')).toBeInTheDocument();
  });

  it('sorts rows within a section from the column header', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    await userEvent.click(screen.getByRole('button', { name: 'Context: sort ascending' }));
    const anthropic = screen.getByTestId('model-catalog-section-anthropic');
    expect(
      Array.from(anthropic.querySelectorAll('[data-testid^="model-row-"]'), (element) =>
        element.getAttribute('data-testid')
      )
    ).toEqual(['model-row-claude-sonnet-4-6', 'model-row-claude-opus-5']);
  });
});

describe('ModelCatalog filtering', () => {
  it('expands every matching section, hides the rest, and restores the manual set on clear', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.type(search(), 'claude');
    expect(await screen.findByTestId('model-row-claude-opus-5')).toBeInTheDocument();
    expect(screen.queryByTestId('model-catalog-section-openai')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent(
      '2 of 5 models match · 1 provider'
    );
    await userEvent.click(screen.getByTestId('model-catalog-clear-filters'));
    await waitFor(() => {
      expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
    });
    expect(sectionToggle('openai')).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps a section the user collapsed during a filter session collapsed until filters clear', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.type(search(), 'claude');
    await screen.findByTestId('model-row-claude-opus-5');
    await userEvent.click(sectionToggle('anthropic'));
    expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
    await userEvent.type(search(), ' sonnet');
    await waitFor(() => {
      expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent('1 of 5 models match');
    });
    expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
  });

  it('bulk-enables only the shown rows that would change', async () => {
    const props = catalogProps({
      models: MODELS.map((model) =>
        model.id === 'claude-sonnet-4-6' ? { ...model, isEnabled: true } : model
      ),
    });
    render(<ModelCatalog {...props} />);
    await userEvent.type(search(), 'claude');
    await userEvent.click(await screen.findByRole('button', { name: 'Enable 2 shown' }));
    expect(props.onBulkChange).toHaveBeenCalledWith({
      enabled: true,
      modelIds: ['claude-opus-5'],
      scopeLabel: 'Anthropic',
    });
  });

  it('never lets a bulk action reach a row the filter hides', async () => {
    const props = catalogProps({
      models: MODELS.map((model) =>
        model.id === 'claude-sonnet-4-6' ? { ...model, isEnabled: true } : model
      ),
    });
    render(<ModelCatalog {...props} />);
    await userEvent.type(search(), 'opus');
    // Sonnet is enabled but hidden by the search, so "Disable 1 shown" has nothing to do.
    expect(await screen.findByRole('button', { name: 'Disable 1 shown' })).toBeDisabled();
  });

  it('shows No models match with a working Clear filters action', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.type(search(), 'zzzz');
    const empty = await screen.findByTestId('model-catalog-no-matches');
    expect(within(empty).getByText('No models match')).toBeInTheDocument();
    await userEvent.click(within(empty).getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByTestId('model-row-gpt-5.6-terra')).toBeInTheDocument();
  });
});

describe('ModelCatalog states', () => {
  it('shows the empty catalog state with Refresh once loaded', async () => {
    const props = catalogProps({ models: [] });
    render(<ModelCatalog {...props} />);
    const empty = screen.getByTestId('model-catalog-empty');
    expect(within(empty).getByText('No models are catalogued yet')).toBeInTheDocument();
    await userEvent.click(within(empty).getByRole('button', { name: 'Refresh' }));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows a loading status before the first load', () => {
    render(<ModelCatalog {...catalogProps({ loaded: false, models: [] })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading models…');
  });

  it('switches to the compact layout when the catalog is narrower than 640px', async () => {
    installCatalogDomStubs({ width: 500 });
    render(<ModelCatalog {...catalogProps()} />);
    await waitFor(() => {
      expect(screen.getByTestId('model-catalog')).toHaveAttribute('data-width-tier', 'narrow');
    });
    expect(screen.getByTestId('model-catalog-filters-trigger')).toBeInTheDocument();
    expect(screen.queryByText(/per million tokens/)).not.toBeInTheDocument();
  });
});

describe('ModelCatalog / shortcut', () => {
  it('focuses search on / from a non-editable target', () => {
    render(<ModelCatalog {...catalogProps()} />);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(search()).toHaveFocus();
  });

  it('leaves / alone while typing in another field', () => {
    render(
      <>
        <input aria-label="Other field" />
        <ModelCatalog {...catalogProps()} />
      </>
    );
    const other = screen.getByRole('textbox', { name: 'Other field' });
    other.focus();
    fireEvent.keyDown(other, { key: '/' });
    expect(other).toHaveFocus();
  });

  it('ignores / while the settings route is hidden (keep-mounted tab)', () => {
    render(
      <div aria-hidden="true">
        <ModelCatalog {...catalogProps()} />
      </div>
    );
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(document.body);
  });
});
```

Create `packages/settings-ui/src/settings/models/__tests__/model-cache-directory-popover.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installCatalogDomStubs } from './catalog-dom-harness';

const toast = vi.fn();

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ toast }),
}));
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => null }));

import { ModelCacheDirectoryPopover } from '../model-cache-directory-popover';

describe('ModelCacheDirectoryPopover', () => {
  beforeEach(() => {
    installCatalogDomStubs({ width: null });
    toast.mockReset();
    __resetModelRegistryStoreForTests();
  });

  it('shows the current cache directory on the trigger', () => {
    render(<ModelCacheDirectoryPopover />);
    expect(screen.getByTestId('model-cache-dir-trigger')).toHaveTextContent('Local cacheSystem default');
    act(() => {
      useModelRegistryStore.setState({ modelCacheDir: '/models' });
    });
    expect(screen.getByTestId('model-cache-dir-trigger')).toHaveTextContent('Local cache/models');
  });

  it('edits the directory from the popover', async () => {
    render(<ModelCacheDirectoryPopover />);
    await userEvent.click(screen.getByTestId('model-cache-dir-trigger'));
    await userEvent.type(await screen.findByTestId('model-cache-dir-input'), '/data');
    expect(useModelRegistryStore.getState().modelCacheDir).toBe('/data');
  });

  it('reports that directory selection is unavailable without the desktop bridge', async () => {
    render(<ModelCacheDirectoryPopover />);
    await userEvent.click(screen.getByTestId('model-cache-dir-trigger'));
    await userEvent.click(await screen.findByTestId('model-cache-dir-select'));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Directory selection unavailable', variant: 'destructive' })
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/model-catalog.test.tsx src/settings/models/__tests__/model-cache-directory-popover.test.tsx`

Expected: FAIL, because `../model-catalog` and `../model-cache-directory-popover` do not resolve.

- [ ] **Step 3: Implement `model-catalog.tsx`**

Create `packages/settings-ui/src/settings/models/model-catalog.tsx`:

```tsx
import type { DbModel, DbProvider } from '@brainstrike/app-state/stores/model-registry-store';
import { Button, EmptyState, useResizeObserver } from '@brainstrike/ui';
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CatalogColumnHeader } from './catalog-column-header';
import {
  type CatalogWidthTier,
  getCatalogColumnLayout,
  getCatalogColumns,
  resolveCatalogWidthTier,
} from './catalog-columns';
import {
  type CatalogFilterKey,
  type CatalogFilters,
  clearCatalogFilter,
  DEFAULT_CATALOG_FILTERS,
  describeActiveFilters,
} from './catalog-filters';
import { createCatalogNodeCache } from './catalog-nodes';
import { createCatalogProjector } from './catalog-projection';
import { CatalogSection } from './catalog-section';
import {
  buildCatalogView,
  type CatalogSection as CatalogSectionModel,
  type CatalogSort,
  UNKNOWN_PROVIDER_NAME,
} from './catalog-sections';
import { CatalogToolbar } from './catalog-toolbar';
import { useCatalogExpansion } from './use-catalog-expansion';
import { type CatalogRowActions, CatalogRowActionsContext } from './use-catalog-row-actions';
import type { ModelBulkChange } from './use-model-bulk-toggle';

const NO_IDS: ReadonlySet<string> = new Set<string>();
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE_SELECTOR) !== null;
}

export interface ModelCatalogProps {
  readonly busyModelIds: ReadonlySet<string>;
  readonly downloadedModels: Readonly<Record<string, boolean>>;
  readonly downloadProgress: Readonly<Record<string, number>>;
  readonly isDownloading: Readonly<Record<string, boolean>>;
  /** The registry has loaded at least once (distinguishes loading from empty). */
  readonly loaded: boolean;
  readonly modelCacheDir: string | null;
  readonly models: readonly DbModel[];
  readonly onBulkChange: (change: ModelBulkChange) => void;
  readonly onDownload: (modelId: string) => void;
  readonly onRefresh: () => void;
  readonly onToggle: (modelId: string, enabled: boolean) => void;
  readonly providers: readonly DbProvider[];
}

/**
 * The Model Catalog (BST-1805): toolbar, one presentational column header, and
 * ONE scroll owner holding a windowed TreeTable per expanded provider section
 * (shared-scroller mode, docs/agents/ui-conventions.md).
 */
export function ModelCatalog({
  busyModelIds,
  downloadedModels,
  downloadProgress,
  isDownloading,
  loaded,
  modelCacheDir,
  models,
  onBulkChange,
  onDownload,
  onRefresh,
  onToggle,
  providers,
}: ModelCatalogProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Container query, not a viewport media query (design §5). Until the first
  // measurement lands (one frame) the catalog lays out as wide.
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  useResizeObserver(
    rootRef,
    useCallback((entry: ResizeObserverEntry) => {
      setMeasuredWidth(entry.contentRect.width);
    }, [])
  );
  const tier: CatalogWidthTier =
    measuredWidth === null ? 'wide' : resolveCatalogWidthTier(measuredWidth);

  const [filters, setFilters] = useState<CatalogFilters>(DEFAULT_CATALOG_FILTERS);
  const deferredQuery = useDeferredValue(filters.query);
  const effectiveFilters = useMemo(
    () => ({ ...filters, query: deferredQuery }),
    [filters, deferredQuery]
  );
  const [sort, setSort] = useState<CatalogSort | null>(null);
  const [detailsOpenIds, setDetailsOpenIds] = useState<ReadonlySet<string>>(NO_IDS);
  const [project] = useState(createCatalogProjector);
  const [getNodes] = useState(createCatalogNodeCache);

  const providerNames = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.name])),
    [providers]
  );
  const rows = useMemo(
    () =>
      models.map((model) =>
        project(model, providerNames.get(model.providerId) ?? UNKNOWN_PROVIDER_NAME)
      ),
    [models, project, providerNames]
  );
  const view = useMemo(
    () => buildCatalogView({ filters: effectiveFilters, providers, rows, sort }),
    [effectiveFilters, providers, rows, sort]
  );
  const filtering = view.summary.filtering;
  const visibleSectionIds = useMemo(
    () => view.sections.map((section) => section.providerId),
    [view.sections]
  );
  const expansion = useCatalogExpansion({
    filtering,
    providerStats: view.providerStats,
    visibleSectionIds,
  });
  const chips = useMemo(() => describeActiveFilters(filters, providerNames), [filters, providerNames]);

  const toggleDetails = useCallback((modelId: string): void => {
    setDetailsOpenIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  }, []);

  // Bulk actions only ever touch SHOWN rows, and only those that would change.
  const handleBulk = useCallback(
    (section: CatalogSectionModel, enabled: boolean): void => {
      onBulkChange({
        enabled,
        modelIds: section.rows.filter((row) => row.enabled !== enabled).map((row) => row.id),
        scopeLabel: section.providerName,
      });
    },
    [onBulkChange]
  );

  const clearChip = useCallback((key: CatalogFilterKey): void => {
    setFilters((current) => clearCatalogFilter(current, key));
  }, []);
  const clearAll = useCallback((): void => {
    setFilters(DEFAULT_CATALOG_FILTERS);
  }, []);

  const rowActions = useMemo<CatalogRowActions>(
    () => ({
      busyModelIds,
      downloadedModels,
      downloadProgress,
      isDownloading,
      modelCacheDir,
      onDownload,
      onToggle,
      onToggleDetails: toggleDetails,
      query: deferredQuery,
      showTagline: tier !== 'narrow',
      showTypeTag: filters.type === 'all',
    }),
    [
      busyModelIds,
      deferredQuery,
      downloadedModels,
      downloadProgress,
      filters.type,
      isDownloading,
      modelCacheDir,
      onDownload,
      onToggle,
      tier,
      toggleDetails,
    ]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const input = searchInputRef.current;
      // Settings is a keep-mounted shell tab: while another tab shows, this
      // catalog stays mounted under an aria-hidden route and must not steal `/`.
      if (!input || input.closest('[aria-hidden="true"]') !== null || isEditableTarget(event.target)) {
        return;
      }
      event.preventDefault();
      input.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const columns = getCatalogColumns(tier);
  let body: ReactNode;
  if (models.length === 0) {
    body = loaded ? (
      <EmptyState
        action={
          <Button onClick={onRefresh} size="sm" variant="outline">
            Refresh
          </Button>
        }
        data-testid="model-catalog-empty"
        description="Refresh the registry to load the catalogue."
        title="No models are catalogued yet"
      />
    ) : (
      <p className="p-6 text-muted-foreground text-sm" role="status">
        Loading models…
      </p>
    );
  } else if (view.sections.length === 0) {
    body = (
      <EmptyState
        action={
          <Button onClick={clearAll} size="sm" variant="outline">
            Clear filters
          </Button>
        }
        data-testid="model-catalog-no-matches"
        description="Try a different search or remove a filter."
        title="No models match"
      />
    );
  } else {
    body = view.sections.map((section) => (
      <CatalogSection
        busyModelIds={busyModelIds}
        columns={columns}
        compact={tier === 'narrow'}
        detailsOpenIds={detailsOpenIds}
        expanded={expansion.expandedSectionIds.has(section.providerId)}
        filtering={filtering}
        getNodes={getNodes}
        key={section.providerId}
        onBulkChange={handleBulk}
        onToggleDetails={toggleDetails}
        onToggleModel={onToggle}
        onToggleSection={expansion.toggleSection}
        scrollParentRef={scrollRef}
        section={section}
      />
    ));
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3"
      data-testid="model-catalog"
      data-width-tier={tier}
      ref={rootRef}
    >
      <CatalogToolbar
        chips={chips}
        compact={tier === 'narrow'}
        filters={filters}
        onClearAll={clearAll}
        onClearChip={clearChip}
        onCollapseAll={expansion.collapseAll}
        onExpandAll={expansion.expandAll}
        onFiltersChange={setFilters}
        providerOptions={view.providerStats}
        searchInputRef={searchInputRef}
        summary={view.summary}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
        <CatalogColumnHeader
          layout={getCatalogColumnLayout(tier)}
          onSortChange={setSort}
          scrollerRef={scrollRef}
          sort={sort}
        />
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="model-catalog-scroll" ref={scrollRef}>
          <CatalogRowActionsContext value={rowActions}>{body}</CatalogRowActionsContext>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `model-cache-directory-popover.tsx`**

This MOVES the cache-directory code out of `model-selection-page.tsx`. `applySelectedCacheDirectory`, `applyCacheDirectorySelectionTestOverride` and the body of `handleSelectCacheDir` are verbatim from that file; only their container changes.

Create `packages/settings-ui/src/settings/models/model-cache-directory-popover.tsx`:

```tsx
import { resolveCacheDirectorySelectionTestOverride } from '@brainstrike/app-state/automation-overrides';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import {
  Button,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useToast,
} from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

const logger = createLogger('ModelCacheDirectoryPopover');

type ToastFn = ReturnType<typeof useToast>['toast'];

function applySelectedCacheDirectory(args: {
  db: ReturnType<typeof usePGliteDatabase>;
  fetchRegistry: (db: NonNullable<ReturnType<typeof usePGliteDatabase>>) => Promise<void>;
  selectedPath: string;
  setModelCacheDir: (dir: string) => void;
  toast: ToastFn;
}): void {
  args.setModelCacheDir(args.selectedPath);
  args.toast({
    description: args.selectedPath,
    title: 'Cache directory updated',
  });
  if (args.db) {
    void args.fetchRegistry(args.db).catch((error: unknown) => {
      logger.warn('Failed to refresh model registry after cache directory change', { error });
    });
  }
}

function applyCacheDirectorySelectionTestOverride(args: {
  db: ReturnType<typeof usePGliteDatabase>;
  fetchRegistry: (db: NonNullable<ReturnType<typeof usePGliteDatabase>>) => Promise<void>;
  setModelCacheDir: (dir: string) => void;
  toast: ToastFn;
}): boolean {
  const resolution = resolveCacheDirectorySelectionTestOverride();
  if (resolution.kind === 'none') {
    return false;
  }

  switch (resolution.kind) {
    case 'unavailable':
      args.toast({
        description: 'Choose a cache directory from the desktop app.',
        title: 'Directory selection unavailable',
        variant: 'destructive',
      });
      return true;
    case 'error':
      args.toast({
        description: resolution.message,
        title: 'Directory selection failed',
        variant: 'destructive',
      });
      return true;
    case 'cancelled':
      args.toast({
        description: 'Please choose a folder to store local model files.',
        title: 'No directory selected',
        variant: 'destructive',
      });
      return true;
    case 'selected':
      applySelectedCacheDirectory({
        db: args.db,
        fetchRegistry: args.fetchRegistry,
        selectedPath: resolution.path,
        setModelCacheDir: args.setModelCacheDir,
        toast: args.toast,
      });
      return true;
    default: {
      const exhaustiveResolution: never = resolution;
      return exhaustiveResolution;
    }
  }
}

/**
 * The local model cache directory, compacted into a header button that shows
 * the current value and opens the original form (design §3.1).
 */
export function ModelCacheDirectoryPopover() {
  const db = usePGliteDatabase();
  const { fetchRegistry, modelCacheDir, setModelCacheDir } = useModelRegistryStore(
    useShallow((state) => ({
      fetchRegistry: state.fetchRegistry,
      modelCacheDir: state.modelCacheDir,
      setModelCacheDir: state.setModelCacheDir,
    }))
  );
  const { toast } = useToast();
  const [isSelectingCacheDir, setIsSelectingCacheDir] = useState<boolean>(false);

  const handleSelectCacheDir = async (): Promise<void> => {
    if (
      applyCacheDirectorySelectionTestOverride({
        db,
        fetchRegistry,
        setModelCacheDir,
        toast,
      })
    ) {
      return;
    }

    const requestDirectoryAccess = (
      window as unknown as {
        electronAPI?: {
          fileSystem?: { requestDirectoryAccess?: () => Promise<{ path?: string }> };
        };
      }
    ).electronAPI?.fileSystem?.requestDirectoryAccess;

    if (typeof requestDirectoryAccess !== 'function') {
      toast({
        description: 'Choose a cache directory from the desktop app.',
        title: 'Directory selection unavailable',
        variant: 'destructive',
      });
      return;
    }

    setIsSelectingCacheDir(true);

    let selectedPath = '';
    try {
      const handle = await requestDirectoryAccess();
      if (typeof handle.path === 'string') {
        selectedPath = handle.path;
      }
    } catch (err) {
      logger.error('Failed to select cache directory', err);
      toast({
        description: (err as Error).message,
        title: 'Directory selection failed',
        variant: 'destructive',
      });
      setIsSelectingCacheDir(false);
      return;
    }

    if (!selectedPath) {
      toast({
        description: 'Please choose a folder to store local model files.',
        title: 'No directory selected',
        variant: 'destructive',
      });
      setIsSelectingCacheDir(false);
      return;
    }

    applySelectedCacheDirectory({
      db,
      fetchRegistry,
      selectedPath,
      setModelCacheDir,
      toast,
    });
    setIsSelectingCacheDir(false);
  };

  // An empty value IS the system default (the form's documented meaning).
  const currentLabel = modelCacheDir || 'System default';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className="h-8 max-w-80 gap-2 px-3 text-xs"
          data-testid="model-cache-dir-trigger"
          size="sm"
          variant="outline"
        >
          <Folder aria-hidden="true" className="size-3.5" />
          <span>Local cache</span>
          <span className="min-w-0 truncate font-mono text-muted-foreground" title={currentLabel}>
            {currentLabel}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-2 p-3">
        <Label htmlFor="model-cache-dir">Local model cache directory</Label>
        <div className="flex gap-2">
          <Input
            className="font-mono text-xs"
            data-testid="model-cache-dir-input"
            id="model-cache-dir"
            onChange={(e) => setModelCacheDir(e.target.value)}
            placeholder="System default (Transformers.js cache)"
            value={modelCacheDir || ''}
          />
          <Button
            aria-label="Select Model Cache Directory"
            data-testid="model-cache-dir-select"
            disabled={isSelectingCacheDir}
            onClick={handleSelectCacheDir}
            size="icon"
            title="Select Directory"
            variant="outline"
          >
            <Folder className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Stored on disk for local models only. Leave blank to use the system cache directory.
        </p>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 5: Replace `model-selection-page.tsx`**

Replace the whole of `packages/settings-ui/src/settings/models/model-selection-page.tsx` with the following. The download helpers are verbatim from the current file; the cache-directory code moved to the popover; the list is now `ModelCatalog`.

```tsx
import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import type { DbModel } from '@brainstrike/app-state/stores/model-registry-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import type { EmbeddingModelConfig as ModelConfig } from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import { Button, cn, useToast } from '@brainstrike/ui';
import { RefreshCw } from 'lucide-react';
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ModelCacheDirectoryPopover } from './model-cache-directory-popover';
import { ModelCatalog } from './model-catalog';
import { getModelRuntimeServices } from './model-runtime-services';
import { type ModelBulkChange, useModelBulkToggle } from './use-model-bulk-toggle';
import { useModelToggle } from './use-model-toggle';

const logger = createLogger('ModelSelectionPage');

type ToastFn = ReturnType<typeof useToast>['toast'];

interface DownloadDeps {
  modelCacheDir: string | null;
  setDownloading: (modelId: string, isDownloading: boolean) => void;
  setDownloadProgress: (modelId: string, progress: number) => void;
  toast: ToastFn;
}

interface DownloadProgress {
  progress?: number;
}

function readQuantizedFlag(parameters: Record<string, unknown> | null): boolean {
  const value = parameters?.['quantized'];
  return typeof value === 'boolean' ? value : false;
}

function buildModelConfig(model: DbModel): ModelConfig {
  const parameters = (model.parameters ?? {}) as Record<string, unknown>;
  return {
    description: model.description ?? '',
    dimensions: model.capabilities.defaultDimension ?? DEFAULT_EMBEDDING_DIMENSION,
    id: model.id,
    name: model.name,
    tags: Array.isArray(model.bestFor) ? model.bestFor : [],
    // Add other optional fields if available in parameters
    ...parameters,
    quantized: readQuantizedFlag(parameters),
  };
}

function updateProgress(
  modelId: string,
  setDownloadProgress: (modelId: string, progress: number) => void,
  progress: number | undefined
): void {
  if (progress !== undefined) {
    setDownloadProgress(modelId, progress);
  }
}

async function downloadLlmModel(
  model: DbModel,
  { modelCacheDir, setDownloadProgress, setDownloading, toast }: DownloadDeps
): Promise<void> {
  const { downloadBuiltInLocalLlmModel } = await import(
    '@brainstrike/assistant-contract/local-llm-artifacts'
  );

  setDownloading(model.id, true);
  setDownloadProgress(model.id, 0);

  try {
    toast({
      description: `Starting download for ${model.name}...`,
      title: 'Download Started',
    });

    const downloadOptions: {
      cacheDir?: string;
      onProgress: (progress: { progress: number }) => void;
    } = {
      onProgress: (progress) => {
        setDownloadProgress(model.id, progress.progress);
      },
    };
    if (modelCacheDir) {
      downloadOptions.cacheDir = modelCacheDir;
    }
    await downloadBuiltInLocalLlmModel(model.id, downloadOptions);

    setDownloadProgress(model.id, 100);
    toast({
      description: `${model.name} downloaded successfully!`,
      title: 'Download Complete',
    });
  } catch (err) {
    logger.error('Failed to download LLM model', err);
    toast({
      description: `Failed to download ${model.name}: ${(err as Error).message}`,
      title: 'Download Failed',
      variant: 'destructive',
    });
  } finally {
    setDownloading(model.id, false);
  }
}

async function downloadEmbeddingModel(
  model: DbModel,
  { modelCacheDir, setDownloadProgress, setDownloading, toast }: DownloadDeps
): Promise<void> {
  const { downloadEmbeddingModel: runEmbeddingModelDownload } = getModelRuntimeServices();
  const modelConfig = buildModelConfig(model);

  setDownloading(model.id, true);
  setDownloadProgress(model.id, 0);

  try {
    toast({
      description: `Starting download for ${model.name}...`,
      title: 'Download Started',
    });

    const options: {
      modelConfig: ModelConfig;
      cacheDir?: string;
      onProgress: (progress: DownloadProgress) => void;
    } = {
      modelConfig,
      onProgress: (progress) => updateProgress(model.id, setDownloadProgress, progress.progress),
    };

    if (modelCacheDir) {
      options.cacheDir = modelCacheDir;
    }

    // Pass full config to bypass registry lookup
    await runEmbeddingModelDownload(model.id, options);

    setDownloadProgress(model.id, 100);
    toast({
      description: `${model.name} downloaded successfully!`,
      title: 'Download Complete',
    });
  } catch (err) {
    logger.error('Failed to download embedding model', err);
    toast({
      description: `Failed to download ${model.name}: ${(err as Error).message}`,
      title: 'Download Failed',
      variant: 'destructive',
    });
  } finally {
    setDownloading(model.id, false);
  }
}

async function downloadModel(model: DbModel, deps: DownloadDeps): Promise<void> {
  // Route to appropriate downloader based on model type
  if (model.capabilities.type === 'llm') {
    return downloadLlmModel(model, deps);
  }
  return downloadEmbeddingModel(model, deps);
}

/** Model Catalog category header controls: local cache directory + registry refresh. */
export function ModelCatalogHeaderActions() {
  const db = usePGliteDatabase();
  const { fetchRegistry, isLoading } = useModelRegistryStore(
    useShallow((state) => ({ fetchRegistry: state.fetchRegistry, isLoading: state.isLoading }))
  );
  return (
    <div className="flex items-center gap-2">
      <ModelCacheDirectoryPopover />
      <Button
        aria-label="Refresh model registry"
        data-testid="model-registry-refresh"
        disabled={isLoading}
        onClick={() => db && fetchRegistry(db)}
        size="icon-sm"
        title="Refresh model registry"
        variant="outline"
      >
        <RefreshCw className={cn('size-4', isLoading && 'animate-spin motion-reduce:animate-none')} />
      </Button>
    </div>
  );
}

export function ModelSelectionPage() {
  const db = usePGliteDatabase();
  const {
    downloadedModels,
    downloadProgress,
    error,
    fetchRegistry,
    hasLoaded,
    isDownloading,
    modelCacheDir,
    models,
    providers,
    setDownloading,
    setDownloadProgress,
  } = useModelRegistryStore(
    useShallow((state) => ({
      downloadedModels: state.downloadedModels,
      downloadProgress: state.downloadProgress,
      error: state.error,
      fetchRegistry: state.fetchRegistry,
      hasLoaded: state.hasLoaded,
      isDownloading: state.isDownloading,
      modelCacheDir: state.modelCacheDir,
      models: state.models,
      providers: state.providers,
      setDownloading: state.setDownloading,
      setDownloadProgress: state.setDownloadProgress,
    }))
  );
  const { toast } = useToast();
  // Shared with the Provider Hub cards: one implementation of "enable this
  // model", so a failure is reported the same way on both surfaces. Bulk
  // changes go through the same controller (one busy set, one failure path).
  const { busyModelIds, toggle, toggleMany } = useModelToggle();
  const applyBulkChange = useModelBulkToggle(toggleMany);

  useEnsureModelRegistry({ db });

  const handleDownload = useCallback(
    (modelId: string): void => {
      if (isDownloading[modelId]) {
        return;
      }
      const model = models.find((m) => m.id === modelId);
      if (!model) {
        return;
      }
      void downloadModel(model, { modelCacheDir, setDownloading, setDownloadProgress, toast });
    },
    [isDownloading, modelCacheDir, models, setDownloadProgress, setDownloading, toast]
  );

  const handleToggle = useCallback(
    (modelId: string, enabled: boolean): void => {
      void toggle(modelId, enabled);
    },
    [toggle]
  );

  const handleBulkChange = useCallback(
    (change: ModelBulkChange): void => {
      void applyBulkChange(change);
    },
    [applyBulkChange]
  );

  const handleRefresh = useCallback((): void => {
    if (db) {
      void fetchRegistry(db);
    }
  }, [db, fetchRegistry]);

  if (error) {
    return (
      <div
        className="rounded-md bg-destructive/10 p-4 text-destructive"
        data-testid="model-registry-error"
      >
        <p className="font-medium">Error loading models</p>
        <p className="text-sm">{error}</p>
        <Button
          className="mt-2"
          data-testid="model-registry-retry"
          onClick={() => db && fetchRegistry(db)}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <ModelCatalog
      busyModelIds={busyModelIds}
      downloadedModels={downloadedModels}
      downloadProgress={downloadProgress}
      isDownloading={isDownloading}
      loaded={hasLoaded}
      modelCacheDir={modelCacheDir}
      models={models}
      onBulkChange={handleBulkChange}
      onDownload={handleDownload}
      onRefresh={handleRefresh}
      onToggle={handleToggle}
      providers={providers}
    />
  );
}
```

Delete the old list:

```bash
grep -rn "model-list'" packages apps --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '/dist/'
# expect: only packages/settings-ui/src/settings/models/__tests__/model-list.test.tsx
git rm packages/settings-ui/src/settings/models/model-list.tsx packages/settings-ui/src/settings/models/__tests__/model-list.test.tsx
```

- [ ] **Step 6: Run the settings-ui tests to verify they pass**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/models/__tests__/model-catalog.test.tsx src/settings/models/__tests__/model-cache-directory-popover.test.tsx`

Expected: PASS.

- [ ] **Step 7: Mutation checks (revert after each)**

1. In the `/` handler, delete `input.closest('[aria-hidden="true"]') !== null ||`. "ignores / while the settings route is hidden" must fail.
2. In `handleBulk`, drop `.filter((row) => row.enabled !== enabled)`. "bulk-enables only the shown rows that would change" must fail: it would receive `['claude-opus-5', 'claude-sonnet-4-6']`.
3. In `useCatalogExpansion`'s caller, pass `filtering: false` instead of `filtering`. "expands every matching section …" must fail.

After reverting, re-run Step 6 and confirm PASS.

- [ ] **Step 8: Wire both apps**

(a) `apps/web/src/app/settings/page-content.tsx`:

1. Change the import `import { ModelSelectionPage } from '@brainstrike/settings-ui/settings/models/model-selection-page';` to:

   ```ts
   import {
     ModelCatalogHeaderActions,
     ModelSelectionPage,
   } from '@brainstrike/settings-ui/settings/models/model-selection-page';
   ```

2. Delete the `function ModelSelectionCategory() { … }` component entirely (its `space-y-4` wrapper would break the workspace height chain).
3. Replace the category object literal whose `title` is `'Model Catalog'` with:

   ```tsx
      {
        content: <ModelSelectionPage />,
        description: 'Browse every catalogued model and enable the ones you want.',
        headerActions: <ModelCatalogHeaderActions />,
        icon: Layers,
        id: 'models',
        keywords: ['models', 'catalog', 'llm', 'embedding', 'vector'],
        layout: 'workspace',
        title: 'Model Catalog',
      },
   ```

4. If `hasDurableAssistantUsageCapability` is now unused in this file, remove its import. PR 1 moved its other consumer.

(b) `apps/desktop/src/renderer/components/settings/page-content.tsx`:

1. Change the same import as in (a).1.
2. Replace the category object literal whose `title` is `'Model Catalog'` with:

   ```tsx
      {
        content: <ModelSelectionPage />,
        description:
          'Browse every catalogued model, manage local downloads, and set the model cache directory.',
        headerActions: <ModelCatalogHeaderActions />,
        icon: Layers,
        id: 'embedding-models',
        keywords: ['embeddings', 'models', 'catalog', 'vector', 'llm', 'download', 'cache'],
        layout: 'workspace',
        title: 'Model Catalog',
      },
   ```

3. Remove any import or `useMemo` dependency that is now unused. Biome's `useExhaustiveDependencies` and `tsc` name them.

(c) Add the new export to each of the four `vi.mock('@brainstrike/settings-ui/settings/models/model-selection-page', …)` factories. Vitest throws when a test touches an export that a factory mock does not define. Add the property `ModelCatalogHeaderActions: vi.fn(() => null),` beside `ModelSelectionPage` in:
   - `apps/web/src/app/settings/__tests__/page-content.test.tsx`
   - `apps/web/src/app/__tests__/document-title.test.tsx`
   - `apps/desktop/src/__tests__/renderer/components/settings/page-content.test.tsx`
   - `apps/desktop/src/__tests__/renderer/components/settings/page-content-operations.test.tsx`

- [ ] **Step 9: Full lanes, type-check, lint**

Run:
- `pnpm --filter @brainstrike/settings-ui test`
- `pnpm --filter @brainstrike/web exec vitest run src/app/settings/__tests__ src/app/__tests__/document-title.test.tsx`
- `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/renderer/components/settings`
- `node scripts/run-turbo-command.mjs -- run type-check --filter=@brainstrike/settings-ui --filter=@brainstrike/web --filter=@brainstrike/desktop`
- `pnpm run lint:eslint`

Expected: all PASS, and the ESLint warning ratchet unchanged. A new `react-refresh/only-export-components` finding means a `.tsx` file mixes component and non-component exports; move the non-component export to a sibling `.ts` file.

- [ ] **Step 10: Commit**

```bash
pnpm exec biome check --write packages/settings-ui/src/settings/models apps/web/src/app/settings/page-content.tsx apps/desktop/src/renderer/components/settings/page-content.tsx apps/web/src/app/settings/__tests__/page-content.test.tsx apps/web/src/app/__tests__/document-title.test.tsx apps/desktop/src/__tests__/renderer/components/settings/page-content.test.tsx apps/desktop/src/__tests__/renderer/components/settings/page-content-operations.test.tsx
git add packages/settings-ui/src/settings/models apps/web/src/app apps/desktop/src/renderer/components/settings/page-content.tsx apps/desktop/src/__tests__/renderer/components/settings
git commit -m "feat(BST-1805): replace the model list with the full-size Model Catalog

One scroll owner with windowed provider sections, container-width tiers,
the / search shortcut, bulk changes with Undo, and the cache directory in
a header popover. The Model Catalog category opts into the workspace layout
on web and desktop; model-list.tsx is removed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: E2E — migrate selectors, and pin the row pitch, windowing and sticky headers

**Files:**
- Modify: `apps/web/e2e/settings-models-and-providers.test.ts`
- Modify: `apps/desktop/e2e/settings-models-and-providers.desktop.test.ts`

**Interfaces:**
- Consumes these test ids from Tasks 6–9: `model-cache-dir-trigger`, `model-cache-dir-select`, `model-cache-dir-input`, `model-toggle-<id>`, `model-catalog-expand-all`, `model-catalog-scroll`, `model-catalog-summary`, `model-catalog-section-header-<id>`. It also uses the search box `role=searchbox` named "Search models", and the TreeTable row attribute `tr[data-node-type="model"]`.

Why each change is needed:
- **Cache directory:** the cache-directory form now lives in a header popover, so every test opens the popover first.
- **Toggle persistence:** rows are windowed inside provider sections, so a row that is scrolled away is not in the DOM. The toggle-persistence test therefore picks a rendered disabled toggle directly, after **Expand all**. After the reload it searches for the model, which makes its section expand and brings the row to the top.
- **Geometry:** jsdom has no layout, so the painted pitch, the real windowing and the sticky-header occlusion can only be pinned here (docs/agents/ui-conventions.md, "Row height and painted geometry").

- [ ] **Step 1: Update the web E2E**

In `apps/web/e2e/settings-models-and-providers.test.ts`:

(a) In the test `'shows a registry load error and recovers on retry @stateful'`, replace

```ts
    await expect(page.getByTestId('model-cache-dir-input')).toBeVisible({ timeout: 15_000 });
```

with

```ts
    // The cache directory lives in a header popover since BST-1805.
    await expect(page.getByTestId('model-cache-dir-trigger')).toBeVisible({ timeout: 15_000 });
```

(b) In `'shows the web-only cache directory unavailable path'`, replace

```ts
    await page.getByTestId('model-cache-dir-select').click();
```

with

```ts
    await page.getByTestId('model-cache-dir-trigger').click();
    await page.getByTestId('model-cache-dir-select').click();
```

(c) In `'persists a model toggle across reload @stateful'`, replace everything from `    const modelRows = page.locator('[data-testid^="model-row-"]');` down to and including the block

```ts
    if (!modelId) {
      throw new Error('Expected at least one disabled model to verify toggle persistence');
    }
```

with

```ts
    // Rows are windowed inside provider sections (BST-1805): only rendered rows
    // exist in the DOM. Expand every section, then take the first rendered
    // disabled toggle.
    await page.getByTestId('model-catalog-expand-all').click();
    const firstDisabledToggle = page
      .locator('[data-testid^="model-toggle-"][aria-checked="false"]')
      .first();
    await expect(firstDisabledToggle).toBeVisible({ timeout: 30_000 });
    const toggleTestId = await firstDisabledToggle.getAttribute('data-testid');
    if (!toggleTestId?.startsWith('model-toggle-')) {
      throw new Error(`Unexpected model toggle test id: ${String(toggleTestId)}`);
    }
    const modelId = toggleTestId.slice('model-toggle-'.length);
```

(d) In the same test, after the reload, replace

```ts
    await settings.openCategory(/Model Catalog/i, 'models');

    await expect(page.getByTestId(`model-toggle-${modelId}`)).toHaveAttribute(
```

with

```ts
    await settings.openCategory(/Model Catalog/i, 'models');
    // Searching the id expands its section and brings the row into the window.
    await page.getByRole('searchbox', { name: 'Search models' }).fill(modelId);

    await expect(page.getByTestId(`model-toggle-${modelId}`)).toHaveAttribute(
```

(e) Append this test as the LAST test inside `test.describe('Model Catalog settings (web) @web-settings-state', …)`:

```ts
  test('paints one-line rows at a 36px pitch, windows them, and pins provider headers', async ({
    page,
  }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto();
    await home.navigateToSettings();
    await settings.openCategory(/Model Catalog/i, 'models');
    await page.getByTestId('model-catalog-expand-all').click();

    const firstGridRows = page.getByRole('treegrid').first().locator('tr[data-node-type="model"]');
    await expect(firstGridRows.nth(2)).toBeVisible({ timeout: 30_000 });

    // Pitch is the delta between consecutive row tops; one row's own height
    // under-reports by half the collapsed border (ui-conventions.md).
    const tops = await firstGridRows.evaluateAll((rows) =>
      rows.slice(0, 3).map((row) => row.getBoundingClientRect().top)
    );
    const [first, second, third] = tops;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('Expected three rendered model rows');
    }
    expect(second - first).toBeCloseTo(36, 0);
    expect(third - second).toBeCloseTo(36, 0);

    // Shared-scroller windowing: with EVERY section expanded, the DOM holds
    // far fewer rows than the catalog.
    const summary = (await page.getByTestId('model-catalog-summary').textContent()) ?? '';
    const totalModels = Number.parseInt(summary, 10);
    expect(totalModels).toBeGreaterThan(50);
    expect(await page.locator('tr[data-node-type="model"]').count()).toBeLessThan(totalModels);

    // Sticky headers: after scrolling, the section under the scroller's top
    // edge has its header pinned there AND painting above the rows.
    const scroller = page.getByTestId('model-catalog-scroll');
    await scroller.evaluate((element) => {
      element.scrollTop = 600;
    });
    await expect
      .poll(
        async () =>
          await scroller.evaluate((element) => {
            const top = element.getBoundingClientRect().top;
            const headers = Array.from(
              element.querySelectorAll<HTMLElement>('[data-testid^="model-catalog-section-header-"]')
            );
            const pinned = headers.find(
              (header) => Math.abs(header.getBoundingClientRect().top - top) < 1
            );
            if (!pinned) {
              return 'no header pinned';
            }
            const probe = document.elementFromPoint(pinned.getBoundingClientRect().left + 8, top + 4);
            return probe !== null && pinned.contains(probe) ? 'pinned' : 'occluded';
          }),
        { timeout: 10_000 }
      )
      .toBe('pinned');
  });
```

- [ ] **Step 2: Update the desktop E2E**

In `apps/desktop/e2e/settings-models-and-providers.desktop.test.ts`:

(a) In `'shows a registry load error and recovers on retry'`, replace

```ts
    await expect(window.getByTestId('model-cache-dir-input')).toBeVisible();
```

with

```ts
    // The cache directory lives in a header popover since BST-1805.
    await expect(window.getByTestId('model-cache-dir-trigger')).toBeVisible();
```

(b) Replace EVERY occurrence (there are two) of

```ts
    await window.getByTestId('model-cache-dir-select').click();
```

with

```ts
    await window.getByTestId('model-cache-dir-trigger').click();
    await window.getByTestId('model-cache-dir-select').click();
```

(c) In `'updates the cache directory through the desktop bridge'`, append after the existing `toHaveValue('/tmp/brainstrike-model-cache')` assertion:

```ts
    await expect(window.getByTestId('model-cache-dir-trigger')).toContainText(
      '/tmp/brainstrike-model-cache'
    );
```

- [ ] **Step 3: Run the E2E lint contracts**

Run: `pnpm run lint:e2e-readiness-contracts && pnpm run lint:e2e-destructive-tags`

Expected: both PASS.

- [ ] **Step 4: Build and run the web settings lane (against a FRESH build)**

Run:
- `pnpm run build:web`
- `pnpm --filter @brainstrike/web test:e2e:lane:settings-state`

Expected: all tests in the lane pass, including the new geometry test.

If the pitch assertion fails, measure the real pitch in the failure message. Then adjust ONLY `ROW_LINE`'s `h-[35px]` in `catalog-columns.tsx` (for example to `h-[36px]` if the measured pitch is 35), rebuild with `pnpm run build:web`, and re-run. Never loosen the assertion. Record the measured value in the commit message.

- [ ] **Step 5: Build and run the desktop settings test (against a FRESH build)**

Run:
- `node scripts/run-turbo-command.mjs -- run build --filter=@brainstrike/desktop --force`
- `(cd apps/desktop && node ../../scripts/run-env.mjs NO_COLOR= BRAINSTRIKE_DISABLE_FILE_LOGS=1 LOG_LEVEL=warn -- xvfb-maybe pnpm exec playwright test e2e/settings-models-and-providers.desktop.test.ts --project=regression --workers=1 --retries=0)`

Expected: 3 passed. Desktop E2E can be flaky headless. If a test fails for a reason unrelated to these selectors, diagnose it; do not skip or retry blindly (AGENTS.md).

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write apps/web/e2e/settings-models-and-providers.test.ts apps/desktop/e2e/settings-models-and-providers.desktop.test.ts
git add apps/web/e2e/settings-models-and-providers.test.ts apps/desktop/e2e/settings-models-and-providers.desktop.test.ts packages/settings-ui/src/settings/models/catalog-columns.tsx
git commit -m "test(BST-1805): cover the Model Catalog layout in web and desktop E2E

Cache directory via its header popover; toggle persistence finds a
rendered row and searches after reload; a new web test pins the measured
36px row pitch, shared-scroller windowing and sticky provider headers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`catalog-columns.tsx` is staged only if Step 4 required a pitch adjustment; `git add` of an unchanged file is a no-op.)

---
### Task 11: Full gates, and live verification of a built preview against the mockup

**Files:**
- Create (scratchpad only, never committed): `$SCRATCH/shoot-catalog.mjs`
- No repo file changes unless a gate fails. A fix goes in its own commit with the gate named in the message.

**Interfaces:** consumes the whole PR.

- [ ] **Step 1: Run the full package lanes (NOT name-filtered)**

```bash
pnpm --filter @brainstrike/ui test
pnpm --filter @brainstrike/assistant-ui test
pnpm --filter @brainstrike/app-state test
pnpm --filter @brainstrike/app-state test:integration
pnpm --filter @brainstrike/settings-ui test
pnpm --filter @brainstrike/app-shell test
pnpm --filter @brainstrike/web test
pnpm --filter @brainstrike/desktop test
pnpm test:scripts
```

Expected: every command exits 0. `pnpm test:scripts` includes the shrink-only contracts:
- `max-file-lines-contract` (the 1000-line cap; no new file here comes close);
- `tailwind-source-coverage`;
- `lint-rule-liveness-contract`.

A red boundary or budget test is a real finding; fix the cause and never raise a ceiling.

- [ ] **Step 2: Type-check, lint and the quality gates**

```bash
node scripts/run-turbo-command.mjs -- run type-check --filter=@brainstrike/ui --filter=@brainstrike/app-state --filter=@brainstrike/settings-ui --filter=@brainstrike/app-shell --filter=@brainstrike/assistant-ui --filter=@brainstrike/web --filter=@brainstrike/desktop
pnpm dlx ultracite check
pnpm run lint:eslint
npx react-doctor . --scope changed --verbose
pnpm knip
```

Expected:
- **type-check and ultracite:** exit 0.
- **`lint:eslint`:** the per-rule baseline is unchanged. A NEW `react-hooks/*` finding in an extracted file is newly VISIBLE code, not new code (see the memory note on React Compiler bail-outs); fix the pattern and never raise the baseline.
- **React Doctor:** no new error-severity issue.
- **knip:** nothing reported in `packages/settings-ui`, `packages/ui` or `packages/app-state`. Specifically, check that nothing references `model-list`/`model-filters` and that no new export is unused.

- [ ] **Step 3: Build and serve the web preview**

```bash
pnpm run build:web
PORT=8083 pnpm --filter @brainstrike/web start
```

Run the second command in the background (Bash `run_in_background: true`). Wait until `curl -sf http://localhost:8083/ > /dev/null` succeeds.

- [ ] **Step 4: Capture the live states and geometry**

Create `$SCRATCH/shoot-catalog.mjs`:

```js
import { createRequire } from 'node:module';

const WT = process.env.WT;
const OUT = process.env.SCRATCH;
if (!(WT && OUT)) {
  throw new Error('Set WT (worktree root) and SCRATCH (screenshot directory)');
}
const require = createRequire(`${WT}/apps/web/package.json`);
const { chromium } = require('@playwright/test');
const BASE = 'http://localhost:8083/';

async function openCatalog(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const settings = page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true });
  await settings.waitFor({ timeout: 60_000 });
  await settings.dispatchEvent('click');
  const category = page.getByRole('button', { name: /Model Catalog/ }).first();
  await category.waitFor({ timeout: 30_000 });
  await category.dispatchEvent('click');
  await page.getByTestId('model-catalog').waitFor({ timeout: 30_000 });
  await page.locator('[data-testid^="model-toggle-"]').first().waitFor({ timeout: 30_000 });
}

async function measure(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr[data-node-type="model"]'));
    const tops = rows.slice(0, 4).map((row) => row.getBoundingClientRect().top);
    const header = document.querySelector('[data-testid="model-catalog-column-header"]');
    return {
      firstRowCellLefts: rows[0]
        ? Array.from(rows[0].querySelectorAll('td'), (td) => Math.round(td.getBoundingClientRect().left))
        : [],
      headerCellLefts: header
        ? Array.from(header.querySelectorAll('th'), (th) => Math.round(th.getBoundingClientRect().left))
        : [],
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      pitches: tops.slice(1).map((top, index) => Math.round((top - tops[index]) * 10) / 10),
      renderedModelRows: rows.length,
      summary: document.querySelector('[data-testid="model-catalog-summary"]')?.textContent ?? null,
      tier: document.querySelector('[data-testid="model-catalog"]')?.getAttribute('data-width-tier') ?? null,
    };
  });
}

const results = {};
const browser = await chromium.launch();
try {
  for (const [name, width, height, colorScheme] of [
    ['catalog-wide-light', 1440, 900, 'light'],
    ['catalog-wide-dark', 1440, 900, 'dark'],
    ['catalog-narrow-light', 900, 900, 'light'],
    ['catalog-narrow-dark', 900, 900, 'dark'],
  ]) {
    const page = await browser.newPage({ colorScheme, viewport: { height, width } });
    await openCatalog(page);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    results[name] = await measure(page);
    await page.close();
  }

  const page = await browser.newPage({ colorScheme: 'light', viewport: { height: 900, width: 1440 } });
  await openCatalog(page);

  await page.getByRole('searchbox', { name: 'Search models' }).fill('claude');
  await page.getByRole('button', { name: 'Reasoning' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/catalog-filtered.png` });
  results.filtered = await measure(page);
  await page.getByTestId('model-catalog-clear-filters').click();

  await page.locator('[data-testid^="model-details-toggle-"]').first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/catalog-details.png` });

  await page.getByTestId('model-catalog-expand-all').click();
  await page.getByTestId('model-catalog-scroll').evaluate((element) => {
    element.scrollTop = 900;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/catalog-scrolled.png` });
  results.scrolledAllExpanded = await measure(page);

  await page.getByTestId('model-catalog-scroll').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.locator('[data-testid^="model-catalog-disable-"]:not([disabled])').first().click();
  await page.getByTestId('model-bulk-undo').waitFor({ timeout: 10_000 });
  await page.screenshot({ path: `${OUT}/catalog-bulk-undo.png` });
  await page.getByTestId('model-bulk-undo').click();
  await page.getByText(/^Restored \d+ models?$/).waitFor({ timeout: 10_000 });
  await page.screenshot({ path: `${OUT}/catalog-bulk-restored.png` });
  await page.close();
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
```

Run: `WT=$WT SCRATCH=$SCRATCH node $SCRATCH/shoot-catalog.mjs`

Expected output assertions (check each against the JSON by hand):
- **Pitch:** every `pitches` value is `36`.
- **Tiers:** `catalog-wide-*` has `tier: "wide"`; `catalog-narrow-*` has `tier: "narrow"` (the catalog is about 525 px wide at a 900 px viewport).
- **Header alignment:** `headerCellLefts` equals `firstRowCellLefts` element by element within ±1 px, in every run.
- **Overflow:** `horizontalOverflow` is `false` in every run.
- **Windowing:** in `scrolledAllExpanded`, `renderedModelRows` is less than the model count in `summary`, which proves windowing in the shared scroller.

- [ ] **Step 5: Compare with the mockup**

Read each screenshot next to its mockup reference:
- `catalog-wide-light.png` ↔ `mockup-wide.png`
- `catalog-narrow-light.png` ↔ `mockup-narrow.png`
- `catalog-filtered.png` ↔ `mockup-wide-filtered.png`
- `catalog-scrolled.png` ↔ `mockup-wide-scrolled.png`

Also review the dark and details captures. Write down every visible deviation: spacing, column order, header content, sticky behaviour, empty space, and dark-mode contrast. Fix real defects in their own commits (`fix(BST-1805): …`), each followed by `pnpm run build:web` and a re-run of Step 4. The mockup's data and "moved" badge are illustrative and are NOT defects.

The **download-in-progress** state is not captured live, because it would download a real model of about 1 GB. State that in the report; it is covered by `catalog-columns.test.tsx` ("shows download progress, then a downloaded mark").

- [ ] **Step 6: Performance trace (Chrome DevTools)**

If the chrome-devtools MCP is connected:
1. Open `http://localhost:8083`, then Settings → Model Catalog, and click Expand all.
2. `performance_start_trace`.
3. Scroll `model-catalog-scroll` from top to bottom in 10 steps.
4. `performance_stop_trace`.

Report the longest main-thread task and any task over 50 ms. If the MCP is not connected, say so in the report explicitly; do not substitute a different measurement silently.

- [ ] **Step 7: Stop the preview server**

Stop the background `vite preview` process with a normal SIGTERM (`kill <pid>`), and confirm that port 8083 is free.

- [ ] **Step 8: Report**

Report:
- the gate results from Steps 1–2;
- the measurement JSON;
- the screenshot paths under `$SCRATCH`;
- the deviations found and fixed;
- the perf-trace result.

Push and PR creation belong to the orchestrator: the PR body must state the stack order (PR 1 → PR 2) and link BST-1805.

---
## Self-review (run while writing this plan)

**1. Spec coverage** (design doc section → task):

| Spec section | Requirement | Task |
| --- | --- | --- |
| §3.1 | Local cache compacted into a header popover that shows its value | 9 |
| §3.1 | Refresh as a header icon button | 9 (shell slot in 5) |
| §3.1 | Downloads in the Actions cell | 6 |
| §3.2 | `layout: 'workspace'`, full width and height, the category owns its scroll | 5, 9 |
| §3.2 | Sections in DB `sort_order` | 2 |
| §3.2 | Section header: chevron, icon tile (`PROVIDER_COLOR_MAP`), name, runtime tag, meter, `n / total enabled`, `n shown`, bulk actions | 7 |
| §3.3 | Default expansion (enabled providers; otherwise the first provider) | 3 |
| §3.3 | Filter-session derivation, restore on clear, Expand/Collapse all, component state only | 3 |
| §4 | `matchesModelQuery` plus `keywords` | 1, 2 |
| §4 | `/`, Esc, `useDeferredValue` | 8, 9 |
| §4 | `<mark>` highlight, id on demand | 2, 6 |
| §4 | Status, Type (default **All**), Embedding tag | 2, 6, 8 |
| §4 | Vision/Reasoning chips (unknown ≠ supported) | 2, 8 |
| §4 | Context bands 128K/200K/1M; absent context never matches | 2, 8 |
| §4 | Providers popover with counts | 8 |
| §4 | `aria-live` result bar, removable chips, Clear filters | 8 |
| §4 | Per-section sort (absent last, price by input rate) | 2, 6, 9 |
| §4 | Empty states (no matches, empty catalog); registry error unchanged | 9 |
| §5 | Columns, 36 px pitch | 6, 10 |
| §5 | `—` + "No published price", never `$0` | 6 |
| §5 | "unverified" for reasoning `unknown` | 6 |
| §5 | Free, dimensions, Recommended | 6 |
| §5 | Details row: id + copy, full digits, pricing incl. cache, efforts, best-for, description, cache path | 6 |
| §5 | Subtle enabled tint (no outline) | 7 |
| §5 | Container-query tiers (Max out < 900; Price/tagline < 640; "Caps"; compact Filters popover; full-width search; compact section headers) | 6, 7, 8, 9 |
| §5 | One presentational header with the measured gutter | 6 |
| §6 | Enable/Disable all and "N shown", scoped to shown rows | 7, 9 |
| §6 | One write + optimistic update + exact rollback | 4 |
| §6 | `toggleMany` (never rejects, busy, toast) | 4 |
| §6 | Undo in at most two writes; no confirm | 4 |
| §6 | Provider Hub shares the hook (unchanged) | 4 |
| §7 | treegrid labelled `"<Provider> models"` | 7 |
| §7 | h3 + disclosure `aria-expanded`/`aria-controls`, bulk beside | 7 |
| §7 | Space/Enter/→/← (Home/End inherited from TreeTable) | 7 |
| §7 | `aria-label`led capability icons; meter with visible text | 6, 7 |
| §7 | Chevron motion with a reduced-motion reset | 6, 7 |
| §8 | Shared scroller + `virtual` + per-type `rowHeight` | 7, 9 |
| §8 | Measured pitch | 10 |
| §8 | Identity-memoised projection and nodes | 2, 6 |
| §8 | Perf trace | 11 |
| §9 | Every listed unit; `model-filters.ts` and `model-list.tsx` deleted; test ids kept (see resolved decision 8) | 2–9 |
| §11 | Every listed unit/store/hook/component/E2E/manual/gate item | 1–11 |

Remaining gaps:
- The download-in-progress state is NOT captured live, because it would trigger a real ~1 GB download. It is unit-covered, and Task 11 must say so in its report.
- ← closing details relies on TreeTable's own keyboard tests (`tree-table-keyboard.test.tsx`); Task 7 adds only →/Enter/Space.

**2. Placeholder scan:** there is no TBD, TODO, "handle edge cases" or "similar to Task N". Every code step carries complete code. Two steps are deliberately conditional, and both give the exact action to take:
- Task 9 Step 8 removes imports/deps that PR 1 may already have removed; the compilers name them.
- Task 10 Step 4 adjusts ONE class only if the measured pitch disagrees, and forbids loosening the assertion.

**3. Type consistency** (checked across tasks):
- **Naming collision:** `CatalogSection` is both the model type (`catalog-sections.ts`) and the component (`catalog-section.tsx`). Every consumer imports the type as `CatalogSection as CatalogSectionModel`.
- **Hook and controller members:**
  - `useCatalogExpansion` → `{ collapseAll, expandAll, expandedSectionIds, toggleSection }`, as consumed in Task 9.
  - `ModelToggleController.toggleMany` → `ModelBulkToggleOutcome`, consumed by `useModelBulkToggle(toggleMany)`.
  - `ModelBulkChange { enabled, modelIds, scopeLabel }` is built in `ModelCatalog.handleBulk`.
- **Prop shapes:**
  - `CatalogRowActions` fields match `makeRowActions` and `ModelCatalog.rowActions` exactly.
  - `CatalogToolbarProps`, `CatalogSectionProps` and `CatalogColumnHeaderProps` match their only call sites in `model-catalog.tsx`.
  - `scrollRef` (`RefObject<HTMLDivElement | null>`) flows into `RefObject<HTMLElement | null>` props.
- **Test ids and names:** they are consistent between the producers (Tasks 6–9) and the E2E consumers (Task 10). The search is `role="searchbox"`, named "Search models".
- **knip:** `knip.jsonc` sets `exports`/`types` off and ignores `__tests__`, so knip only checks unused FILES and dependencies here. Every new module is imported.
