# Dismissable layer registration timing — evidence

Supports `docs/agents/ui-conventions.md` § "Layer registration is not synchronous".
Read before extending `waitForFloatingLayerStack`, or before asserting a stack-wide pointer-events shape.

Extracted verbatim from the pre-distillation contract.

---

### Layer registration is not synchronous

`DismissableLayer` keeps its stack in a module-level `Set` that it mutates in an
EFFECT but reads during RENDER, so a freshly mounted layer paints one frame at
`index === -1`. Radix writes its verdict as an INLINE `pointer-events` style on
each layer node: `none` for a layer that is not (yet) the registered top, `auto`
for one that is, and nothing at all while no layer disables outside pointer
events.

Keyboard dismissal keys off the same stack, so an Escape inside that window is
routed to the layer UNDERNEATH the one just opened — while Settings was a modal
that closed the modal and unmounted the nested surface with it. Measured on the
old `settings-modal-layering` spec: the pre-settle snapshot appeared in 3 of 6
runs and correlated exactly with the failure. The window is ~20ms.

E2E waits on this with `waitForFloatingLayerStack(page, targetSelector)` in
`apps/web/e2e/utils/layout-helpers.ts`. Two rules if you extend it:

- Read the INLINE style, never the computed one. Computed is not a registration
  signal — `model-picker.tsx` hardcodes `pointer-events-auto` on its
  PopoverContent, and a `portal={false}` layer inherits its ancestor dialog's
  value.
- Do not assert a shape across the whole stack ("topmost `auto`, everything
  beneath `none`"). That only holds when every layer is modal. `Popover` is a
  bare `PopoverPrimitive.Root` (Radix default `modal={false}`), so it never
  disables outside pointer events and the dialog beneath it stays `auto`
  forever. Key off the target layer alone.

`SelectContent` defaults to `position="popper"`. Radix's other mode,
`item-aligned`, paints the selected option ON TOP of the trigger and does not
expose `--radix-select-trigger-width` at all, so a listbox cannot be bound to
its field in that mode. shadcn shipped `popper` as its own default until
Dec 2025 and still ships every popper style rule; only the default flipped.
`min-w-(--radix-select-trigger-width)` belongs on the Content (Radix's
documented "constrain the content size" recipe), not on the Viewport — on the
Viewport it sizes the inner box and overhangs the trigger by the content's 2px
border.

