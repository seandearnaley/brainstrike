# Activity trace motion primitives — evidence

Supports `docs/agents/ui-conventions.md` § "Motion".
BST-1679. Read before adding a motion primitive under `.assistant-ui-panel`, or before changing the compound shimmer/entrance rules.

Extracted verbatim from the pre-distillation contract.

---


Motion inside the assistant thread (`.assistant-ui-panel`) is CSS-only — no
animation library, and a deliberately small catalog rather than a bespoke
transition per component. Everything lives in `overrides.css`, scoped under
`.assistant-ui-panel`.

The activity trace (BST-1679, `docs/agents/assistant-runtime.md` § ACTIVITY
GROUPS) is the reference implementation: four `bs-trace-*` primitives, each
reusable rather than one-off:

- `.bs-trace-label` — a keyed span (the caller re-keys the element on its own
  text) that fades/slides in on change; drives both the live and resting
  headline.
- `.bs-trace-collapse` / `.bs-trace-collapse-inner` — `grid-template-rows: 0fr
  ↔ 1fr` disclosure, no measured heights.
- `.bs-trace-reveal` — a one-shot fade-up with a `--bs-stagger` index capped
  at 5, read through `var(--bs-stagger, 0)` because the index is set on an
  ANCESTOR and inherited (never declared on the revealed element itself, which
  would shadow it); phase 3 wires it to `.bs-step-list`'s step rows (below).
- `.bs-trace-detail` — a fixed one-line slot under the header while running,
  so the header's own height never changes (the thread's scroll-anchoring
  rule).

Every animated or transitioned primitive above, plus the thinking-mark
pulse/shimmer they compose with (`.bs-thinking-pulse`, `.bs-thinking-core`,
`.bs-thinking-shimmer`), has a `@media (prefers-reduced-motion: reduce)` block
that turns the animation off and freezes the element at its settled state —
never just a shorter duration. `.bs-trace-detail` is the one exception and
needs none: it is a static fixed-height slot with no animation or transition
of its own.
Where the motion is applied to text via a transparent, gradient-clipped fill
(`.bs-thinking-shimmer`, used for the live label) that also needs a
`@media (forced-colors: active)` fallback: `background-clip: text` plus
`color: transparent` would otherwise render invisible text once Windows High
Contrast strips the gradient, so the fallback swaps to a solid `CanvasText`.
Primitives whose animation is only opacity/transform (`.bs-trace-label`,
`.bs-trace-collapse`, `.bs-trace-reveal`) need no forced-colors override —
they never hide text behind a color trick.

The trace's LIVE status label is the one element that carries a
`.bs-trace-label`/`.bs-trace-label-static` entrance class AND
`.bs-thinking-shimmer` at once (`LiveSummary`, `activity-trace.tsx`); both
rules declare the `animation` shorthand at equal specificity, so the
shimmer — declared later in the stylesheet — silently replaced the entrance
outright and the crossfade never ran (phase-2 defect, found in Task 6
review). Two compound rules,
`.bs-trace-label.bs-thinking-shimmer` /
`.bs-trace-label-static.bs-thinking-shimmer` (`overrides.css`), compose the
two instead of letting one erase the other, listing both keyframes in the
comma-separated `animation` list; each single-class shorthand is repeated
verbatim rather than merged (a shorthand cannot inherit a peer's value), so a
change to either must be mirrored in the compound rule, and the
`prefers-reduced-motion` reset lists both compound selectors explicitly
alongside the one-class primitives, since the three-class specificity would
otherwise survive the generic reset.

