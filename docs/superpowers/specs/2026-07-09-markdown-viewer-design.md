# Markdown Viewer — Design Spec

**Date:** 2026-07-09
**Status:** Approved (brainstorm complete)
**Scope:** First-class markdown preview for workspace file tabs, with a per-tab header bar and a Source/Preview toggle.

## Goal

Clicking a `.md` file in the explorer/search opens it as fully rendered markdown. Every file tab gains a slim header bar; markdown tabs get a two-segment **Source / Preview** toggle. Preview is the default mode for markdown files.

## Decisions (locked during brainstorm)

| Decision | Choice |
|---|---|
| Header bar scope | **All file tabs** get the header (filename + muted directory path + right-side actions slot); only markdown tabs show the toggle |
| Default mode | **Preview** for markdown files |
| Mode persistence | **Per-file memory** — persisted per `compositeKey` in `editor-view-state-store` |
| Line-targeted opens (search matches, chunk rows) | **Force source transiently** for that open; persisted mode untouched |
| Preview features | GFM, Shiki code fences, **safe link handling, local relative images, mermaid, KaTeX math** |
| Frontmatter | Parsed and rendered as a **muted key–value properties block** above the prose |
| Pipeline | **`react-markdown` v10** + unified plugins (not `@assistant-ui/react-markdown`, which is coupled to chat message-part context) |
| `.mdx` | **Source-only in v1** (JSX; not safely renderable by a markdown pipeline) |
| Typography | Add **`@tailwindcss/typography`** (Tailwind v4 `@plugin` directive); `prose prose-sm dark:prose-invert max-w-none` + token overrides |

Markdown extensions recognized for the toggle: `.md`, `.markdown`, `.mdown`, `.mkd`.

## Architecture

### New/changed units

1. **`MarkdownSurface`** — new component, `packages/ui/src/markdown-surface/` (sibling of `code-surface/`). Pure presentational peer of `CodeSurface`.
   - Props: `value` (markdown string), `path`, `initialScrollTop?`, `onScrollTopChange?`, `onOpenLink(href)`, `resolveImageSrc(relativePath) => Promise<string>`, `testId?`.
   - Knows nothing about Electron, tabs, or stores. Platform behaviors are **injected capabilities** (house Context Action System pattern: no `isElectron()` checks in ui package; missing capability = visible error state, never silent degradation).

2. **`FileTabHeader`** — new slim header rendered inside `FileTabBody` for **all** file tabs. Left: filename + muted directory path. Right: actions slot; markdown tabs render the Source/Preview segmented toggle there. Home for future per-file actions (copy path, word wrap, …).

3. **`editor-view-state-store`** (`packages/file-explorer-ui/src/stores/editor-view-state-store.ts`) — add persisted `modes: Record<compositeKey, 'source' | 'preview'>` with `getMode`/`setMode`; include in `partialize`; bump persist version with migration. Preview scroll gets its own slot keyed `preview:${compositeKey}` so source and preview each restore independent positions.

### Wiring point

`FileTabBody` in `packages/file-explorer-ui/src/shell/workspace-tab-host.tsx` is the single branch point:

- `isMarkdown` from extension list above.
- Effective mode resolution: if a one-shot view target exists for the key (search-match open) → `source` transiently (do not write to store). Else persisted mode, defaulting to `preview` for markdown.
- Content loading unchanged — both modes consume the same `fileContents[compositeKey]` string.
- `MarkdownSurface` is `React.lazy` here (KaTeX CSS rides along); non-markdown workflows pay zero bytes.
- Error boundary around the preview: render crash shows "Preview failed to render" + error + a one-click **"Open in source"** escape hatch. Source mode always works.

## Platform capabilities

### External links (`onOpenLink`)

- **Desktop:** new `openExternal(url)` handler in the existing `shell` IPC domain (`apps/desktop/src/ipc-shell.ts`), exposed on the `window.platform` preload bridge. Protocol allowlist: `http:`, `https:`, `mailto:` — everything else (`file:`, `javascript:`, custom schemes) rejected in **main** before reaching `shell.openExternal`.
- **Web:** `window.open(url, '_blank', 'noopener,noreferrer')` behind the same allowlist.
- **Relative `.md` links** (for example, a link to `./design.md`): resolve against the file's path; if inside a mounted workspace root, open via the existing `openFileInTab(compositeKey)` ide-layout seam. Outside mounted roots → toast ("outside workspace"). Never a silent no-op.
- **Anchor links** (`#heading`): in-preview scroll; `rehype-slug` provides stable heading ids.

