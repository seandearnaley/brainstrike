# Markdown viewer and file-tab surfaces — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "MARKDOWN VIEWER".
Read before changing the file-tab header, the Source/Preview toggle, markdown-surface plugins, preview capabilities, or binary-file handling.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '152,195p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

## MARKDOWN VIEWER (FILE TABS)

Every file tab renders a slim `FileTabHeader` (filename + directory + actions
slot). Markdown files (.md/.markdown/.mdown/.mkd — NOT .mdx, source-only)
additionally get a Source/Preview toggle; preview is the default.

- **Surfaces:** `CodeSurface` (source) vs `MarkdownSurface`
  (packages/ui/src/markdown-surface/ — react-markdown v10 + remark-gfm +
  remark-math/rehype-katex + rehype-slug; shiki fences share the chat's cached
  highlighter via packages/ui/src/shiki/highlighter-core.ts; ```mermaid fences
  lazy-load mermaid). Raw HTML stays inert (no rehype-raw). Frontmatter is
  pre-extracted (packages/ui/src/markdown-surface/frontmatter.ts) into a
  properties block; invalid YAML renders visibly.
- **Mode state:** persisted per compositeKey in editor-view-state-store
  (`modes`, store version 2); preview scroll under `preview:${compositeKey}`.
  A one-shot view target (search-match open) forces source TRANSIENTLY without
  writing the store.
- **Capabilities (injected, never isElectron()):**
  `MarkdownPreviewCapabilitiesProvider` (file-explorer-ui) composed by
  app-shell's `useMarkdownPreviewCapabilitiesValue`. External links: desktop →
  `window.platform.openExternal` (allowlisted http/https/mailto in MAIN,
  apps/desktop/src/ipc-shell-handlers.ts); web → window.open noopener. Images:
  desktop → `brainstrike-asset://local/asset?path=…` (protocol handler in
  apps/desktop/src/asset-protocol.ts realpath-validates containment in mounted
  DB roots; CSP img-src includes the scheme); web → FS Access handle →
  object URL (revoked on unmount). Remote http(s) images are BLOCKED in the
  renderer (visible placeholder) — untrusted file content must not trigger
  network requests, independent of CSP. Every failure is visible (placeholder,
  toast, or error block) — no silent fallbacks.
- **Crash safety:** MarkdownPreviewErrorBoundary offers "Open in source".
- **Binary files:** the content worker returns an `inaccessible` structured
  result whose message is `BINARY_CONTENT_MESSAGE` (`@brainstrike/types`).
  Background indexing/import branches only on that discriminated status — it
  never classifies accessibility from message text. UI loading boundaries
  project the message to the tab's content; `FileTabBody` exact-matches it and
  renders `BinaryFilePreview` (file-explorer-ui/components) instead of a code
  surface. Its buttons are a
  projection of the shared context-action registry (`file.reveal-in-os`,
  `file.open-in-default-app`, one copy-path variant) — same capability gating
  as the right-click menu, so web builds without fs bridges just show fewer
  buttons, and failures toast + log (no silent fallbacks). Paired test:
  `file-explorer-ui/src/shell/__tests__/file-tab-body-binary.test.tsx`.

When changing this flow, update this section and the paired tests.
