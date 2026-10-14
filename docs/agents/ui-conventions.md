# Shared UI contracts

## Trees, tabs and focus

Use shared TreeTable for trees, TabStrip for documents and Tabs for fixed view
switchers. Consumers own state and intents; primitives own keyboard, focus,
overflow and menu behavior. Preserve stable row identity and virtualization across
refresh, expansion and reorder. A tree has one two-axis scroll owner; stacked
shared-scroller trees use the existing shared-parent contract rather than nested
scrollbars. Geometry comes from shared tokens, not per-consumer overrides.

Keep accessible names aligned with visible content. Arrows move focus and explicit
activation selects; close returns focus to a live neighboring target. Mounted
stateful panels retain their intended lifetime without hiding effects that own
running work. Selection manifests, counts and paths use the same canonical
snapshot; unknown/loading/error is not an empty selection.

## Context actions and layers

Use the shared registry with immutable targets claimed synchronously at invocation.
RootId is identity, not a path. Gate actions through validated capabilities and
revalidate destructive targets at execution. A broken bridge reports failure;
missing capability does not become a silent no-op. Functions remain in their
owning renderer and are not serialized as native menu actions.

Right-click and menu close preserve the originating focus owner. Editable controls
keep their native interaction. Destructive thread actions enter confirmation;
closing a tab does not delete its history.

Floating layers use shared tokens: panels above their scrims, nested scrims above
parent panels, popups above dialogs. Nesting follows lexical ownership. Do not
transform popup anchors or manufacture dynamic Tailwind classes the scanner cannot
emit. Layer readiness and visible occlusion matter, not clickability alone.

## Reload and presentation

Lazy-chunk failure offers an explicit user reload through AppReloadGate. Preserve
active-run survival/confirmation and unknown-state handling; no automatic reload
loop. TabPanelBoundary contains failures without silently dropping work.

Workspace Tailwind sources must reach every app that renders them. Reuse semantic
colors and measure contrast on the actual painted surface in both themes. Keep
4.5:1 for small text and sole-signal status glyphs, and 3:1 for meaningful non-text
indicators; focus and status must remain visible without color alone. Respect reduced
motion and forced colors. Existing shared step/approval/tab geometry and durable
child accents remain the visual grammar; do not derive another identity from a
hash or move ownership into presentation.

Implementation: `packages/ui`, `packages/context-actions`, shared app-shell
surfaces and their rendered behavior tests.