### Local relative images (`resolveImageSrc`)

- **Desktop:** custom protocol `brainstrike-asset://` registered in main via `protocol.handle()`. Main validates the decoded path is inside a mounted workspace root before streaming bytes. `resolveImageSrc` builds the URL only — no per-image IPC, browser-native caching. (Renderer-supplied paths are hostile input; validation lives only in main.)
- **Web:** resolve through workspace File System Access handles → `URL.createObjectURL(file)`; blob URLs revoked on unmount.
- **Failure is visible:** root-validation or read failure renders an explicit "image unavailable: `<path>`" placeholder block.

## Rendering pipeline

Plugin chain in `MarkdownSurface`:

- `remark-gfm` — tables, task lists, strikethrough, autolinks.
- `remark-frontmatter` — removes the `---` block from prose; parsed with `yaml`; rendered as the muted key–value **properties block**. Unparseable YAML → raw block with visible "invalid frontmatter" note.
- `remark-math` + `rehype-katex` — `$…$` / `$$…$$`. KaTeX CSS imported only by the lazy-loaded `MarkdownSurface`.
- `rehype-slug` — heading ids.
- **No `rehype-raw`** — raw HTML stays inert text (react-markdown safe default). Default `urlTransform` sanitization stays on.

Custom `components` map:

- Code fences → existing Shiki `SyntaxHighlighterComponent` (shared with chat; one cached highlighter instance, github-light/dark theme pair).
- ` ```mermaid ` fences → `MermaidBlock`: lazy `import('mermaid')` on first sight; parse error renders the error message **plus** the fenced source.
- `a` → link interception per above; `img` → async resolve with explicit-failure placeholder.

New dependencies (packages/ui unless noted): `react-markdown`, `remark-frontmatter`, `remark-math`, `rehype-katex`, `rehype-slug`, `katex`, `yaml`, `mermaid` (lazy), `@tailwindcss/typography` (tailwind config package).

## Security posture

A hostile `.md` in a mounted workspace cannot: execute script (no raw HTML, url sanitization), exfiltrate via `file:` loads (protocol allowlist + root-validated asset protocol), or navigate the renderer (all links intercepted; external opens go through main-process `shell.openExternal`).

**Amendment (2026-07-09, user-approved):** the asset protocol returns a uniform 404 for both missing and outside-root paths so it cannot be used as a filesystem existence oracle; the outside-root case is still logged in main.

**Amendment (2026-07-09, PR #1543 review):** remote http(s) images are blocked in the renderer with a visible placeholder — preview content must not trigger network requests (packages/file-explorer-ui/AGENTS.md resource-loading restriction), independent of CSP, which permits localhost in dev and is deployment-dependent on web.

## Error handling summary

| Failure | Behavior |
|---|---|
| Preview render crash | Error boundary: message + "Open in source" escape hatch |
| Mermaid parse error | Inline error + fenced source shown |
| Image unresolvable / outside root | Explicit "image unavailable" placeholder |
| Invalid frontmatter YAML | Raw muted block + "invalid frontmatter" note |
| Relative link outside workspace | Toast |
| Oversized document | No preview-side cap in v1 (upstream `truncated` handling unchanged) |

## Testing (Vitest, RED/GREEN)

- **packages/ui — `MarkdownSurface`:** GFM constructs render; raw HTML inert; frontmatter properties block (valid + invalid YAML); link clicks call `onOpenLink`, never navigate; image failure placeholder; mermaid error path (mermaid mocked); scroll callback contract.
- **packages/file-explorer-ui — `FileTabBody` / header:** header on all tabs; toggle only on markdown; default preview for `.md`, source for `.mdx`/others; per-file mode persistence (partialize + version migration); line-target open forces source **without mutating persisted mode**; error-boundary escape hatch.
- **apps/desktop main:** `openExternal` allowlist; `brainstrike-asset` root validation (reject traversal, reject outside-root).
- No new E2E lanes in v1; existing smoke suites cover the tab surface.

## Out of scope (v1)

- `.mdx` rendering (source-only).
- Best-effort preview scroll-to-source-line mapping for search targets.
- Editing in preview mode (surfaces are read-only today).
- Preview-side document size cap.
