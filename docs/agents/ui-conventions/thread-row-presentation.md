# Thread row and tab presentation — evidence

Supports `docs/agents/ui-conventions.md` § "TREEGRID CONVERGENCE CONTRACT".
BST-939. Read before changing thread density tokens, colour surfaces, or the `ThreadRow` / panel ownership split.

Extracted verbatim from the pre-distillation contract.

---

- Every surface that renders a thread — the tab strip and the threads-panel
  rows — shares one contract in `assistant-thread-presentation.ts`: the
  `THREAD_CONTROL_*` density/typography tokens (28px control, 32px row pitch,
  12px title, 20px mark) plus one color surface per thread. A control's fill
  comes from `idleClassName`/`selectedClassName`; its identity mark comes from
  `markClassName`, never the surface fill — both surfaces are tinted, so a mark
  reusing the surface fill renders invisible. Use
  `getAssistantThreadColorSurface` rather than re-deriving an "unassigned"
  fallback per call site. Do not re-declare heights or type sizes at a call
  site; that drift is what BST-939 fixed.
- The threads tree cell renders one `ThreadRow` from `thread-row.tsx`, never a
  single-element `ThreadRows` list. The row owns its rename draft,
  customization, details, delete confirmation, and pending/error state across
  parent projection rerenders; the connected panel supplies only the projected
  branch/PR/status/group facts and persistence actions. Keep row behavior in
  `thread-row.test.tsx`, which deliberately mounts without the panel's
  database, vector, search, or virtualizer setup. The whole-panel suite retains
  grouping, filtering, bulk selection, drag suppression, and persistence
  wiring coverage.

