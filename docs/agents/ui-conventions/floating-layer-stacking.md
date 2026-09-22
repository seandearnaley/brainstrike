# Floating layer stacking — evidence

Supports `docs/agents/ui-conventions.md` § "FLOATING LAYER STACKING".
BST-963 (#831, #1626, BST-965, BST-1668). Read before changing a z-index token, collapsing the scrim/panel pair, or debugging an invisible-but-clickable popup.

Extracted verbatim from the pre-distillation contract.

---

One layer outside `packages/ui` still sits outside the scale: `file-explorer-ui`'s
`tapestry/tapestry-lens.tsx` portals a `fixed z-[120]` code-lens preview, chosen
to clear toasts. It does not conflict with anything today, but it is not covered
by the guard, so treat the statement above as scoped to `packages/ui`.

(An earlier `loading-overlay.tsx` sat at `fixed inset-0 z-50` and tied with the
tier-1 dialog scrim. It turned out to have no consumers and was deleted in
BST-965 rather than tokenised.)

---

Three invariants hold, asserted in `packages/ui/src/__tests__/layers.test.ts`:

1. **A dialog panel sits strictly above its own scrim.** This is #831's ruling:
   at an equal z-index RemoveScroll's wrapper steals pointer events from the
   panel. Do not collapse the pair onto one value.
2. **A nested dialog's scrim sits above the panel that opened it** — *provided
   the nested dialog is rendered inside that panel's subtree.* `Dialog` tracks
   nesting depth through React context (which crosses portals) and derives its
   tier from it; `dialogLayerClasses` throws rather than clamping past
   `MAX_DIALOG_NESTING_DEPTH`.

   **The depth is lexical, not open-order.** A dialog hoisted to a sibling of
   the one it covers — or owned by a provider above it — resolves to tier 1 and
   its scrim paints under the other panel again, silently reproducing the
   defect. Keep a dialog co-located with the surface it covers. The same
   property means a `<Dialog>` written inside another's JSX consumes a tier even
   while the outer one is closed, which is why the scale reserves eight tiers
   rather than the four this defect needed.
3. **Popups out-rank every dialog tier.** This is the defect that produced the
   scale: Settings became a modal in #1626 while Select/Popover/DropdownMenu/
   ContextMenu/Tooltip were all still on `z-50` and `DialogContent` had moved
   to `z-[51]`, so a Select opened in Settings painted behind an opaque panel.
   (Settings is a nav-rail route again since BST-1668, so that specific
   reproduction no longer exists — the invariant stands for every dialog.)

Two traps worth knowing before you debug this class of bug again:

- **An invisible popup is still hit-testable.** Radix drops `pointer-events` on
  the dialog panel while an inner layer is open, so `elementFromPoint` returns
  the option, Playwright's actionability checks pass, and a click succeeds — on
  a dropdown the user cannot see. Functional assertions do not catch it; assert
  stacking or occlusion. The BST-963 occlusion probe lived in the old
  `settings-modal-layering` spec; it was retired with the Settings modal in
  BST-1668 because a route cannot occlude a popup, so reproduce that shape
  against whichever dialog you are debugging.
- **Values must be literal strings.** Tailwind emits only classes its scanner
  can see, and `packages/ui/styles.css` exposes this package via `@source`. A
  runtime-composed `` z-[${n}] `` produces no CSS at all and silently computes
  to `auto`.

