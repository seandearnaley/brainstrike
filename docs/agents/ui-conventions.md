# Shared UI contracts

Implementation: `packages/ui`, `packages/context-actions`, shared app-shell surfaces and their rendered behavior tests.

## Trees, tabs and focus

- Use shared TreeTable for trees, TabStrip for documents and Tabs for fixed view switchers.
  - Consumers own state and intents; primitives own keyboard, focus, overflow and menu behavior.
  - Keep stable row identity and virtualization across refresh, expansion and reorder.
  - A tree has one two-axis scroll owner. Stacked shared-scroller trees use the existing shared-parent contract, not nested scrollbars.
  - Geometry comes from shared tokens, not per-consumer overrides.
- Keep accessible names aligned with visible content.
- Arrows move focus and explicit activation selects; close returns focus to a live neighboring target.
- Mounted stateful panels keep their intended lifetime without hiding effects that own running work.
- Selection manifests, counts and paths use the same canonical snapshot. Unknown, loading or error is not an empty selection.

## Colour and surfaces

- Neutral fills come from the surface tokens (`bg-muted`, `bg-accent`, `border-border`; `var(--color-muted)` in stylesheets).
  - A coloured thread re-keys those tokens to its colour on its conversation panel and Threads row, so overlays inside stay in its hue. Never hardcode a grey or `var(--muted)` there.
- Palette tokens (`--bs-*` in `packages/ui/src/themes/`) hold complete colours.
  - Use a token as `var(--x)`, and `color-mix(in oklab, var(--x) N%, transparent)` for alpha.
  - The palette is `data-theme` on `<html>`, set by `ThemeProvider` beside the light/dark class.
  - Generated palettes come from `scripts/import-shadcn-theme.mjs`; re-run it rather than editing values.
  - They override only the shadcn colour set and radius, so status, delegation and syntax tokens stay the baseline's, and the high-contrast block in `globals.css` wins over every palette.
- Syntax colours follow the code themes chosen for light and dark mode (`data-code-theme-light`/`-dark`, registry in `themes/code-themes.ts`).
  - CodeMirror uses the `--syntax-*` tokens in `themes/code-themes.css`; code blocks use the theme's Shiki pair. The code box owns its background.
  - Generate a new code theme's tokens with `scripts/import-code-theme.mjs` from the same Shiki pair.
- Fonts are the `--font-sans` and `--font-mono` stacks `ThemeProvider` writes on `<html>` (`themes/fonts.ts`). Use `font-sans`/`font-mono` or those variables, never a literal stack, so the Appearance choice reaches every surface.
- Scrollbars inherit one translucent thumb from `body`.

## Context actions and layers

- Use the shared registry with immutable targets claimed synchronously at invocation.
  - RootId is identity, not a path.
  - Gate actions through validated capabilities and revalidate destructive targets at execution.
  - A broken bridge reports failure; a missing capability is never a silent no-op.
  - Functions stay in their owning renderer and are never serialized as native menu actions.
- Right-click and menu close keep the originating focus owner. Editable controls keep their native interaction.
- Destructive thread actions enter confirmation; closing a tab never deletes its history.
- A right-click no surface claims opens main's native page menu (`apps/desktop/src/page-context-menu.ts`): Copy over a selection; Cut, Copy, Paste and Select All in a field; spelling fixes; Copy Link and Copy Image.
  - Cancelling the DOM `contextmenu` event suppresses it, so a surface whose own menu covers text offers Copy itself.
- Floating layers use shared tokens: panels above their scrims, nested scrims above parent panels, popups above dialogs.
  - Nesting follows lexical ownership.
  - Don't transform popup anchors or build dynamic Tailwind classes the scanner can't emit.
  - Layer readiness and visible occlusion matter, not clickability alone.
- Browser pages are native views main draws above the DOM, so no DOM layer can cover one.
  - Main owns the page list; each page belongs to one thread. That thread's workspace tabs mirror it, and closing a tab closes its page.
  - A page shows only while its tab is selected on the Explorer route and no palette or workspace menu is open. A menu that drops over the workspace reports its open state through `useMenuOpenReporter`.

## Reload and presentation

- A lazy-chunk failure offers an explicit user reload through AppReloadGate.
  - Keep active-run survival/confirmation and unknown-state handling; no automatic reload loop.
  - TabPanelBoundary contains failures without silently dropping work.
- Workspace Tailwind sources must reach every app that renders them.
- Reuse semantic colors and measure contrast on the actual painted surface in both themes.
  - 4.5:1 for small text and sole-signal status glyphs; 3:1 for meaningful non-text indicators.
  - Focus and status stay visible without color alone. Respect reduced motion and forced colors.
- Shared step, approval and tab geometry and durable child accents are the visual grammar. Don't derive another identity from a hash or move ownership into presentation.
