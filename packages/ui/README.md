# @brainstrike/ui

Shared shadcn/Radix components, TreeTable/TabStrip primitives, markdown/code
surfaces and theme assets. The assistant feature belongs to
[`@brainstrike/assistant-ui`](../assistant-ui/README.md), with app integration in
`@brainstrike/app-shell`.

## Styles and imports

App CSS owns its single Tailwind entry; import the UI theme variables after it:

```css
@import "tailwindcss";
@import "@brainstrike/ui/globals.css";
```

`@brainstrike/ui/styles.css` supplies the package's source-scanning directive when
needed by the consuming build. Follow the existing app Vite/Tailwind configuration;
this package does not require a second PostCSS pipeline.

Components such as `Button` and `Input` are root exports. Use the manifest's
explicit code/markdown/icon subpaths for those boundaries. Component props and
exported hooks come from the source; the old `/hooks`/`usePanelPersistence` layout
example is not a current public entrypoint.

## Invariants

TreeTable owns the shared treegrid and its two-axis scrollport. TabStrip, context
actions and modal/focus layering retain their existing accessible interaction
contracts. Do not create per-feature virtual lists or context-menu systems.

Shared UI is browser-safe: consumers inject capabilities and callback events.
It does not import Electron, own preference stores or access platform bridges
itself. Cached highlighting and code/markdown surfaces reuse their existing
resource owners. Keep feature-specific runtime/persistence out of primitives.

See [UI conventions](../../docs/agents/ui-conventions.md) and
[explorer contracts](../../docs/agents/explorer-search-context-map.md).
[`package.json`](package.json) owns dependencies, exports and scripts; use
[shared contribution/validation policy](../../AGENTS.md).
