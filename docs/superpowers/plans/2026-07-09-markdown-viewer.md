# Markdown Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a `.md` file opens a fully rendered markdown preview in its workspace tab, with a new per-tab header bar carrying a Source/Preview toggle.

**Architecture:** A new presentational `MarkdownSurface` in `@brainstrike/ui` (react-markdown v10 + Shiki + lazy mermaid + KaTeX) renders behind a lazy boundary in `FileTabBody` (`packages/file-explorer-ui/src/shell/workspace-tab-host.tsx`), which grows a universal `FileTabHeader`. Per-file mode persists in `editor-view-state-store`. Platform capabilities (external links, image bytes) are injected via a context composed in app-shell; desktop adds an `openExternal` IPC handler and a root-validated `brainstrike-asset://` protocol.

**Tech Stack:** React 19, Vite, TypeScript strict, Zustand persist, react-markdown v10, remark-gfm, remark-math, rehype-katex, rehype-slug, katex, yaml, mermaid v11, react-shiki, Tailwind v4 + @tailwindcss/typography, Vitest (happy-dom), Electron.

**Spec:** `docs/superpowers/specs/2026-07-09-markdown-viewer-design.md`

## Global Constraints

- TypeScript strict, **never `any`** — use `unknown` + narrowing.
- **No silent fallbacks**: every failure path renders visible UI (placeholder/toast/error block) or returns `{ ok: false, error }`.
- Filenames kebab-case; components PascalCase exports; hooks `use-*.ts`.
- Tests colocated in `__tests__/` dirs, `*.test.ts(x)`, happy-dom environment, `@testing-library/react`.
- Do NOT run dev servers or `pnpm build` (user rule); verification = vitest + type-check + lint. Lefthook pre-commit runs ultracite-fix + type-check on staged files automatically.
- RED/GREEN TDD: write the failing test, see it fail, implement, see it pass, commit.
- Branch: all work on `feature/markdown-viewer` (already created; spec committed).
- `exactOptionalPropertyTypes` is on: omit optional props entirely rather than passing `undefined` explicitly where object literals are typed.
- Plan deviation from spec (deliberate): `remark-frontmatter` is replaced by a pre-parse `extractFrontmatter()` — the properties block needs parsed data before react-markdown runs, making the plugin redundant. Behavior identical.

---

### Task 1: `resolveRelativePath` utility in @brainstrike/utils

**Files:**
- Create: `packages/utils/src/relative-path.ts`
- Modify: `packages/utils/src/index.ts` (add export)
- Test: `packages/utils/src/__tests__/relative-path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveRelativePath(baseFilePath: string, relative: string): string | null` — resolves `relative` against the directory of `baseFilePath`; returns a normalized path using `/` separators, or `null` when the relative path escapes above the base path's root (leading-`..` overflow). Later tasks (9) use it for markdown link/image resolution.

- [ ] **Step 1: Write the failing test**

```ts
// packages/utils/src/__tests__/relative-path.test.ts
import { describe, expect, it } from 'vitest';
import { resolveRelativePath } from '../relative-path';

describe('resolveRelativePath', () => {
  it('resolves a sibling file', () => {
    expect(resolveRelativePath('/root/docs/readme.md', 'design.md')).toBe('/root/docs/design.md');
  });
  it('resolves ./ prefixed paths', () => {
    expect(resolveRelativePath('/root/docs/readme.md', './img/a.png')).toBe('/root/docs/img/a.png');
  });
  it('resolves ../ within bounds', () => {
    expect(resolveRelativePath('/root/docs/readme.md', '../src/main.ts')).toBe('/root/src/main.ts');
  });
  it('keeps the leading slash of absolute bases', () => {
    expect(resolveRelativePath('/a.md', 'b.md')).toBe('/b.md');
  });
  it('works with relative (web) base paths', () => {
    expect(resolveRelativePath('workspace/docs/readme.md', '../a.md')).toBe('workspace/a.md');
  });
  it('returns null when escaping above the root of the base path', () => {
    expect(resolveRelativePath('/root/readme.md', '../../etc/passwd')).toBeNull();
    expect(resolveRelativePath('docs/readme.md', '../../a.md')).toBeNull();
  });
  it('tolerates backslash separators in the relative segment', () => {
    expect(resolveRelativePath('/root/docs/readme.md', 'img\\a.png')).toBe('/root/docs/img/a.png');
  });
  it('collapses . segments and empty segments', () => {
    expect(resolveRelativePath('/root/docs/readme.md', './/./a.md')).toBe('/root/docs/a.md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @brainstrike/utils exec vitest run src/__tests__/relative-path.test.ts`
Expected: FAIL — `Cannot find module '../relative-path'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

```ts
// packages/utils/src/relative-path.ts
/**
 * Resolve `relative` against the directory of `baseFilePath` using pure string
 * math (no node:path — this runs in renderers). Returns a normalized path with
 * `/` separators, or null when the relative path climbs above the root of the
 * base path (an escape a caller must treat as out-of-workspace).
 */
export function resolveRelativePath(baseFilePath: string, relative: string): string | null {
  const isAbsolute = baseFilePath.startsWith('/');
  const baseSegments = baseFilePath.split(/[\\/]+/).filter((s) => s.length > 0);
  // Drop the file name; what remains is the directory.
  baseSegments.pop();
  const stack = [...baseSegments];
  for (const part of relative.split(/[\\/]+/)) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      if (stack.length === 0) {
        return null;
      }
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack.length === 0) {
    return null;
  }
  return (isAbsolute ? '/' : '') + stack.join('/');
}
```

Add to `packages/utils/src/index.ts` alongside the existing exports:

```ts
export { resolveRelativePath } from './relative-path';
```

(If `packages/utils/src/index.ts` uses a different export idiom — e.g. subpath-only exports — match the pattern used by `selection-utils`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @brainstrike/utils exec vitest run src/__tests__/relative-path.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/relative-path.ts packages/utils/src/index.ts packages/utils/src/__tests__/relative-path.test.ts
git commit -m "feat(utils): add resolveRelativePath for workspace-relative link resolution"
```

---

### Task 2: Extract the shared Shiki highlighter core in @brainstrike/ui

Pure refactor: the module-private highlighter cache in `packages/ui/src/assistant-ui-panel/shiki-highlighter.tsx` moves to a shared module so the markdown preview reuses the SAME cached instance (one WASM + grammar load for chat and preview).

**Files:**
- Create: `packages/ui/src/shiki/highlighter-core.ts`
- Modify: `packages/ui/src/assistant-ui-panel/shiki-highlighter.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: from `packages/ui/src/shiki/highlighter-core.ts`:
  - `useShikiHighlighter(): HighlighterCore | null` (hook; null until loaded or on failure)
  - `normalizeShikiLanguage(language: string | undefined): string` (alias + allowlist, falls back to `'plaintext'`)
  - Task 4's `ShikiCodeBlock` consumes both.

- [ ] **Step 1: Create the shared module**

Move — verbatim, do not rewrite — these pieces out of `packages/ui/src/assistant-ui-panel/shiki-highlighter.tsx` into `packages/ui/src/shiki/highlighter-core.ts`: `LANGUAGE_ALLOWLIST`, `LANGUAGE_ALIASES`, the `highlighterPromise`/`highlighterCache`/`highlighterFailed` module state, `getHighlighter`, `normalizeLanguage`, and `useHighlighter`. Export them renamed:

```ts
// packages/ui/src/shiki/highlighter-core.ts — exports (bodies moved verbatim)
export const normalizeShikiLanguage = normalizeLanguage;
export const useShikiHighlighter = useHighlighter;
```

(Keep the `createLogger('SyntaxHighlighter')` logger; move the imports it needs. The file keeps `react-shiki/core`'s `createHighlighterCore`/`createOnigurumaEngine` imports and all 16 `@shikijs/langs/*` dynamic imports and both theme imports exactly as they are.)

- [ ] **Step 2: Rewrite the consumer to use it**

`packages/ui/src/assistant-ui-panel/shiki-highlighter.tsx` shrinks to the component only:

```tsx
import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown';
import { memo, useMemo } from 'react';
import ShikiHighlighter from 'react-shiki/core';
import { normalizeShikiLanguage, useShikiHighlighter } from '../shiki/highlighter-core';

const SyntaxHighlighterImpl = ({ language, code, components }: SyntaxHighlighterProps) => {
  const highlighter = useShikiHighlighter();
  const resolvedLanguage = useMemo(() => normalizeShikiLanguage(language), [language]);

  if (!(code && highlighter)) {
    const { Pre, Code } = components;
    return (
      <Pre>
        <Code>{code}</Code>
      </Pre>
    );
  }

  return (
    <ShikiHighlighter
      className="overflow-hidden rounded-md"
      delay={50}
      highlighter={highlighter}
      language={resolvedLanguage}
      theme={{ dark: 'github-dark', light: 'github-light' }}
    >
      {code}
    </ShikiHighlighter>
  );
};

export const SyntaxHighlighterComponent = memo(SyntaxHighlighterImpl);
```

- [ ] **Step 3: Run the ui unit suite + type-check to prove the refactor is behavior-neutral**

Run: `pnpm --filter @brainstrike/ui test && pnpm --filter @brainstrike/ui type-check`
Expected: all existing tests PASS, type-check clean.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/shiki/highlighter-core.ts packages/ui/src/assistant-ui-panel/shiki-highlighter.tsx
git commit -m "refactor(ui): extract shared shiki highlighter core for reuse by markdown preview"
```

---

### Task 3: `isMarkdownPath` + `extractFrontmatter` (with `yaml` dep)

**Files:**
- Create: `packages/ui/src/markdown-surface/is-markdown-path.ts`
- Create: `packages/ui/src/markdown-surface/frontmatter.ts`
- Modify: `packages/ui/src/index.ts` (export `isMarkdownPath` from the root barrel — it is tiny and file-explorer-ui needs it eagerly; `MarkdownSurface` itself is deliberately NOT root-exported)
- Modify: `packages/ui/package.json` (dep)
- Test: `packages/ui/src/markdown-surface/__tests__/is-markdown-path.test.ts`
- Test: `packages/ui/src/markdown-surface/__tests__/frontmatter.test.ts`

**Interfaces:**
- Produces:
  - `isMarkdownPath(path: string): boolean` — true for `.md`, `.markdown`, `.mdown`, `.mkd` (case-insensitive). `.mdx` is deliberately false (source-only in v1).
  - `extractFrontmatter(markdown: string): FrontmatterResult` where `FrontmatterResult = { body: string; data: Record<string, unknown> | null; raw: string | null; error: string | null }` — `data` set only for a valid YAML mapping; `error` + `raw` set for invalid YAML or non-mapping; no frontmatter → `body === markdown`, everything else null.

- [ ] **Step 1: Add the yaml dependency**

Run: `pnpm --filter @brainstrike/ui add yaml`
Expected: `yaml` appears in `packages/ui/package.json` dependencies.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/ui/src/markdown-surface/__tests__/is-markdown-path.test.ts
import { describe, expect, it } from 'vitest';
import { isMarkdownPath } from '../is-markdown-path';

describe('isMarkdownPath', () => {
  it.each(['/a/readme.md', 'notes.markdown', 'a.mdown', 'b.mkd', 'UPPER.MD'])(
    'accepts %s',
    (p) => {
      expect(isMarkdownPath(p)).toBe(true);
    }
  );
  it.each(['component.mdx', 'main.ts', 'md', 'file.md.bak', 'a.txt'])('rejects %s', (p) => {
    expect(isMarkdownPath(p)).toBe(false);
  });
});
```

```ts
// packages/ui/src/markdown-surface/__tests__/frontmatter.test.ts
import { describe, expect, it } from 'vitest';
import { extractFrontmatter } from '../frontmatter';

describe('extractFrontmatter', () => {
  it('passes through documents without frontmatter', () => {
    const r = extractFrontmatter('# Hello\n');
    expect(r).toEqual({ body: '# Hello\n', data: null, error: null, raw: null });
  });
  it('extracts a YAML mapping and removes it from the body', () => {
    const r = extractFrontmatter('---\ntitle: Test\ntags:\n  - a\n---\n# Body\n');
    expect(r.data).toEqual({ tags: ['a'], title: 'Test' });
    expect(r.body).toBe('# Body\n');
    expect(r.error).toBeNull();
  });
  it('handles CRLF and BOM', () => {
    const r = extractFrontmatter('﻿---\r\ntitle: X\r\n---\r\nbody');
    expect(r.data).toEqual({ title: 'X' });
    expect(r.body).toBe('body');
  });
  it('reports invalid YAML with the raw block, never throws', () => {
    const r = extractFrontmatter('---\n: : :\n---\nbody');
    expect(r.data).toBeNull();
    expect(r.raw).toBe(': : :');
    expect(typeof r.error).toBe('string');
    expect(r.body).toBe('body');
  });
  it('reports non-mapping YAML (a list) as an error', () => {
    const r = extractFrontmatter('---\n- a\n- b\n---\nbody');
    expect(r.data).toBeNull();
    expect(r.error).toMatch(/mapping/i);
  });
  it('does not treat a mid-document --- as frontmatter', () => {
    const src = 'intro\n---\ntitle: nope\n---\n';
    expect(extractFrontmatter(src).body).toBe(src);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/markdown-surface/__tests__/`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

```ts
// packages/ui/src/markdown-surface/is-markdown-path.ts
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);

/** True when the path's extension is a plain-markdown extension. `.mdx` is
 * deliberately excluded (JSX — source-only in v1). */
