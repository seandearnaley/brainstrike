# Library Tree UI Polish Plan

**Date:** 2026-07-14
**Branch:** `codex/library-tree-polish-20260714`
**Base:** rebased onto `origin/main` at `1989dc83643c860a8bc1e8ebd1506ba2a98128fd`

## Product outcome

Make the Library thread tree read as one calm, precise desktop hierarchy. Folder and thread controls share stable columns, row actions stop competing with titles, and identity customization floats above the tree instead of changing row geometry. Pointer interaction must not paint a blue focus border; keyboard users retain a distinct, neutral focus-visible treatment.

The direction is restrained desktop utility: compact, aligned, low-chrome, and built entirely from Brainstrike's existing TreeTable, Radix Popover, Button, color tokens, and Lucide vocabulary.

## Architecture decisions

1. **TreeTable remains the interaction owner.** Keep the Library on the canonical shared treegrid and correct its shared focus presentation instead of layering compensating styles onto the panel.
2. **Focus and selection remain independent.** Roving focus continues to drive keyboard navigation, but only `:focus-visible` paints a focus affordance. Selection continues to use checkbox and semantic selected state.
3. **Tree controls use one horizontal rhythm.** Parent disclosure width becomes the child indentation unit so parent and child checkboxes, identity marks, and labels resolve to stable vertical columns.
4. **Customization is transient overlay UI.** Thread icon/color and folder color choices live in collision-aware Radix popovers. Opening customization does not change virtual row height or move adjacent controls.
5. **Secondary actions are consolidated.** Keep the disclosure control visible and put customize, rename, and delete into one consistent overflow surface at every panel width.
6. **Selection actions share one bottom overlay.** Library and Context Explorer use the shared selection overlay and reserve bottom scroll padding so selection never moves the tree.
7. **Group identity is durable and symmetric.** Group icon and color live beside group rank in Brainstrike's local presentation table; the color paints a continuous framed chassis across the group header and members, including the control gutter left of each checkbox.
8. **Expandable rows preserve the first-line anchor.** Thread and group rows share the compact 40px primary-line estimate, while tree controls pin to that line when deliberate details expand below it.
9. **Color remains layered rather than flattened.** A group color owns the outer frame, while each non-selected thread keeps a lighter tint from its own durable color. Active Library tabs use a restrained primary tint instead of returning to an uncolored white tile.
10. **Bottom docks own real panel geometry.** Library fills its tab content and removes TreeTable's browse-height cap; both Library and Context Explorer give compact selection toolbars a stable full available width so container queries do not collapse their content.

## Red/green slices

1. Add failing shared TreeTable coverage proving pointer-focused rows do not receive the old primary ring while focus-visible styling remains available.
2. Add failing Library tests proving group/thread checkbox alignment uses the shared disclosure width.
3. Add failing Library tests proving thread and folder customization render in popovers and no longer expand rows inline.
4. Implement the minimum shared focus and Library layout/action changes, then refactor repeated popover choice UI without changing persistence behavior.
5. Add failing follow-up coverage for bottom overlay placement, pinned tree controls, portal click isolation, group icon persistence, and the group color rail; implement migration 059 and the shared overlay only after those failures are confirmed.
6. Add failing visual-contract coverage for the colored group chassis, thread idle tints, active Library tab tint, full-height Library scroll owner, and stable Context Explorer action-bar width; implement only after confirming each failure.

## Verification

- Focused `@brainstrike/ui` and `@brainstrike/app-shell` tests.
- One uninterrupted root lint, type-check, build, and unit-test run after formatting.
- Chrome DevTools verification at wide and narrow Library widths, including computed geometry for checkbox/icon columns, resolved focus styles after pointer and keyboard input, popover collision behavior, console state, and nearby Explorer tree behavior.
- Exact-HEAD PR checks, review-thread closure, and independent review. Stop at ready-to-merge.
