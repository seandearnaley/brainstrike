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

## Colour and surfaces

Neutral fills come from the surface tokens (`bg-muted`, `bg-accent`,
`border-border`; `var(--color-muted)` in stylesheets). A coloured thread re-keys
those tokens to its colour on its conversation panel and its Threads row, so an
overlay inside stays in the thread's hue; do not hardcode a grey or `var(--muted)`
there. Palette tokens (`--bs-*` in `packages/ui/src/themes/`) hold complete colours:
use a token as `var(--x)`, and `color-mix(in oklab, var(--x) N%, transparent)` for
an alpha. The palette is `data-theme` on `<html>`, set by `ThemeProvider` beside the
light/dark class. Generated palettes come from `scripts/import-shadcn-theme.mjs`;
re-run it rather than editing their values. They override only the shadcn colour
set and radius, so status, delegation and syntax tokens stay the baseline's, and
the high-contrast block in `globals.css` wins over every palette. Syntax colours
are the `--syntax-*` tokens for CodeMirror and the matching Shiki themes (GitHub
Light, Monokai) for code blocks; the code box owns its background. Scrollbars
inherit one translucent thumb from `body`.

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

Browser pages are native views that main draws above the DOM, so no DOM layer
can cover one. Main owns the page list and each page belongs to one thread; that
thread's workspace tabs mirror it, and closing a tab closes its page. A page is
shown only while its tab is selected on the Explorer route and no palette or
workspace menu is open; a menu that drops over the workspace reports its open
state through `useMenuOpenReporter`.

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