export function isMarkdownPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot <= 0 || dot === path.length - 1) {
    return false;
  }
  return MARKDOWN_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
```

```ts
// packages/ui/src/markdown-surface/frontmatter.ts
import { parse } from 'yaml';

export interface FrontmatterResult {
  /** Markdown with the frontmatter block removed. */
  readonly body: string;
  /** Parsed YAML mapping, or null when absent/invalid/non-mapping. */
  readonly data: Record<string, unknown> | null;
  /** Parse/shape error message; null when absent or valid. */
  readonly error: string | null;
  /** The raw YAML text between the fences; null when absent. */
  readonly raw: string | null;
}

// Frontmatter must open the document: optional BOM, `---`, newline, content,
// closing `---` (or YAML's `...`) on its own line.
const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/;

export function extractFrontmatter(markdown: string): FrontmatterResult {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) {
    return { body: markdown, data: null, error: null, raw: null };
  }
  const raw = match[1] ?? '';
  const body = markdown.slice(match[0].length);
  try {
    const parsed: unknown = parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { body, data: parsed as Record<string, unknown>, error: null, raw };
    }
    return { body, data: null, error: 'Frontmatter is not a YAML mapping', raw };
  } catch (error) {
    return { body, data: null, error: error instanceof Error ? error.message : String(error), raw };
  }
}
```

Export `isMarkdownPath` from `packages/ui/src/index.ts` (match neighboring export style).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/markdown-surface/__tests__/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/markdown-surface packages/ui/src/index.ts packages/ui/package.json pnpm-lock.yaml
git commit -m "feat(ui): markdown path detection and frontmatter extraction"
```

---

### Task 4: `MarkdownSurface` component + `./markdown-surface` subpath export

**Files:**
- Create: `packages/ui/src/markdown-surface/markdown-surface.tsx`
- Create: `packages/ui/src/markdown-surface/markdown-code-block.tsx` (fence dispatch + `ShikiCodeBlock`)
- Create: `packages/ui/src/markdown-surface/markdown-image.tsx`
- Create: `packages/ui/src/markdown-surface/frontmatter-block.tsx`
- Create: `packages/ui/src/markdown-surface/index.ts`
- Modify: `packages/ui/package.json` (deps + exports entry)
- Test: `packages/ui/src/markdown-surface/__tests__/markdown-surface.test.tsx`

**Interfaces:**
- Consumes: Task 2 (`useShikiHighlighter`, `normalizeShikiLanguage`), Task 3 (`extractFrontmatter`), Task 5's `MermaidBlock` (stub it in THIS task as described below; Task 5 replaces the stub).
- Produces (consumed by Task 9):

```ts
export interface MarkdownSurfaceProps {
  /** Accessible label for the scrollable region. */
  readonly ariaLabel?: string;
  readonly initialScrollTop?: number;
  /** Non-anchor link clicks (http, mailto, relative paths) — the host decides. */
  readonly onOpenLink: (href: string) => void;
  readonly onScrollTopChange?: (scrollTop: number) => void;
  /** Resolve a raw image src (relative or absolute path) to a displayable URL. Reject => visible placeholder. */
  readonly resolveImageSrc: (src: string) => Promise<string>;
  readonly testId?: string;
  /** Set when the host truncated the document (mirrors CodeSurface's contract). */
  readonly truncated?: boolean;
  readonly value: string;
}
export function MarkdownSurface(props: MarkdownSurfaceProps): JSX.Element;
```

- Subpath import: `import { MarkdownSurface } from '@brainstrike/ui/markdown-surface'` — NOT exported from the root barrel (keeps katex/react-markdown out of the eager chunk).

- [ ] **Step 1: Add dependencies**

Run: `pnpm --filter @brainstrike/ui add react-markdown remark-math rehype-katex rehype-slug katex`
(`remark-gfm` is already a dependency.)

- [ ] **Step 2: Add the subpath export**

In `packages/ui/package.json` `exports`, mirror the existing `./assistant-ui-panel` entry:

```json
"./markdown-surface": {
  "types": "./dist/markdown-surface/index.d.ts",
  "import": "./dist/markdown-surface/index.js"
}
```

- [ ] **Step 3: Write the failing tests**

Mock the heavy leaves so the suite tests MarkdownSurface's own logic (fence dispatch, frontmatter, links, images, scroll):

```tsx
// packages/ui/src/markdown-surface/__tests__/markdown-surface.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownSurface } from '../markdown-surface';

vi.mock('../markdown-code-block', () => ({
  MarkdownCodeBlock: ({ code, language }: { code: string; language: string }) => (
    <div data-language={language} data-testid="code-block">
      {code}
    </div>
  ),
}));
vi.mock('../mermaid-block', () => ({
  MermaidBlock: ({ code }: { code: string }) => <div data-testid="mermaid-block">{code}</div>,
}));

const noopResolve = () => new Promise<string>(() => undefined);

function renderSurface(value: string, overrides: Partial<Parameters<typeof MarkdownSurface>[0]> = {}) {
  return render(
    <MarkdownSurface onOpenLink={vi.fn()} resolveImageSrc={noopResolve} value={value} {...overrides} />
  );
}

describe('MarkdownSurface', () => {
  it('renders GFM: headings, tables, task lists, strikethrough', () => {
    renderSurface('# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n~~gone~~\n');
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText('gone').tagName).toBe('DEL');
  });

  it('keeps raw HTML inert (no script/iframe execution)', () => {
    const { container } = renderSurface('before\n\n<script>window.__pwned = true</script>\n\n<iframe src="x"></iframe>\n');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('routes fenced code to MarkdownCodeBlock with the language', () => {
    renderSurface('```ts\nconst x = 1;\n```\n');
    const block = screen.getByTestId('code-block');
    expect(block).toHaveAttribute('data-language', 'ts');
    expect(block).toHaveTextContent('const x = 1;');
  });

  it('routes mermaid fences to MermaidBlock', () => {
    renderSurface('```mermaid\ngraph TD; a-->b;\n```\n');
    expect(screen.getByTestId('mermaid-block')).toHaveTextContent('graph TD; a-->b;');
  });

  it('renders valid frontmatter as a properties block, removed from prose', () => {
    renderSurface('---\ntitle: Spec\n---\n# Body\n');
    expect(screen.getByTestId('markdown-frontmatter')).toHaveTextContent('title');
    expect(screen.getByTestId('markdown-frontmatter')).toHaveTextContent('Spec');
    expect(screen.queryByText(/title: Spec/)).not.toBeInTheDocument();
  });

  it('renders invalid frontmatter visibly with the raw block', () => {
    renderSurface('---\n: : :\n---\nbody\n');
    expect(screen.getByTestId('markdown-frontmatter-error')).toHaveTextContent(/invalid frontmatter/i);
    expect(screen.getByTestId('markdown-frontmatter-error')).toHaveTextContent(': : :');
  });

  it('intercepts link clicks: onOpenLink fires, default navigation is prevented', () => {
    const onOpenLink = vi.fn();
    renderSurface('[site](https://example.com)\n', { onOpenLink });
    const link = screen.getByRole('link', { name: 'site' });
    fireEvent.click(link);
    expect(onOpenLink).toHaveBeenCalledWith('https://example.com');
  });

  it('shows an explicit placeholder when image resolution rejects', async () => {
    const resolveImageSrc = vi.fn().mockRejectedValue(new Error('outside root'));
    renderSurface('![diagram](./missing.png)\n', { resolveImageSrc });
    await waitFor(() => {
      expect(screen.getByTestId('markdown-image-error')).toHaveTextContent('./missing.png');
    });
  });

  it('renders resolved images with the resolved src', async () => {
    const resolveImageSrc = vi.fn().mockResolvedValue('blob:fake');
    renderSurface('![diagram](./ok.png)\n', { resolveImageSrc });
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'diagram' })).toHaveAttribute('src', 'blob:fake');
    });
  });

  it('reports scroll position changes', () => {
    const onScrollTopChange = vi.fn();
    renderSurface('# a\n', { onScrollTopChange, testId: 'md-surface' });
    fireEvent.scroll(screen.getByTestId('md-surface'), { target: { scrollTop: 120 } });
    expect(onScrollTopChange).toHaveBeenCalledWith(120);
  });

  it('shows a truncation notice when truncated', () => {
    renderSurface('# a\n', { truncated: true });
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/markdown-surface/__tests__/markdown-surface.test.tsx`
Expected: FAIL — `markdown-surface` module not found.

