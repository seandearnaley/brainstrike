# @brainstrike/ui

Shared shadcn/Radix components, TreeTable/TabStrip primitives, markdown/code surfaces and theme assets. The assistant feature lives in [`@brainstrike/assistant-ui`](../assistant-ui/README.md); app integration in `@brainstrike/app-shell`. Package rules: [`AGENTS.md`](AGENTS.md).

## Styles and imports

- The app CSS owns the single Tailwind entry; import the theme after it:

  ```css
  @import "tailwindcss";
  @import "@brainstrike/ui/globals.css";
  ```

- `@brainstrike/ui/styles.css` supplies the source-scanning directive for consuming builds. No separate PostCSS pipeline.
- Components such as `Button` and `Input` are root exports; `/code-block`, `/markdown-surface`, `/mermaid-block` and `/use-toast` are subpaths.

## Invariants

- TreeTable owns the shared treegrid and its two-axis scrollport. TabStrip, context actions and modal/focus layering keep their accessible contracts. No per-feature virtual lists or context-menu systems.
- Browser-safe: consumers inject capabilities and receive callback events. No Electron imports, preference stores or platform bridges.
- Highlighting and code/markdown surfaces reuse their cached resource owners; keep feature runtime and persistence out of primitives.
- Contracts: [UI conventions](../../docs/agents/ui-conventions.md), [explorer](../../docs/agents/explorer-search-context-map.md).
