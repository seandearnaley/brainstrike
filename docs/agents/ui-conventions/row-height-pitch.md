# Row height, virtualizer pitch, and header offset — evidence

Supports `docs/agents/ui-conventions.md` § "TREEGRID CONVERGENCE CONTRACT".
Read before changing a numeric `rowHeight`, `scrollMargin`, or any code that compares painted geometry to the virtualizer model.

Extracted verbatim from the pre-distillation contract.

---

- `rowHeight` selects one of TWO contracts and they are not interchangeable.
  A **function or per-type record** makes the value a first-paint estimate:
  TreeTable attaches TanStack's measure ref, every rendered row is measured,
  and a wrong estimate only costs scrollbar accuracy until measurement lands
  (what the threads panel relies on — see `thread-panel-visible-rows.ts`).
  A **number** disables measurement entirely, which promotes the value to a
  load-bearing promise: the spacer math (`paddingTop = firstIndex * rowHeight`),
  `getTotalSize()`, and every `scrollToIndex`/reveal offset derive from it and
  nothing ever reconciles them against the DOM. A numeric `rowHeight` must
  therefore equal the MEASURED pitch, never a design target.
  `OptimizedFileTree`'s `ROW_HEIGHT` is **29** — a 28px content line (24px
  `h-6` control + `my-0.5`) plus the 1px collapsed `border-b`. It read 32 for a
  long time while rows painted 29: because a table virtualizer positions its
  window with spacer ROWS rather than `translateY`, that never overlapped rows
  or drifted cumulatively (each `paddingTop` re-anchors to model coordinates);
  it instead left the scrollport ~110px shorter than the model, jittering as
  the window resized, and put the row under every computed offset off by one.
  Measure the pitch as the delta between consecutive row tops — a single row's
  `getBoundingClientRect().height` reports 28.5, because border collapsing
  splits the 1px rule across neighbours. Pinned live by "paints tree rows at
  exactly the pitch its virtualizer models" in `apps/web/e2e/file-explorer.test.ts`;
  jsdom has no layout, so no unit test can catch this class of drift.

---

- **A header inside the scrollport offsets PAINTED coordinates, not modelled
  ones.** TreeTable's sticky `<thead>` is IN FLOW inside its own scrollport, so
  it contributes to `scrollHeight` and shifts every row's content offset by its
  height — while the virtualizer models tbody rows alone
  (`paddingTop = index * rowHeight`; `scrollMargin` is non-zero ONLY in
  shared-scroller mode, where it carries the table's offset within the shared
  parent). Anything comparing painted geometry to the model must convert by
  subtracting the header height; `apps/web/e2e/file-explorer.test.ts`
  ("paints tree rows at exactly the pitch its virtualizer models") does.
  This is also why reveal is correct WITHOUT a header offset: a start-aligned
  `scrollToIndex` sets `scrollTop = index * rowHeight`, the row's real content
  offset is `headerHeight + index * rowHeight`, and the two cancel so the row
  lands flush at the header's bottom edge. **Do not "fix" this by adding a
  header-sized `scrollMargin`** — that would double-count and push revealed rows
  a header's height too low; and taking the header out of flow would park them
  underneath it. Both directions are pinned by the reveal assertions in that
  same spec.