- [ ] **Step 5: Implement the leaves**

```tsx
// packages/ui/src/markdown-surface/markdown-code-block.tsx
import { memo } from 'react';
import ShikiHighlighter from 'react-shiki/core';
import { normalizeShikiLanguage, useShikiHighlighter } from '../shiki/highlighter-core';

export interface MarkdownCodeBlockProps {
  readonly code: string;
  readonly language: string;
}

/** Fenced-code renderer for the markdown preview. Shares the app-wide cached
 * Shiki instance with the assistant chat. Falls back to a plain <pre> until
 * (or if) the highlighter is unavailable — the code is always visible. */
export const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
  code,
  language,
}: MarkdownCodeBlockProps) {
  const highlighter = useShikiHighlighter();
  if (!highlighter) {
    return (
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm">
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <ShikiHighlighter
      className="overflow-hidden rounded-md"
      highlighter={highlighter}
      language={normalizeShikiLanguage(language)}
      theme={{ dark: 'github-dark', light: 'github-light' }}
    >
      {code}
    </ShikiHighlighter>
  );
});
```

```tsx
// packages/ui/src/markdown-surface/markdown-image.tsx
import { useEffect, useState } from 'react';

export interface MarkdownImageProps {
  readonly alt: string;
  readonly resolveImageSrc: (src: string) => Promise<string>;
  readonly src: string;
}

type ImageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly url: string }
  | { readonly kind: 'error'; readonly message: string };

/** Async image: resolves the raw markdown src through the injected capability.
 * Failure renders an explicit placeholder naming the path — never a broken img. */
export function MarkdownImage({ alt, resolveImageSrc, src }: MarkdownImageProps) {
  const [state, setState] = useState<ImageState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setState({ kind: 'loading' });
    resolveImageSrc(src)
      .then((url) => {
        if (!active) {
          if (url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
          }
          return;
        }
        objectUrl = url.startsWith('blob:') ? url : null;
        setState({ kind: 'ready', url });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [resolveImageSrc, src]);

  if (state.kind === 'error') {
    return (
      <span
        className="inline-block rounded border border-dashed border-muted-foreground/40 px-2 py-1 text-muted-foreground text-xs"
        data-testid="markdown-image-error"
        role="img"
        aria-label={`Image unavailable: ${src}`}
      >
        Image unavailable: {src} ({state.message})
      </span>
    );
  }
  if (state.kind === 'loading') {
    return (
      <span className="inline-block rounded bg-muted px-2 py-1 text-muted-foreground text-xs">
        Loading image… {alt || src}
      </span>
    );
  }
  return <img alt={alt} className="max-w-full" src={state.url} />;
}
```

```tsx
// packages/ui/src/markdown-surface/frontmatter-block.tsx
import type { FrontmatterResult } from './frontmatter';

/** Muted key–value properties block for YAML frontmatter (GitHub/Obsidian style).
 * Invalid YAML renders the raw block with a visible note — never silently dropped. */
export function FrontmatterBlock({ result }: { readonly result: FrontmatterResult }) {
  if (result.raw === null) {
    return null;
  }
  if (result.error !== null || result.data === null) {
    return (
      <div
        className="mb-4 rounded-md border border-amber-500/40 bg-muted/50 p-3 text-xs"
        data-testid="markdown-frontmatter-error"
      >
        <p className="mb-1 font-medium text-amber-600 dark:text-amber-400">
          Invalid frontmatter{result.error ? `: ${result.error}` : ''}
        </p>
        <pre className="overflow-x-auto text-muted-foreground">{result.raw}</pre>
      </div>
    );
  }
  return (
    <dl
      className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-md border bg-muted/50 p-3 text-xs"
      data-testid="markdown-frontmatter"
    >
      {Object.entries(result.data).map(([key, value]) => (
        <div className="contents" key={key}>
          <dt className="font-medium text-muted-foreground">{key}</dt>
          <dd className="break-words">
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
```

- [ ] **Step 6: Implement `MarkdownSurface`**

```tsx
// packages/ui/src/markdown-surface/markdown-surface.tsx
import 'katex/dist/katex.min.css';
import { isValidElement, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { cn } from '../lib/utils';
import { extractFrontmatter } from './frontmatter';
import { FrontmatterBlock } from './frontmatter-block';
import { MarkdownCodeBlock } from './markdown-code-block';
import { MarkdownImage } from './markdown-image';
import { MermaidBlock } from './mermaid-block';

export interface MarkdownSurfaceProps {
  readonly ariaLabel?: string;
  readonly initialScrollTop?: number;
  readonly onOpenLink: (href: string) => void;
  readonly onScrollTopChange?: (scrollTop: number) => void;
  readonly resolveImageSrc: (src: string) => Promise<string>;
  readonly testId?: string;
  readonly truncated?: boolean;
  readonly value: string;
}

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeSlug, rehypeKatex];

interface FencedCode {
  readonly code: string;
  readonly language: string;
}

/** Read the single <code class="language-x"> child that react-markdown puts
 * inside <pre> for a fenced block. Returns null for anything unexpected so the
 * default <pre> rendering still applies. */
function extractFencedCode(children: ReactNode): FencedCode | null {
  if (!isValidElement(children)) {
    return null;
  }
  const props = children.props as { children?: ReactNode; className?: string };
  const match = /language-([\w-]+)/.exec(props.className ?? '');
  if (!match?.[1] || typeof props.children !== 'string') {
    return null;
  }
  return { code: props.children.replace(/\n$/, ''), language: match[1] };
}

export function MarkdownSurface({
  ariaLabel,
  initialScrollTop,
  onOpenLink,
  onScrollTopChange,
  resolveImageSrc,
  testId,
  truncated,
  value,
}: MarkdownSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frontmatter = useMemo(() => extractFrontmatter(value), [value]);

  useLayoutEffect(() => {
    if (containerRef.current && typeof initialScrollTop === 'number' && initialScrollTop > 0) {
      containerRef.current.scrollTop = initialScrollTop;
    }
    // Mount-only restore, mirroring CodeSurface's contract.
    // biome-ignore lint/correctness/useExhaustiveDependencies: restore once on mount
  }, []);

  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      onScrollTopChange?.(containerRef.current.scrollTop);
    }
  }, [onScrollTopChange]);

  const handleLinkClick = useCallback(
    (href: string) => {
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        containerRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
        return;
      }
      onOpenLink(href);
    },
    [onOpenLink]
  );

  const components = useMemo<Components>(
    () => ({
      a: ({ children, href }) => (
        <a
          href={href ?? '#'}
          onClick={(event) => {
            event.preventDefault();
            if (href) {
              handleLinkClick(href);
            }
          }}
        >
          {children}
        </a>
      ),
      img: ({ alt, src }) =>
        typeof src === 'string' ? (
          <MarkdownImage alt={alt ?? ''} resolveImageSrc={resolveImageSrc} src={src} />
        ) : null,
      pre: ({ children }) => {
        const fenced = extractFencedCode(children);
        if (!fenced) {
          return <pre>{children}</pre>;
        }
        if (fenced.language === 'mermaid') {
          return <MermaidBlock code={fenced.code} />;
        }
        return <MarkdownCodeBlock code={fenced.code} language={fenced.language} />;
      },
    }),
    [handleLinkClick, resolveImageSrc]
  );

  return (
    <div
      aria-label={ariaLabel}
      className="h-full overflow-auto"
      data-testid={testId}
      onScroll={handleScroll}
      ref={containerRef}
      role="region"
    >
      <div className={cn('prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-4')}>
        {truncated ? (
          <p className="rounded-md border border-amber-500/40 bg-muted/50 p-2 text-amber-600 text-xs dark:text-amber-400">
            Document truncated for display. Switch to Source to confirm the cutoff.
          </p>
        ) : null}
        <FrontmatterBlock result={frontmatter} />
        <ReactMarkdown
          components={components}
          rehypePlugins={REHYPE_PLUGINS}
          remarkPlugins={REMARK_PLUGINS}
        >
          {frontmatter.body}
        </ReactMarkdown>
      </div>
    </div>
  );
}
```

Notes for the implementer:
- The `import 'katex/dist/katex.min.css'` inside a component follows the existing precedent in `packages/ui/src/assistant-ui-panel/markdown-text.tsx` (which imports `dot.css` the same way). If `tsc -b` rejects the css import, add a `declare module '*.css';` shim next to the existing one (search `packages/ui/src` for `.css'` ambient declarations first — one likely exists).
- Verify `cn` import path by checking how `code-surface.tsx` imports it; match that.
- Create a temporary stub `packages/ui/src/markdown-surface/mermaid-block.tsx` in this task so the module graph compiles (Task 5 replaces its body):

```tsx
// packages/ui/src/markdown-surface/mermaid-block.tsx — Task 5 replaces this stub
export function MermaidBlock({ code }: { readonly code: string }) {
  return (
    <pre data-testid="mermaid-block">
      <code>{code}</code>
    </pre>
  );
}
```

