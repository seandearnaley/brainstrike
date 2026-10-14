# Popup anchor transforms — evidence

Supports `docs/agents/ui-conventions.md` § "FLOATING LAYER ANCHORING".
Read before widening or removing the `kinetic-depress` open-anchor exclusion, or before adding a transform to a floating-layer trigger.

Extracted verbatim from the pre-distillation contract.

---


Stacking (above) decides what a popup paints *over*. This section is the other
half: what it is *measured against*.

Radix positions Select/Popover/DropdownMenu/ContextMenu content with Floating
UI, which measures the trigger via `getBoundingClientRect()` and publishes the
result as `--radix-popper-anchor-width` / `--radix-popper-anchor-height` (Select
re-namespaces these to `--radix-select-trigger-*`).

**A transform on a trigger corrupts every popup it opens.** `getBoundingClientRect()`
includes transforms; `ResizeObserver` does not fire for them; and Radix's default
`updatePositionStrategy` is `optimized`, so there is no per-frame re-measure. The
popup therefore stays sized and placed from whatever the trigger looked like at
the instant it opened, for as long as it is open.

That instant is POINTERDOWN — Radix opens on pointerdown, not click, so the
trigger is still `:active`. `packages/ui/src/globals.css` applies
`transform: scale(0.97)` to `.kinetic-depress:active`, and `SelectTrigger`
carries that class. Measured on the 718x40 "Indexing policy" trigger in the
Settings surface at 1440x900: the anchor was published as 696.46 x 38.80 —
718 x 0.97 and 40 x 0.97 exactly — and the listbox rendered 21.5px too narrow
and 11px inside the field's left edge.

Rules:

- The press effect is suppressed while a trigger is an OPEN popup anchor, via
  `:not([data-state="open"])` in that `:active` rule. Do not remove it. Do not
  "fix" a misaligned popup by nudging `sideOffset` or `align` — that hides a
  measurement bug behind a cosmetic constant.
- `data-state` is the whole condition on purpose. Every Radix floating trigger
  sets it, and the repo has no non-Radix floating anchors. Do NOT widen it to
  `[aria-expanded="true"]`: `Button` defaults to `depress`, so that clause kills
  the press affordance on ~14 plain disclosure toggles — tree-row expand
  chevrons, ide-layout's hide-panel buttons (dead outright, since they render
  only while expanded) — and buys nothing for this defect. A non-Radix combobox
  would be scoped as `[role="combobox"][aria-expanded="true"]`.
- Do not add any other transform, `zoom`, or `scale` to an element that anchors
  a floating layer, and do not wrap one in a transformed container.
- A keyboard-opened popup measures correctly even when the defect is present
  (no `:active`), so reproduce and assert with a REAL mouse press.

