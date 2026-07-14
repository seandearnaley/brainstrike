# Library Tree UI Polish Plan

**Date:** 2026-07-14
**Branch:** `codex/library-tree-polish-20260714`
**Base:** `origin/main` at `c0e0fe75c60e19e70d0b2807c507efc67efe9d46`

## Product outcome

Make the Library thread tree read as one calm, precise desktop hierarchy. Folder and thread controls share stable columns, row actions stop competing with titles, and identity customization floats above the tree instead of changing row geometry. Pointer interaction must not paint a blue focus border; keyboard users retain a distinct, neutral focus-visible treatment.

The direction is restrained desktop utility: compact, aligned, low-chrome, and built entirely from Brainstrike's existing TreeTable, Radix Popover, Button, color tokens, and Lucide vocabulary.

## Architecture decisions

1. **TreeTable remains the interaction owner.** Keep the Library on the canonical shared treegrid and correct its shared focus presentation instead of layering compensating styles onto the panel.
2. **Focus and selection remain independent.** Roving focus continues to drive keyboard navigation, but only `:focus-visible` paints a focus affordance. Selection continues to use checkbox and semantic selected state.
3. **Tree controls use one horizontal rhythm.** Parent disclosure width becomes the child indentation unit so parent and child checkboxes, identity marks, and labels resolve to stable vertical columns.
4. **Customization is transient overlay UI.** Thread icon/color and folder color choices live in collision-aware Radix popovers. Opening customization does not change virtual row height or move adjacent controls.
5. **Secondary actions are consolidated.** Keep the disclosure control visible and put customize, rename, and delete into one consistent overflow surface at every panel width.

## Red/green slices

1. Add failing shared TreeTable coverage proving pointer-focused rows do not receive the old primary ring while focus-visible styling remains available.
2. Add failing Library tests proving group/thread checkbox alignment uses the shared disclosure width.
3. Add failing Library tests proving thread and folder customization render in popovers and no longer expand rows inline.
4. Implement the minimum shared focus and Library layout/action changes, then refactor repeated popover choice UI without changing persistence behavior.

## Verification

- Focused `@brainstrike/ui` and `@brainstrike/app-shell` tests.
- One uninterrupted root lint, type-check, build, and unit-test run after formatting.
- Chrome DevTools verification at wide and narrow Library widths, including computed geometry for checkbox/icon columns, resolved focus styles after pointer and keyboard input, popover collision behavior, console state, and nearby Explorer tree behavior.
- Exact-HEAD PR checks, review-thread closure, and independent review. Stop at ready-to-merge.