```ts
// packages/ui/src/markdown-surface/index.ts
export { extractFrontmatter, type FrontmatterResult } from './frontmatter';
export { isMarkdownPath } from './is-markdown-path';
export { MarkdownSurface, type MarkdownSurfaceProps } from './markdown-surface';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/markdown-surface/__tests__/ && pnpm --filter @brainstrike/ui type-check`
Expected: PASS + clean type-check.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/markdown-surface packages/ui/package.json pnpm-lock.yaml
git commit -m "feat(ui): MarkdownSurface preview component with GFM, KaTeX, shiki fences"
```

---

### Task 5: `MermaidBlock` (lazy mermaid, visible errors)

**Files:**
- Modify: `packages/ui/src/markdown-surface/mermaid-block.tsx` (replace Task 4's stub)
- Modify: `packages/ui/package.json` (dep)
- Test: `packages/ui/src/markdown-surface/__tests__/mermaid-block.test.tsx`

**Interfaces:**
- Consumes: `mermaid` (dynamic import only — never static, it's ~1MB+).
- Produces: `MermaidBlock({ code }: { readonly code: string })` — used by Task 4's `pre` dispatch.

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @brainstrike/ui add mermaid`

- [ ] **Step 2: Write the failing tests**

```tsx
// packages/ui/src/markdown-surface/__tests__/mermaid-block.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderMock = vi.fn();
vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: renderMock },
}));

import { MermaidBlock } from '../mermaid-block';

describe('MermaidBlock', () => {
  beforeEach(() => {
    renderMock.mockReset();
  });

  it('renders the diagram svg on success', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-diagram="ok"></svg>' });
    render(<MermaidBlock code="graph TD; a-->b;" />);
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram').innerHTML).toContain('data-diagram="ok"');
    });
  });

  it('shows the error AND the fenced source on parse failure', async () => {
    renderMock.mockRejectedValue(new Error('Parse error on line 1'));
    render(<MermaidBlock code="graph TD; a-->" />);
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-error')).toHaveTextContent('Parse error on line 1');
    });
    expect(screen.getByText('graph TD; a-->')).toBeInTheDocument();
  });

  it('shows a loading state before render resolves', () => {
    renderMock.mockReturnValue(new Promise(() => undefined));
    render(<MermaidBlock code="graph TD; a-->b;" />);
    expect(screen.getByText(/rendering diagram/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/markdown-surface/__tests__/mermaid-block.test.tsx`
Expected: FAIL — the Task 4 stub renders `<pre>`, not a diagram/loading state.

- [ ] **Step 4: Implement**

```tsx
// packages/ui/src/markdown-surface/mermaid-block.tsx
import { useEffect, useRef, useState } from 'react';

let renderSequence = 0;

type MermaidState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly svg: string }
  | { readonly kind: 'error'; readonly message: string };

/** Lazy mermaid renderer for ```mermaid fences. The mermaid module (~1MB) loads
 * on first diagram only. A parse/render failure shows the error AND the source
 * (Obsidian-style) — a broken diagram must say why. */
export function MermaidBlock({ code }: { readonly code: string }) {
  const [state, setState] = useState<MermaidState>({ kind: 'loading' });
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    const id = `brainstrike-mermaid-${++renderSequence}`;
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        const dark = document.documentElement.classList.contains('dark');
        mermaid.initialize({
          securityLevel: 'strict',
          startOnLoad: false,
          theme: dark ? 'dark' : 'default',
        });
        const { svg } = await mermaid.render(id, code);
        if (active) {
          setState({ kind: 'ready', svg });
        }
      })
      .catch((error: unknown) => {
        // mermaid.render can leave a residual error element in <body> — remove it.
        document.getElementById(id)?.remove();
        if (active) {
          setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [code]);

  if (state.kind === 'error') {
    return (
      <div className="not-prose rounded-md border border-destructive/40 p-3 text-sm" data-testid="mermaid-error">
        <p className="mb-2 font-medium text-destructive">Mermaid diagram failed: {state.message}</p>
        <pre className="overflow-x-auto rounded bg-muted p-2 text-muted-foreground text-xs">{code}</pre>
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div className="not-prose rounded-md bg-muted/50 p-3 text-muted-foreground text-sm">
        Rendering diagram…
      </div>
    );
  }
  return (
    <div
      className="not-prose overflow-x-auto"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid output rendered under securityLevel 'strict' (sanitized by mermaid)
      dangerouslySetInnerHTML={{ __html: state.svg }}
      data-testid="mermaid-diagram"
      ref={hostRef}
    />
  );
}
```

- [ ] **Step 5: Run ALL markdown-surface tests (Task 4's suite must still pass with the real component mocked there)**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/markdown-surface/__tests__/ && pnpm --filter @brainstrike/ui type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/markdown-surface/mermaid-block.tsx packages/ui/src/markdown-surface/__tests__/mermaid-block.test.tsx packages/ui/package.json pnpm-lock.yaml
git commit -m "feat(ui): lazy mermaid diagram rendering with visible error states"
```

---

### Task 6: `editor-view-state-store` — persisted per-file view mode

**Files:**
- Modify: `packages/file-explorer-ui/src/stores/editor-view-state-store.ts`
- Test: `packages/file-explorer-ui/src/stores/__tests__/editor-view-state-store.test.ts` (create if absent; if an existing test file covers this store, extend it instead)

**Interfaces:**
- Produces (consumed by Tasks 7/9):
  - `export type FileViewMode = 'source' | 'preview';`
  - store gains `modes: Record<Key, FileViewMode>`, `getMode(key): FileViewMode | undefined`, `setMode(key, mode): void`
  - `clear(key)` also removes `modes[key]` and the preview scroll slot `preview:${key}`
  - persist `version: 2`; `partialize` includes `modes`; `migrate` returns pre-v2 state with `modes: {}`. STORE_NAME stays `'editor-view-state.v1'` (repo convention: name frozen, version tracked separately — see `context-explorer-layout-store.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/file-explorer-ui/src/stores/__tests__/editor-view-state-store.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorViewStateStore } from '../editor-view-state-store';

const KEY = 'folder:name:/root/readme.md';

describe('editor-view-state-store modes', () => {
  beforeEach(() => {
    useEditorViewStateStore.getState().clear();
  });

  it('returns undefined for a file with no explicit mode', () => {
    expect(useEditorViewStateStore.getState().getMode(KEY)).toBeUndefined();
  });

  it('persists an explicit mode per key', () => {
    useEditorViewStateStore.getState().setMode(KEY, 'source');
    expect(useEditorViewStateStore.getState().getMode(KEY)).toBe('source');
    expect(useEditorViewStateStore.getState().getMode('other')).toBeUndefined();
  });

  it('clear(key) removes the mode and the preview scroll slot', () => {
    const s = useEditorViewStateStore.getState();
    s.setMode(KEY, 'preview');
    s.setScrollTop(`preview:${KEY}`, 500);
    s.setScrollTop(KEY, 100);
    s.clear(KEY);
    const after = useEditorViewStateStore.getState();
    expect(after.getMode(KEY)).toBeUndefined();
    expect(after.getScrollTop(`preview:${KEY}`)).toBe(0);
    expect(after.getScrollTop(KEY)).toBe(0);
  });

  it('includes modes in the persisted partialization', () => {
    useEditorViewStateStore.getState().setMode(KEY, 'source');
    const persistOptions = useEditorViewStateStore.persist.getOptions();
    const partialized = persistOptions.partialize?.(useEditorViewStateStore.getState());
    expect(partialized).toMatchObject({ modes: { [KEY]: 'source' } });
  });

  it('migrates pre-v2 persisted state by adding an empty modes map', () => {
    const persistOptions = useEditorViewStateStore.persist.getOptions();
    const migrated = persistOptions.migrate?.(
      { scrollTops: { [KEY]: 42 }, selections: {} },
      1
    ) as { modes: Record<string, string>; scrollTops: Record<string, number> };
    expect(migrated.modes).toEqual({});
    expect(migrated.scrollTops[KEY]).toBe(42);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/stores/__tests__/editor-view-state-store.test.ts`
Expected: FAIL — `getMode is not a function`.

- [ ] **Step 3: Implement**

In `packages/file-explorer-ui/src/stores/editor-view-state-store.ts`:

1. Add the type + data/actions:

```ts
export type FileViewMode = 'source' | 'preview';
```

- `EditorViewStateData` gains `modes: Record<Key, FileViewMode>;`
- `EditorViewStateActions` gains `getMode: (key: Key) => FileViewMode | undefined;` and `setMode: (key: Key, mode: FileViewMode) => void;`

2. In the store creator, add initial `modes: {}` plus:

```ts
getMode: (key) => get().modes[key],
setMode: (key, mode) => set((s) => ({ modes: { ...s.modes, [key]: mode } })),
```

3. Extend `clear` — the per-key branch removes the mode AND the derived preview scroll slot:

```ts
clear: (key) => {
  if (!key) {
    set({ modes: {}, scrollTops: {}, selections: {}, targets: {} });
    return;
  }
  const { modes, scrollTops, selections, targets } = get();
  const previewKey = `preview:${key}`;
  const { [key]: _a, [previewKey]: _p, ...restScrolls } = scrollTops;
  const { [key]: _b, ...restSel } = selections;
  const { [key]: _c, ...restTargets } = targets;
  const { [key]: _d, ...restModes } = modes;
  set({ modes: restModes, scrollTops: restScrolls, selections: restSel, targets: restTargets });
},
```

4. Persist options:

```ts
{
  migrate: (persistedState, version) => {
    if (version < 2) {
      // v1 payloads predate modes; keep scroll/selection state and start modes fresh.
      return { ...(persistedState as Partial<EditorViewStateData>), modes: {} };
    }
    return persistedState as Partial<EditorViewStateData>;
  },
  name: STORE_NAME, // unchanged: 'editor-view-state.v1' — renaming would orphan users' data
  partialize: (s) => ({ modes: s.modes, scrollTops: s.scrollTops, selections: s.selections }),
  storage: createJSONStorage(() => storage),
  version: 2,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/stores/__tests__/editor-view-state-store.test.ts && pnpm --filter @brainstrike/file-explorer-ui type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/file-explorer-ui/src/stores
git commit -m "feat(file-explorer-ui): persist per-file source/preview mode in editor view state"
```

---

### Task 7: `FileTabHeader` component

**Files:**
- Create: `packages/file-explorer-ui/src/shell/file-tab-header.tsx`
- Test: `packages/file-explorer-ui/src/shell/__tests__/file-tab-header.test.tsx`

**Interfaces:**
- Consumes: `FileViewMode` from Task 6, `Button`/`cn` from `@brainstrike/ui`, `Code`/`Eye` icons from `lucide-react`.
- Produces (consumed by Task 9):

```ts
export interface FileTabHeaderProps {
  readonly directory: string;      // path minus filename ('' allowed)
  readonly fileName: string;
  readonly mode: FileViewMode;     // current effective mode (only meaningful when showModeToggle)
  readonly onModeChange: (mode: FileViewMode) => void;
  readonly showModeToggle: boolean; // true only for markdown tabs
}
export function FileTabHeader(props: FileTabHeaderProps): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

```tsx
// packages/file-explorer-ui/src/shell/__tests__/file-tab-header.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileTabHeader } from '../file-tab-header';

describe('FileTabHeader', () => {
  it('shows filename and directory', () => {
    render(
      <FileTabHeader
        directory="/root/docs"
        fileName="readme.md"
        mode="preview"
        onModeChange={vi.fn()}
        showModeToggle={false}
      />
    );
    expect(screen.getByText('readme.md')).toBeInTheDocument();
    expect(screen.getByText('/root/docs')).toBeInTheDocument();
    expect(screen.queryByTestId('file-tab-mode-toggle')).not.toBeInTheDocument();
  });

  it('renders the toggle only when showModeToggle, with the active mode pressed', () => {
    render(
      <FileTabHeader
        directory=""
        fileName="readme.md"
        mode="preview"
        onModeChange={vi.fn()}
        showModeToggle={true}
      />
    );
    expect(screen.getByTestId('file-tab-mode-toggle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /preview/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /source/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('fires onModeChange with the clicked mode', () => {
    const onModeChange = vi.fn();
    render(
      <FileTabHeader
        directory=""
        fileName="readme.md"
        mode="preview"
        onModeChange={onModeChange}
        showModeToggle={true}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /source/i }));
    expect(onModeChange).toHaveBeenCalledWith('source');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/shell/__tests__/file-tab-header.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// packages/file-explorer-ui/src/shell/file-tab-header.tsx
import { cn } from '@brainstrike/ui';
import { Code, Eye } from 'lucide-react';
import { memo } from 'react';
import type { FileViewMode } from '../stores/editor-view-state-store';

export interface FileTabHeaderProps {
  readonly directory: string;
  readonly fileName: string;
  readonly mode: FileViewMode;
  readonly onModeChange: (mode: FileViewMode) => void;
  readonly showModeToggle: boolean;
}

const MODE_OPTIONS: readonly { icon: typeof Eye; label: string; mode: FileViewMode }[] = [
  { icon: Eye, label: 'Preview', mode: 'preview' },
  { icon: Code, label: 'Source', mode: 'source' },
];

/** Slim per-tab header for every file tab: identity on the left, actions on the
 * right. Markdown tabs render the Source/Preview segmented toggle. */
export const FileTabHeader = memo(function FileTabHeader({
  directory,
  fileName,
  mode,
  onModeChange,
  showModeToggle,
}: FileTabHeaderProps) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b bg-background px-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-medium text-sm">{fileName}</span>
        {directory ? (
          <span className="truncate text-muted-foreground text-xs">{directory}</span>
        ) : null}
      </div>
      {showModeToggle ? (
        <div
          aria-label="View mode"
          className="flex shrink-0 items-center rounded-md border p-0.5"
          data-testid="file-tab-mode-toggle"
          role="group"
        >
          {MODE_OPTIONS.map(({ icon: Icon, label, mode: optionMode }) => (
            <button
              aria-pressed={mode === optionMode}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors',
                mode === optionMode
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              key={optionMode}
              onClick={() => onModeChange(optionMode)}
              type="button"
            >
              <Icon aria-hidden="true" className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/shell/__tests__/file-tab-header.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/file-explorer-ui/src/shell/file-tab-header.tsx packages/file-explorer-ui/src/shell/__tests__/file-tab-header.test.tsx
git commit -m "feat(file-explorer-ui): per-tab FileTabHeader with source/preview toggle"
```

---

### Task 8: Markdown preview capabilities context + app-shell composition

**Files:**
- Create: `packages/file-explorer-ui/src/contexts/markdown-preview-capabilities.tsx`
- Modify: `packages/file-explorer-ui/src/index.ts` (or the package's context export barrel — match how `FileEditorProvider` in `src/contexts/file-editor-context.tsx` is exported)
- Create: `packages/app-shell/src/use-markdown-preview-capabilities.ts`
- Modify: `packages/app-shell/src/root-layout-content.tsx` (mount provider alongside the existing ActionRegistryProvider)
- Test: `packages/app-shell/src/__tests__/use-markdown-preview-capabilities.test.ts` (match app-shell's existing test dir convention — check for `src/__tests__/` first)

**Interfaces:**
- Produces (consumed by Task 9):

```ts
export interface MarkdownPreviewCapabilities {
  /** Open http(s)/mailto externally. Resolves {ok:false,error} on failure — callers toast. */
  readonly openExternalLink: (url: string) => Promise<{ ok: boolean; error?: string }>;
  /** Resolve a workspace path (absolute on desktop, root-relative on web) to a displayable URL. Rejects with a reason. */
  readonly resolveImageSrc: (path: string) => Promise<string>;
}
// Context (nullable): provider + hook
export function MarkdownPreviewCapabilitiesProvider(props: { capabilities: MarkdownPreviewCapabilities; children: ReactNode }): JSX.Element;
export function useMarkdownPreviewCapabilities(): MarkdownPreviewCapabilities | null;
```

- Consumes: `AdaptersContext` from `@brainstrike/file-explorer-hooks` (web image bytes), the `window.platform` bridge (desktop, extended in Task 10 — until then desktop link-opening reports a visible failure, which is correct mid-stack).

- [ ] **Step 1: Implement the context (file-explorer-ui)**

```tsx
// packages/file-explorer-ui/src/contexts/markdown-preview-capabilities.tsx
import { createContext, type ReactNode, useContext } from 'react';

export interface MarkdownPreviewCapabilities {
  readonly openExternalLink: (url: string) => Promise<{ ok: boolean; error?: string }>;
  readonly resolveImageSrc: (path: string) => Promise<string>;
}

const MarkdownPreviewCapabilitiesContext = createContext<MarkdownPreviewCapabilities | null>(null);

export function MarkdownPreviewCapabilitiesProvider({
  capabilities,
  children,
}: {
  readonly capabilities: MarkdownPreviewCapabilities;
  readonly children: ReactNode;
}) {
  return (
    <MarkdownPreviewCapabilitiesContext.Provider value={capabilities}>
      {children}
    </MarkdownPreviewCapabilitiesContext.Provider>
  );
}

/** Nullable by design: an absent provider means the surface shows explicit
 * "unavailable" states (placeholder/toast), never a silent degradation. */
export function useMarkdownPreviewCapabilities(): MarkdownPreviewCapabilities | null {
  return useContext(MarkdownPreviewCapabilitiesContext);
}
```

Export the three names from the package barrel next to the existing context exports.

- [ ] **Step 2: Write the failing app-shell hook tests**

```ts
// packages/app-shell/src/__tests__/use-markdown-preview-capabilities.test.ts
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMarkdownPreviewCapabilitiesValue } from '../use-markdown-preview-capabilities';

type PlatformBridge = { openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }> };
const setPlatform = (bridge: PlatformBridge | undefined) => {
  (window as unknown as { platform?: PlatformBridge }).platform = bridge;
};

describe('useMarkdownPreviewCapabilitiesValue', () => {
  afterEach(() => {
    setPlatform(undefined);
    vi.restoreAllMocks();
  });

  it('routes external links through window.platform.openExternal when the bridge exists', async () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: true });
    setPlatform({ openExternal });
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    await expect(result.current.openExternalLink('https://example.com')).resolves.toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('rejects disallowed protocols before any bridge call', async () => {
    const openExternal = vi.fn();
    setPlatform({ openExternal });
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    const r = await result.current.openExternalLink('javascript:alert(1)');
    expect(r.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('falls back to window.open on web and reports popup blocking', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    const r = await result.current.openExternalLink('https://example.com');
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    expect(r.ok).toBe(false);
  });

  it('resolveImageSrc rejects with a clear reason when no image capability exists', async () => {
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    await expect(result.current.resolveImageSrc('/root/a.png')).rejects.toThrow(/unavailable/i);
  });

  it('builds a brainstrike-asset URL on desktop', async () => {
    setPlatform({ openExternal: vi.fn() });
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    await expect(result.current.resolveImageSrc('/root/img with space.png')).resolves.toBe(
      `brainstrike-asset://local/asset?path=${encodeURIComponent('/root/img with space.png')}`
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/use-markdown-preview-capabilities.test.ts`
Expected: FAIL — module not found. (If app-shell's vitest setup differs, match whatever `use-workspace-search-controller` tests do.)

- [ ] **Step 4: Implement the app-shell hook**

```ts
// packages/app-shell/src/use-markdown-preview-capabilities.ts
import type { MarkdownPreviewCapabilities } from '@brainstrike/file-explorer-ui';
import { AdaptersContext } from '@brainstrike/file-explorer-hooks';
import { createLogger } from '@brainstrike/utils/logger';
import { useContext, useMemo } from 'react';

const logger = createLogger('MarkdownPreviewCapabilities');
const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

interface PlatformOpenExternalBridge {
  readonly openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

function getPlatformBridge(): PlatformOpenExternalBridge | undefined {
  return (window as { platform?: PlatformOpenExternalBridge }).platform;
}

function validateLinkProtocol(url: string): string | null {
  try {
    const parsed = new URL(url);
    return ALLOWED_LINK_PROTOCOLS.has(parsed.protocol) ? null : `Blocked protocol: ${parsed.protocol}`;
  } catch {
    return 'Invalid URL';
  }
}

interface FileHandleResolvingAdapter {
  resolveFileHandleByPath: (path: string) => Promise<FileSystemFileHandle>;
}

function hasFileHandleResolution(adapter: unknown): adapter is FileHandleResolvingAdapter {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    typeof (adapter as FileHandleResolvingAdapter).resolveFileHandleByPath === 'function'
  );
}

/** Builds the platform-specific markdown preview capabilities. Desktop is
 * detected by the preload `window.platform` bridge (house pattern: capability
 * presence, never isElectron()). Missing pieces produce explicit failures. */
export function useMarkdownPreviewCapabilitiesValue(): MarkdownPreviewCapabilities {
  const adapters = useContext(AdaptersContext);
  const fileSystemAdapter = adapters?.fileSystemAdapter;

  return useMemo<MarkdownPreviewCapabilities>(() => {
    const bridge = getPlatformBridge();
    return {
      openExternalLink: async (url) => {
        const protocolError = validateLinkProtocol(url);
        if (protocolError) {
          logger.warn('Blocked external link', { protocolError, url });
          return { error: protocolError, ok: false };
        }
        if (bridge?.openExternal) {
          return bridge.openExternal(url);
        }
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        return opened ? { ok: true } : { error: 'Popup blocked by the browser', ok: false };
      },
      resolveImageSrc: async (path) => {
        if (bridge) {
          // Desktop: main-process asset protocol validates root containment.
          return `brainstrike-asset://local/asset?path=${encodeURIComponent(path)}`;
        }
        if (fileSystemAdapter && hasFileHandleResolution(fileSystemAdapter)) {
          const handle = await fileSystemAdapter.resolveFileHandleByPath(path);
          const file = await handle.getFile();
          return URL.createObjectURL(file);
        }
        throw new Error('Local image preview unavailable on this platform');
      },
    };
  }, [fileSystemAdapter]);
}
```

- [ ] **Step 5: Mount the provider in app-shell**

In `packages/app-shell/src/root-layout-content.tsx`, inside the component that already mounts `ActionRegistryProvider` (near line 279 where `IdeLayout` is composed), wrap the IdeLayout subtree:

```tsx
const markdownPreviewCapabilities = useMarkdownPreviewCapabilitiesValue();
// ...
<MarkdownPreviewCapabilitiesProvider capabilities={markdownPreviewCapabilities}>
  {/* existing IdeLayout subtree */}
</MarkdownPreviewCapabilitiesProvider>
```

Import both from their packages. Place the provider so `WorkspaceTabHost` (rendered via the context-explorer page content) is inside it.

- [ ] **Step 6: Run tests + type-checks**

Run: `pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/use-markdown-preview-capabilities.test.ts && pnpm --filter @brainstrike/app-shell type-check && pnpm --filter @brainstrike/file-explorer-ui type-check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/file-explorer-ui/src/contexts/markdown-preview-capabilities.tsx packages/file-explorer-ui/src/index.ts packages/app-shell/src
git commit -m "feat: platform-injected markdown preview capabilities (links, images)"
```

---

### Task 9: Wire `FileTabBody` — header, mode branch, lazy preview, error boundary, link routing

The integration task. `FileTabBody` in `packages/file-explorer-ui/src/shell/workspace-tab-host.tsx` (currently lines 783-901) gains the header and the preview branch.

**Files:**
- Create: `packages/file-explorer-ui/src/shell/markdown-preview-error-boundary.tsx`
- Modify: `packages/file-explorer-ui/src/shell/workspace-tab-host.tsx`
- Test: `packages/file-explorer-ui/src/shell/__tests__/file-tab-body-markdown.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 3 (`isMarkdownPath` from `@brainstrike/ui` root), 4 (`@brainstrike/ui/markdown-surface` lazy), 6 (`getMode`/`setMode`/`FileViewMode`), 7 (`FileTabHeader`), 8 (`useMarkdownPreviewCapabilities`), plus existing `useIdeFileEditor` (already imported in this file), `useToast` from `@brainstrike/ui`, `encodeFileSelection`/`decodeFileSelection` from `@brainstrike/utils/selection-utils`, `resolveRelativePath` from `@brainstrike/utils`.
- Produces: the user-facing feature. Behavior contract (each item is a test):
  1. Header renders for ALL file tabs; toggle only for markdown paths.
  2. `.md` with no stored mode → preview. Stored `source` → source. Non-markdown → always source, no toggle.
  3. A pending one-shot view target on a markdown tab forces source for that open; the store mode is NOT written.
  4. Toggling writes `setMode` and switches surfaces.
  5. Preview scroll persists under `preview:${compositeKey}`; source scroll under `compositeKey` (unchanged).
  6. Preview render crash → error boundary with "Open in source" that switches to source.
  7. Relative links resolve against the current file and call `openFileInTab`; escapes (`null` from `resolveRelativePath`) toast destructively; external links route through capabilities and toast on `{ok:false}`.

- [ ] **Step 1: Implement the error boundary**

```tsx
// packages/file-explorer-ui/src/shell/markdown-preview-error-boundary.tsx
import { Button } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { Component, type ReactNode } from 'react';

const logger = createLogger('MarkdownPreview');

interface Props {
  readonly children: ReactNode;
  readonly onOpenSource: () => void;
}
interface State {
  readonly error: string | null;
}

/** A pathological markdown document must never white-screen the tab. The
 * fallback names the failure and offers the always-working source view. */
export class MarkdownPreviewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown): void {
    logger.error('Markdown preview crashed', { error });
  }

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="font-semibold">Preview failed to render</p>
        <p className="max-w-md text-muted-foreground text-sm">{this.state.error}</p>
        <Button onClick={this.props.onOpenSource} size="sm" variant="outline">
          Open in source
        </Button>
      </div>
    );
  }
}
```

- [ ] **Step 2: Write the failing integration tests**

Test `FileTabBody` through its module. It is not exported — export it as `FileTabBodyInternal` for testing OR (preferred, matches repo patterns) test through `WorkspaceTabHost`… that drags the whole context web in. Pragmatic call: add a named export `export { FileTabBody as FileTabBodyForTesting }` at the bottom of `workspace-tab-host.tsx` — precedent for test-only exports exists in the repo; if a `*-internal.ts` convention is found nearby, use that instead.

```tsx
// packages/file-explorer-ui/src/shell/__tests__/file-tab-body-markdown.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openFileInTab = vi.fn();
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return { ...actual, useIdeFileEditor: () => ({ openFileInTab, registerOpenFileInTab: vi.fn() }) };
});
vi.mock('@brainstrike/ui/markdown-surface', () => ({
  MarkdownSurface: ({ value }: { value: string }) => (
    <div data-testid="markdown-surface">{value}</div>
  ),
}));

import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { MarkdownPreviewCapabilitiesProvider } from '../../contexts/markdown-preview-capabilities';
import { useEditorViewStateStore } from '../../stores/editor-view-state-store';
import { FileTabBodyForTesting as FileTabBody } from '../workspace-tab-host';

const MD_KEY = encodeFileSelection('folder-1', '/root/docs/readme.md');
const TS_KEY = encodeFileSelection('folder-1', '/root/src/main.ts');

const capabilities = {
  openExternalLink: vi.fn().mockResolvedValue({ ok: true }),
  resolveImageSrc: vi.fn().mockResolvedValue('blob:x'),
};

function renderBody(compositeKey: string, content = '# Hello') {
  const path = compositeKey.split(':').slice(2).join(':');
  return render(
    <MarkdownPreviewCapabilitiesProvider capabilities={capabilities}>
      <FileTabBody
        content={content}
        isLoading={false}
        isRestoring={false}
        status={undefined}
        tab={{ compositeKey, id: compositeKey, path }}
      />
    </MarkdownPreviewCapabilitiesProvider>
  );
}

describe('FileTabBody markdown integration', () => {
  beforeEach(() => {
    useEditorViewStateStore.getState().clear();
    vi.clearAllMocks();
  });

  it('renders the header for every file tab; toggle only on markdown', () => {
    const { unmount } = renderBody(TS_KEY, 'const x = 1;');
    expect(screen.getByText('main.ts')).toBeInTheDocument();
    expect(screen.queryByTestId('file-tab-mode-toggle')).not.toBeInTheDocument();
    unmount();
    renderBody(MD_KEY);
    expect(screen.getByTestId('file-tab-mode-toggle')).toBeInTheDocument();
  });

  it('defaults markdown tabs to preview', async () => {
    renderBody(MD_KEY);
    await waitFor(() => {
      expect(screen.getByTestId('markdown-surface')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('file-code-surface')).not.toBeInTheDocument();
  });

  it('honors a stored source mode', () => {
    useEditorViewStateStore.getState().setMode(MD_KEY, 'source');
    renderBody(MD_KEY);
    expect(screen.queryByTestId('markdown-surface')).not.toBeInTheDocument();
  });

  it('forces source transiently when a one-shot target exists, without writing the store', () => {
    useEditorViewStateStore.getState().setTarget(MD_KEY, { line: 12 });
    renderBody(MD_KEY);
    expect(screen.queryByTestId('markdown-surface')).not.toBeInTheDocument();
    expect(useEditorViewStateStore.getState().getMode(MD_KEY)).toBeUndefined();
  });

  it('toggle writes the store and switches surfaces', async () => {
    renderBody(MD_KEY);
    await waitFor(() => {
      expect(screen.getByTestId('markdown-surface')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /source/i }));
    expect(useEditorViewStateStore.getState().getMode(MD_KEY)).toBe('source');
    expect(screen.queryByTestId('markdown-surface')).not.toBeInTheDocument();
  });
});
```

(Note: the CodeSurface render path pulls CodeMirror into happy-dom; the existing test setup already handles this for other suites — if it needs a mock, mock `CodeSurface` inside the `@brainstrike/ui` partial mock the same way as `useIdeFileEditor`, keeping `data-testid="file-code-surface"` via a stub that renders `<div data-testid="file-code-surface" />`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/shell/__tests__/file-tab-body-markdown.test.tsx`
Expected: FAIL — no `FileTabBodyForTesting` export, no header.

- [ ] **Step 4: Implement the FileTabBody rewrite**

In `workspace-tab-host.tsx`:

1. **Key FileTabBody per tab** so its `useState` is per-file: in `WorkspaceBody`, change `<FileTabBody` to `<FileTabBody key={tab.compositeKey}`.

2. **New imports:** `lazy`, `Suspense`, `useState` from react; `FileTabHeader`; `MarkdownPreviewErrorBoundary`; `useMarkdownPreviewCapabilities`; `isMarkdownPath`, `useToast` from `@brainstrike/ui`; `encodeFileSelection` (add to the existing `selection-utils` import); `resolveRelativePath` from `@brainstrike/utils`; `type FileViewMode` from the store.

3. **Lazy surface** at module scope:

```tsx
const MarkdownSurfaceLazy = lazy(() =>
  import('@brainstrike/ui/markdown-surface').then((m) => ({ default: m.MarkdownSurface }))
);
```

4. **Inside `FileTabBody`** (after the existing `path` memo):

```tsx
const isMarkdown = isMarkdownPath(path);
const storedMode = useEditorViewStateStore((s) => s.modes[tab.compositeKey]);
const setMode = useEditorViewStateStore((s) => s.setMode);
// A line-targeted open (search match) forces source for THIS open only; the
// user's persisted preference is untouched. Captured once on mount (FileTabBody
// is keyed by compositeKey, so a fresh open re-evaluates).
const [forceSource, setForceSource] = useState<boolean>(
  () => isMarkdown && useEditorViewStateStore.getState().getTarget(tab.compositeKey) !== undefined
);
const effectiveMode: FileViewMode = !isMarkdown || forceSource ? 'source' : (storedMode ?? 'preview');

const handleModeChange = useCallback(
  (mode: FileViewMode) => {
    setForceSource(false);
    setMode(tab.compositeKey, mode);
  },
  [setMode, tab.compositeKey]
);
```

5. **Header + layout**: every return branch keeps its body, but the component's top-level return wraps in a column with the header. Restructure: compute the inner body into a variable (`body`) using the existing status/loading/inaccessible branches unchanged, then:

```tsx
const fileName = path.split('/').pop() ?? path;
const directory = path.slice(0, Math.max(0, path.length - fileName.length - 1));

return (
  <div className="flex h-full flex-col">
    <FileTabHeader
      directory={directory}
      fileName={fileName}
      mode={effectiveMode}
      onModeChange={handleModeChange}
      showModeToggle={isMarkdown}
    />
    <div className="min-h-0 flex-1">{body}</div>
  </div>
);
```

6. **The ready-content branch** becomes:

```tsx
const { text, truncated } = getDisplayContent(content);
const target = getTarget(tab.compositeKey);

const body =
  effectiveMode === 'preview' ? (
    <MarkdownPreviewErrorBoundary onOpenSource={() => handleModeChange('source')}>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            <span>Loading preview…</span>
          </div>
        }
      >
        <MarkdownSurfaceLazy
          ariaLabel={`Markdown preview for ${path}`}
          initialScrollTop={getScrollTop(`preview:${tab.compositeKey}`)}
          onOpenLink={handleOpenLink}
          onScrollTopChange={handlePreviewScrollTopChange}
          resolveImageSrc={resolveImage}
          testId="file-markdown-surface"
          truncated={truncated}
          value={text}
        />
      </Suspense>
    </MarkdownPreviewErrorBoundary>
  ) : (
    <CodeSurface /* existing props exactly as today */ />
  );
```

with the new callbacks:

```tsx
const capabilities = useMarkdownPreviewCapabilities();
const { toast } = useToast();
const ideEditor = useIdeFileEditor();

const handlePreviewScrollTopChange = useCallback(
  (scrollTop: number) => {
    setScrollTop(`preview:${tab.compositeKey}`, scrollTop);
  },
  [setScrollTop, tab.compositeKey]
);

const resolveImage = useCallback(
  async (src: string): Promise<string> => {
    if (/^(https?:|data:)/i.test(src)) {
      return src;
    }
    if (!capabilities) {
      throw new Error('Image preview unavailable');
    }
    const resolved = src.startsWith('/') ? src : resolveRelativePath(path, src);
    if (!resolved) {
      throw new Error('Path escapes the workspace');
    }
    return capabilities.resolveImageSrc(resolved);
  },
  [capabilities, path]
);

const handleOpenLink = useCallback(
  (href: string) => {
    if (/^(https?|mailto):/i.test(href)) {
      if (!capabilities) {
        toast({ description: href, title: 'External links unavailable', variant: 'destructive' });
        return;
      }
      void capabilities.openExternalLink(href).then((result) => {
        if (!result.ok) {
          toast({ description: result.error ?? href, title: 'Could not open link', variant: 'destructive' });
        }
      });
      return;
    }
    // Workspace-relative link → open in a tab.
    let folderId: string;
    try {
      folderId = decodeFileSelection(tab.compositeKey).folderId;
    } catch {
      toast({ description: href, title: 'Could not resolve link', variant: 'destructive' });
      return;
    }
    const resolved = resolveRelativePath(path, href.split('#')[0] ?? href);
    if (!resolved) {
      toast({ description: href, title: 'Link is outside the workspace', variant: 'destructive' });
      return;
    }
    const openFileInTab = ideEditor.openFileInTab;
    if (!openFileInTab) {
      toast({ description: href, title: 'File opening unavailable', variant: 'destructive' });
      return;
    }
    openFileInTab(encodeFileSelection(folderId, resolved));
  },
  [capabilities, ideEditor.openFileInTab, path, tab.compositeKey, toast]
);
```

(Verify `decodeFileSelection`'s return field name for the folder id — read `packages/utils/src/selection-utils.ts` and use the actual property. If `useToast`'s API differs from `toast({title, description, variant})`, match the real signature — see `packages/file-explorer-hooks/src/use-toast-manager.ts` usage.)

7. **Test-only export** at the bottom:

```tsx
export { FileTabBody as FileTabBodyForTesting };
```

- [ ] **Step 5: Run the new tests + the package suite**

Run: `pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/shell/__tests__/file-tab-body-markdown.test.tsx && pnpm --filter @brainstrike/file-explorer-ui test && pnpm --filter @brainstrike/file-explorer-ui type-check`
Expected: new tests PASS; full package suite stays green (existing workspace-tab-host tests must not regress — if any assert on FileTabBody's old flat DOM, update them for the header wrapper).

- [ ] **Step 6: Commit**

```bash
git add packages/file-explorer-ui/src/shell
git commit -m "feat(file-explorer-ui): markdown preview mode in file tabs with header toggle"
```

---

### Task 10: Desktop `openExternal` IPC (allowlisted)

**Files:**
- Modify: the `DESKTOP_IPC_CHANNELS` constants module — locate with `grep -rn "shell:show-item-in-folder" apps/desktop/src packages --include="*.ts" -l` and add `openExternal: 'shell:open-external'` to the `shell` domain object.
- Modify: `apps/desktop/src/ipc-shell-handlers.ts` (validation + handler)
- Modify: `apps/desktop/src/ipc-shell.ts` (register the channel)
- Modify: `apps/desktop/src/preload.ts` (~line 1045, the `platform` bridge)
- Modify: `apps/desktop/src/types/electron.d.ts` (~line 300, the `platform` type)
- Test: extend the existing shell-handler test file (locate with `grep -rn "validateShellTarget\|showItemInFolder" apps/desktop/src/__tests__ -l`); create `apps/desktop/src/__tests__/ipc-shell-open-external.test.ts` if none fits.

**Interfaces:**
- Produces: `window.platform.openExternal(url: string): Promise<{ ok: boolean; error?: string }>` — consumed by Task 8's hook (which already duck-types it; this task makes desktop real).
- Exports for tests: `validateExternalUrl(value: unknown): { ok: true; url: string } | { ok: false; error: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/__tests__/ipc-shell-open-external.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createShellIpcHandlers, validateExternalUrl } from '../ipc-shell-handlers';

describe('validateExternalUrl', () => {
  it.each(['https://example.com/a?b=1', 'http://localhost:8080', 'mailto:a@b.com'])(
    'allows %s',
    (url) => {
      expect(validateExternalUrl(url)).toEqual({ ok: true, url: expect.any(String) });
    }
  );
  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'brainstrike-asset://local/asset?path=/x',
    'ftp://x',
    '',
    'not a url',
  ])('rejects %s', (url) => {
    const r = validateExternalUrl(url);
    expect(r.ok).toBe(false);
  });
  it('rejects non-strings', () => {
    expect(validateExternalUrl(42).ok).toBe(false);
    expect(validateExternalUrl(undefined).ok).toBe(false);
  });
});

describe('openExternal handler', () => {
  it('calls shell.openExternal only for allowed URLs', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const handlers = createShellIpcHandlers({
      shell: { openExternal, openPath: vi.fn(), showItemInFolder: vi.fn() },
    });
    await expect(handlers.openExternal('https://example.com/')).resolves.toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/');
    const blocked = await handlers.openExternal('file:///etc/passwd');
    expect(blocked.ok).toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('surfaces shell throw as {ok:false}', async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error('boom'));
    const handlers = createShellIpcHandlers({
      shell: { openExternal, openPath: vi.fn(), showItemInFolder: vi.fn() },
    });
    await expect(handlers.openExternal('https://example.com/')).resolves.toEqual({
      error: 'boom',
      ok: false,
    });
  });
});
```

(Adapt the `createShellIpcHandlers` constructor arg shape to the real one in `ipc-shell-handlers.ts` — it already takes `{ shell }`; extend the accepted shell interface with `openExternal`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/ipc-shell-open-external.test.ts`
(Confirm the desktop package name with `grep '"name"' apps/desktop/package.json` — adjust the filter if it differs.)
Expected: FAIL — `validateExternalUrl` not exported.

- [ ] **Step 3: Implement**

In `apps/desktop/src/ipc-shell-handlers.ts`:

```ts
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function validateExternalUrl(
  value: unknown
): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { error: 'URL must be a non-empty string', ok: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: 'Invalid URL', ok: false };
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return { error: `Blocked protocol: ${parsed.protocol}`, ok: false };
  }
  return { ok: true, url: parsed.toString() };
}
```

Extend the handlers factory's shell dependency type with `openExternal: (url: string) => Promise<void>` and add:

```ts
openExternal: async (url: unknown): Promise<ShellIpcResult> => {
  const validated = validateExternalUrl(url);
  if (!validated.ok) {
    return { error: validated.error, ok: false };
  }
  try {
    await shell.openExternal(validated.url);
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  }
},
```

Register in `ipc-shell.ts` following the two existing registrations exactly; add the channel constant; add to `preload.ts`:

```ts
openExternal: (url: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.shell.openExternal, url),
```

and to `apps/desktop/src/types/electron.d.ts`:

```ts
openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
```

- [ ] **Step 4: Run tests + desktop type-check**

Run: `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/ipc-shell-open-external.test.ts && pnpm --filter @brainstrike/desktop type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): allowlisted shell.openExternal IPC for markdown links"
```

---

### Task 11: Desktop `brainstrike-asset://` protocol + CSP

**Files:**
- Create: `apps/desktop/src/asset-protocol.ts`
- Modify: `apps/desktop/src/main.ts` (privilege registration before `app.whenReady`; `protocol.handle` after DB init, wired like `ipc-git.ts`'s `createDatabaseRootResolver(getDatabase)`)
- Modify: the CSP source — `apps/desktop/src/csp-utils.ts` (`img-src` gains `brainstrike-asset:`)
- Test: `apps/desktop/src/__tests__/asset-protocol.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRootResolver` from `apps/desktop/src/workspace-root-cwd.ts` (`{ listRoots: () => Promise<readonly {displayName; path; rootId}[]> }`), `createDatabaseRootResolver` from `apps/desktop/src/git-ipc-handlers.ts`.
- Produces:
  - `ASSET_PROTOCOL_SCHEME = 'brainstrike-asset'`
  - `registerAssetProtocolPrivileges(): void` (must run before app ready)
  - `createAssetProtocolHandler(resolver: WorkspaceRootResolver): (request: Request) => Promise<Response>` — exported separately so tests exercise it without Electron's `protocol` module.
  - URL contract (matches Task 8's builder): `brainstrike-asset://local/asset?path=<encodeURIComponent(absolutePath)>`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/__tests__/asset-protocol.test.ts
import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  net: {
    fetch: vi.fn(async (url: string) => new Response(`fetched:${url}`, { status: 200 })),
  },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

import { createAssetProtocolHandler } from '../asset-protocol';

let root: string;
let outside: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-asset-root-')));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-asset-outside-')));
  await writeFile(path.join(root, 'img.png'), 'png-bytes');
  await writeFile(path.join(outside, 'secret.png'), 'secret');
  await symlink(path.join(outside, 'secret.png'), path.join(root, 'sneaky.png'));
});

function makeHandler() {
  return createAssetProtocolHandler({
    listRoots: async () => [{ displayName: 'root', path: root, rootId: 'r1' }],
  });
}

const assetUrl = (p: string) => `brainstrike-asset://local/asset?path=${encodeURIComponent(p)}`;

describe('asset protocol handler', () => {
  it('serves files inside a mounted root', async () => {
    const res = await makeHandler()(new Request(assetUrl(path.join(root, 'img.png'))));
    expect(res.status).toBe(200);
  });
  it('rejects files outside every root with 403', async () => {
    const res = await makeHandler()(new Request(assetUrl(path.join(outside, 'secret.png'))));
    expect(res.status).toBe(403);
  });
  it('rejects symlink escapes (realpath containment)', async () => {
    const res = await makeHandler()(new Request(assetUrl(path.join(root, 'sneaky.png'))));
    expect(res.status).toBe(403);
  });
  it('rejects traversal in the requested path', async () => {
    const res = await makeHandler()(new Request(assetUrl(path.join(root, '..', 'x.png'))));
    expect(res.status).toBe(403);
  });
  it('404s a missing path parameter', async () => {
    const res = await makeHandler()(new Request('brainstrike-asset://local/asset'));
    expect(res.status).toBe(400);
  });
  it('404s a nonexistent file inside the root', async () => {
    const res = await makeHandler()(new Request(assetUrl(path.join(root, 'nope.png'))));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/asset-protocol.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/asset-protocol.ts
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { createLogger } from '@brainstrike/utils/logger';
import type { WorkspaceRootResolver } from './workspace-root-cwd';

const logger = createLogger('AssetProtocol');

export const ASSET_PROTOCOL_SCHEME = 'brainstrike-asset';

/** MUST run before app.whenReady(). stream+supportFetchAPI let <img> and
 * fetch consume responses; bypassCSP stays false — CSP still governs usage. */
export function registerAssetProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      privileges: { bypassCSP: false, corsEnabled: false, secure: true, standard: false, stream: true, supportFetchAPI: true },
      scheme: ASSET_PROTOCOL_SCHEME,
    },
  ]);
}

/** Root containment is the ONLY trust boundary: renderer-supplied paths are
 * hostile input. realpath() both sides so symlinks cannot escape a root. */
export function createAssetProtocolHandler(
  resolver: WorkspaceRootResolver
): (request: Request) => Promise<Response> {
  return async (request) => {
    let requested: string | null;
    try {
      requested = new URL(request.url).searchParams.get('path');
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (!requested || !path.isAbsolute(requested)) {
      return new Response('Bad request: absolute path parameter required', { status: 400 });
    }
    let real: string;
    try {
      real = await realpath(requested);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const roots = await resolver.listRoots();
    let contained = false;
    for (const root of roots) {
      if (!root.path) {
        continue;
      }
      try {
        const rootReal = await realpath(root.path);
        if (real === rootReal || real.startsWith(rootReal + path.sep)) {
          contained = true;
          break;
        }
      } catch {
        // Unresolvable root (unmounted volume): skip — never widens access.
      }
    }
    if (!contained) {
      logger.warn('Blocked asset request outside mounted roots', { requested });
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(real).toString());
  };
}

export function registerAssetProtocol(resolver: WorkspaceRootResolver): void {
  protocol.handle(ASSET_PROTOCOL_SCHEME, createAssetProtocolHandler(resolver));
  logger.info('brainstrike-asset protocol registered');
}
```

Wire into `main.ts`:
- `registerAssetProtocolPrivileges()` at module scope next to other pre-ready setup (before `app.whenReady()` — grep main.ts for `whenReady` and place above the earliest call, alongside imports).
- After the DB is initialized (find where `ipc-git.ts`'s registration receives `getDatabase` and mirror it): `registerAssetProtocol(createDatabaseRootResolver(getDatabase))`.

CSP: in `apps/desktop/src/csp-utils.ts`, find the `img-src` directive and append `brainstrike-asset:`. If a CSP test exists (grep `csp-utils` in `__tests__`), extend its expectation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/asset-protocol.test.ts && pnpm --filter @brainstrike/desktop type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): root-validated brainstrike-asset protocol for markdown images"
```

---

### Task 12: Tailwind typography plugin

**Files:**
- Modify: `apps/web/package.json`, `apps/desktop/package.json` (add `@tailwindcss/typography` next to wherever `tailwindcss` sits in each)
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/desktop/src/renderer/styles.css`

- [ ] **Step 1: Install**

Run: `pnpm --filter web add -D @tailwindcss/typography && pnpm --filter @brainstrike/desktop add -D @tailwindcss/typography`
(Confirm each app's actual package name first: `grep '"name"' apps/web/package.json apps/desktop/package.json`. Match the dep section where `tailwindcss` already lives in each file.)

- [ ] **Step 2: Register the plugin (Tailwind v4 CSS-first)**

In `apps/web/src/app/globals.css`, directly after the `@import "tailwindcss";` line, add:

```css
@plugin "@tailwindcss/typography";
```

Same addition in `apps/desktop/src/renderer/styles.css` after its tailwind import.

- [ ] **Step 3: Verify class generation**

The `prose` classes are used by `MarkdownSurface`, which lives in `packages/ui`. Confirm each app's CSS scans package sources: check the `@source` directives in both css files. If they only cover the app's own `src/**`, add (path-adjusted per app):

```css
@source "../../../packages/ui/src/**/*.{ts,tsx}";
```

— but FIRST check whether existing `@brainstrike/ui` Tailwind classes are picked up by an existing broader mechanism (if other ui-package-only classes like `aui-md` styling work today without an explicit `@source`, mirror however that is achieved; do not add redundant directives). Sanity check without a dev server: `cd apps/web && pnpm exec tailwindcss --help` is NOT available in v4 CLI-less setups — instead rely on the desktop/web E2E smoke in CI plus the manual CDT check in Task 13.

- [ ] **Step 4: Commit**

```bash
git add apps/web apps/desktop pnpm-lock.yaml
git commit -m "feat: add @tailwindcss/typography for markdown prose styling"
```

---

### Task 13: Docs, full gate run, manual verification

**Files:**
- Modify: `AGENTS.md` (living-document rule: new "MARKDOWN VIEWER" section)
- No other code changes — this task proves the branch is green as a whole.

- [ ] **Step 1: Add the AGENTS.md section**

Insert after the WORKSPACE SEARCH section (keep the doc's style):

```markdown
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
  object URL (revoked on unmount). Every failure is visible (placeholder,
  toast, or error block) — no silent fallbacks.
- **Crash safety:** MarkdownPreviewErrorBoundary offers "Open in source".

When changing this flow, update this section and the paired tests.
```

- [ ] **Step 2: Full gate run (everything green in one run — team bar)**

Run from repo root:

```bash
pnpm turbo run build type-check lint test --filter=@brainstrike/utils --filter=@brainstrike/ui --filter=@brainstrike/file-explorer-ui --filter=@brainstrike/app-shell --filter=@brainstrike/desktop --filter=web
```

(Adjust filter names to actual package names. If turbo task names differ — check `turbo.json` — run the equivalent set.)
Expected: ALL green. Iterate until they are.

- [ ] **Step 3: Manual verification checklist (CDT, dev server assumed running)**

Verify in the running app (per user preference, manual CDT over curl; desktop via `pnpm --filter @brainstrike/desktop dev:agent-debug` if agent-driven):
1. Open a `.md` file → renders as preview with header + toggle; heading/table/code-fence styling present (typography plugin live).
2. Toggle Source ↔ Preview; reload; per-file mode remembered.
3. Search for text inside a `.md`, click the match → opens in SOURCE at the line; toggle back to preview afterwards works; reopening plainly still previews.
4. `.md` with frontmatter → properties block; broken frontmatter → visible error block.
5. Mermaid fence renders; a broken mermaid fence shows error + source.
6. Relative image renders (desktop); outside-root image shows the explicit placeholder.
7. External link opens the system browser; `javascript:` link does nothing but toast/log.
8. Relative `.md` link opens a new tab.
9. Non-markdown tabs show the header without a toggle; code view unchanged.

- [ ] **Step 4: Commit + report**

```bash
git add AGENTS.md
git commit -m "docs: markdown viewer architecture section in AGENTS.md"
```

Then produce the post-task summary (Files Changed / What Was Modified / Files Intentionally Not Touched / Follow-Up Needed) per AGENTS.md.

---

## Task Dependency Order

1 (utils) → 2 (shiki core) → 3 (detection/frontmatter) → 4 (MarkdownSurface) → 5 (mermaid) → 6 (store) → 7 (header) → 8 (capabilities) → 9 (FileTabBody wiring) → 10 (openExternal) → 11 (asset protocol) → 12 (typography) → 13 (docs + gates).

Tasks 10, 11, 12 are independent of each other (all depend only on 8/9 conceptually; 10/11 are desktop-only, 12 is CSS-only) and may run in parallel after 9.

## Out of Scope (v1, from the spec)

- `.mdx` rendering; best-effort preview scroll-to-line for search targets; editing in preview; preview-side size cap beyond the existing `getDisplayContent` truncation (the preview reuses it and shows a visible truncation notice).
