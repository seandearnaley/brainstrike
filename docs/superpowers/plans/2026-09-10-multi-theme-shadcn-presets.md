# Multi-theme support from shadcn presets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four selectable colour palettes (`brainstrike`, `ember`, `tide`, `orchid`), each with light and dark modes, generated from shadcn preset codes, on top of a token layer aligned with the current shadcn idiom.

**Architecture:** Palette is a `data-theme` attribute on `<html>`, orthogonal to the existing `light`/`dark` class. `--bs-*` stays the single source of truth but holds full colour values; one shared `@theme inline` mapping in `packages/ui` replaces the duplicated blocks in both apps. A generator turns a preset code into a theme CSS file via `shadcn apply --only theme` on a committed fixture.

**Tech Stack:** Tailwind CSS v4 (`@tailwindcss/vite`), React 19, Vitest, Playwright 1.63, Node `node:test` for `scripts/__tests__`, shadcn CLI 4.21 (via `npx`, dev-time only, never a dependency).

Spec: `docs/superpowers/specs/2026-09-10-multi-theme-shadcn-presets-design.md`.
Research: `docs/superpowers/research/2026-09-09-shadcn-preset-multi-theme-research.md`.

## Global Constraints

- Two stacked PRs. PR 1 (`theming/token-format-refactor`, base `main`) is a zero-visual-change refactor. PR 2 (`theming/multi-theme`, base = PR 1 branch) adds palettes. Land bottom-up.
- Never work on `main`. Never use bare `git stash` (shared stash stack across worktrees).
- No `components.json` in the repo. No `shadcn` dependency. No Base UI. Geist and lucide stay.
- The existing palette must be numerically unchanged: HSL triplets are wrapped in `hsl()`, never re-derived.
- Theme values in generated files are never hand-edited; regenerate with the script.
- Everything stays unlayered (Tailwind cascade layers: unlayered beats layered).
- `@theme inline` for colour, radius, and font mappings. Plain `@theme` for the typography scale (unchanged behaviour).
- Storage keys: `app-theme` (mode, unchanged) and `app-theme-palette` (theme id).
- TypeScript strict, no `any`, discriminated unions, kebab-case files. Run `pnpm dlx ultracite fix` before every commit.
- Local timeouts are half of CI's; a slow suite is not a failure signal by itself.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File map

PR 1:
- Create `packages/ui/src/themes/brainstrike.css` — baseline `--bs-*` tokens, `:root` and `.dark`, full colour values, font hooks.
- Create `packages/ui/src/themes/index.css` — one `@import` per theme file.
- Create `packages/ui/src/theme.css` — shared Tailwind mapping (`@custom-variant dark`, typography `@theme`, colour/radius/font `@theme inline`).
- Modify `packages/ui/src/globals.css` — import themes first, single bridge block, high-contrast block wrapped in `hsl()`, `var(--x)` idiom.
- Modify `packages/ui/package.json` — export `./theme.css`, copy new files in `build`.
- Modify `apps/web/src/app/globals.css`, `apps/desktop/src/renderer/styles.css` — import `@brainstrike/ui/theme.css`, delete duplicated blocks, font vars.
- Modify 11 source files with `hsl(var(` sites (list in Task 5).
- Create `scripts/__tests__/theme-css-contract.test.mjs` — idiom guard + single-owner guard.
- Modify `packages/ui/src/__tests__/focus-ring-theme.test.ts`; create `packages/ui/src/__tests__/theme-token-format.test.ts`, `packages/ui/src/__tests__/theme-css-mapping.test.ts`.
- Modify `apps/web/e2e/theme-css-consistency.test.ts`.

PR 2:
- Create `scripts/import-shadcn-theme.mjs`, `scripts/shadcn-theme-fixture/**`, `scripts/__tests__/import-shadcn-theme.test.mjs`, `scripts/__tests__/fixtures/shadcn-apply-buKEvLs.css`.
- Create `packages/ui/src/themes/{ember,tide,orchid}.css` (generated), `packages/ui/src/themes/index.ts`, `packages/ui/src/__tests__/theme-registry.test.ts`.
- Modify `packages/ui/src/theme-provider.tsx`, `theme-settings.tsx`, `theme-toggle.tsx`, `hooks/use-resolved-theme.ts`, `index.ts`, and their tests.
- Modify `packages/app-shell/src/{types.ts,app-config.tsx,app-layout.tsx,use-global-command-handlers.ts}`.
- Modify `packages/ui/src/globals.css` (high-contrast selectors), `scripts/__tests__/theme-css-contract.test.mjs` (cascade order).
- Create `packages/app-state/src/__tests__/factory-reset-theme-keys.test.ts`.
- Modify `apps/web/e2e/utils/app-state.ts`, `apps/web/e2e/utils/layout-helpers.ts`, `apps/web/e2e/theme-switching.test.ts`, `apps/web/e2e/theme-css-consistency.test.ts`.
- Modify `docs/agents/ui-conventions.md`, `AGENTS.md`, the spec (one derivation note).

---

# PR 1 — token format refactor (zero visual change)

### Task 1: Branch and carry the design docs

**Files:** none changed.

- [ ] **Step 1: Create the PR 1 branch from the latest upstream default branch**

```bash
git fetch origin main
git checkout -b theming/token-format-refactor origin/main
git cherry-pick 315ba9a4c
git log --oneline -2
```

Expected: top commit is `docs(theming): research and design spec for multi-theme support from shadcn presets` on top of `origin/main`.

- [ ] **Step 2: Install and confirm the tree is clean**

```bash
pnpm install --frozen-lockfile
git status --short
```

Expected: no output from `git status --short`.

### Task 2: Baseline screenshots (before any change)

**Files:** `.claude/launch.json` (gitignored; create if absent).

- [ ] **Step 1: Add a web dev configuration to the gitignored launch file**

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "web-dev", "runtimeExecutable": "pnpm", "runtimeArgs": ["--filter", "@brainstrike/web", "dev"], "port": 8080 }
  ]
}
```

Confirm it is ignored: `git check-ignore -q .claude/launch.json && echo ignored`. Expected: `ignored`.

- [ ] **Step 2: Capture web baselines**

Start `web-dev` with the browser pane's `preview_start`. Open Settings > Appearance. For each of Light and Dark: click the mode button, then take a full screenshot and save it to the scratchpad as `baseline-web-light.png` / `baseline-web-dark.png`. Also record computed values to a text file for later comparison:

```js
// run in the page
const s = getComputedStyle(document.documentElement);
JSON.stringify({ bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color,
  ring: s.getPropertyValue('--bs-ring').trim(), primary: s.getPropertyValue('--bs-primary').trim() })
```

Save the JSON per mode as `baseline-web-<mode>.json`.

- [ ] **Step 3: Capture desktop baselines**

```bash
BRAINSTRIKE_AGENT_DEVTOOLS=1 pnpm --filter @brainstrike/desktop dev:agent-debug
```

Attach the chrome-devtools tools to `http://localhost:9222`, repeat Step 2 for the desktop renderer, saving `baseline-desktop-<mode>.png` and `.json`. Stop the desktop process afterwards. The memory note "Desktop live-debug attach" documents this recipe.

### Task 3: Carve the baseline palette into `themes/brainstrike.css` with full colour values

**Files:**
- Create: `packages/ui/src/themes/brainstrike.css`, `packages/ui/src/themes/index.css`
- Modify: `packages/ui/src/globals.css`, `packages/ui/package.json`
- Test: `packages/ui/src/__tests__/focus-ring-theme.test.ts`, `packages/ui/src/__tests__/theme-token-format.test.ts`

**Interfaces:**
- Produces: `--bs-*` tokens whose values are complete colours (`hsl(30 25% 99%)`), `--bs-font-sans`, `--bs-font-heading`, `--bs-font-mono`; `packages/ui/src/themes/index.css` as the only place theme files are imported; `@brainstrike/ui/globals.css` still the app entry.

- [ ] **Step 1: Write the failing format test**

Create `packages/ui/src/__tests__/theme-token-format.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const THEMES_DIR = join(process.cwd(), 'src', 'themes');
const GLOBALS = join(process.cwd(), 'src', 'globals.css');

const COLOUR_VALUE = /^(?:hsl|oklch|color-mix|linear-gradient)\(/u;
const NON_COLOUR_TOKENS = new Set(['radius', 'font-sans', 'font-heading', 'font-mono']);

function collectBsDeclarations(source: string): Array<{ name: string; value: string }> {
  return [...source.matchAll(/--bs-([a-z0-9-]+):\s*([^;]+);/gu)].map((match) => ({
    name: match[1] ?? '',
    value: (match[2] ?? '').trim(),
  }));
}

describe('theme token format', () => {
  it('brainstrike.css declares every --bs-* colour as a complete colour value', () => {
    const source = readFileSync(join(THEMES_DIR, 'brainstrike.css'), 'utf8');
    const declarations = collectBsDeclarations(source);
    expect(declarations.length).toBeGreaterThan(80);
    for (const { name, value } of declarations) {
      if (NON_COLOUR_TOKENS.has(name)) {
        continue;
      }
      expect(value, `--bs-${name}: ${value}`).toMatch(COLOUR_VALUE);
    }
  });

  it('brainstrike.css declares the font hooks on :root', () => {
    const source = readFileSync(join(THEMES_DIR, 'brainstrike.css'), 'utf8');
    expect(source).toMatch(/--bs-font-sans:\s*"Geist Variable"/u);
    expect(source).toMatch(/--bs-font-heading:\s*var\(--bs-font-sans\)/u);
    expect(source).toMatch(/--bs-font-mono:\s*"Geist Mono Variable"/u);
  });

  it('globals.css no longer owns palette values', () => {
    const source = readFileSync(GLOBALS, 'utf8');
    const outsideHighContrast = source.split('@media (prefers-contrast: more)')[0] ?? '';
    expect(collectBsDeclarations(outsideHighContrast)).toHaveLength(0);
    expect(source).toMatch(/^@import "\.\/themes\/index\.css";/mu);
  });

  it('the high-contrast override also uses complete colour values', () => {
    const source = readFileSync(GLOBALS, 'utf8');
    const highContrast = source.split('@media (prefers-contrast: more)')[1] ?? '';
    for (const { name, value } of collectBsDeclarations(highContrast)) {
      expect(value, `--bs-${name}: ${value}`).toMatch(COLOUR_VALUE);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/ui && pnpm vitest run --project unit src/__tests__/theme-token-format.test.ts
```

Expected: FAIL (`ENOENT` on `themes/brainstrike.css`).

- [ ] **Step 3: Run the one-off carve-out script**

Save to the scratchpad as `carve-brainstrike.mjs` and run it from the repo root with `node <path>/carve-brainstrike.mjs`:

```js
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const GLOBALS = 'packages/ui/src/globals.css';
const source = readFileSync(GLOBALS, 'utf8');

// Block boundaries: `:root {` at column 0 through its closing `}` at column 0, same for `.dark {`.
function takeBlock(text, opener) {
  const start = text.indexOf(`\n${opener} {\n`);
  if (start < 0) throw new Error(`missing ${opener}`);
  const end = text.indexOf('\n}\n', start);
  return { start: start + 1, end: end + 3, body: text.slice(start + opener.length + 4, end + 1) };
}

const TRIPLET = /(--bs-[a-z0-9-]+):\s*(\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%);/gu;
const wrap = (text) => text.replace(TRIPLET, '$1: hsl($2);');

const root = takeBlock(source, ':root');
const dark = takeBlock(source.slice(root.end), '.dark');
dark.start += root.end;
dark.end += root.end;

const isBs = (line) => /^\s*--bs-/u.test(line) || /^\s*\/\*/u.test(line) || line.trim() === '';
const split = (body) => {
  const lines = body.split('\n');
  return {
    bridge: lines.filter((line) => /^\s*--[a-z]/u.test(line) && !/^\s*--bs-/u.test(line)),
    tokens: lines.filter(isBs),
  };
};
const rootParts = split(root.body);
const darkParts = split(dark.body);

const FONT_HOOKS = `
  /* Font hooks: every theme inherits these unless it overrides them (future font axis). */
  --bs-font-sans: "Geist Variable", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --bs-font-heading: var(--bs-font-sans);
  --bs-font-mono: "Geist Mono Variable", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
`;

const themeCss = `/*
 * Brainstrike baseline palette (theme id: brainstrike). Hand-maintained.
 * Every --bs-* value is a complete colour. Other themes live beside this
 * file and override these tokens under :root[data-theme="<id>"].
 */
:root {
${wrap(rootParts.tokens.join('\n')).replace(/\n+$/u, '')}
${FONT_HOOKS}}

.dark {
${wrap(darkParts.tokens.join('\n')).replace(/\n+$/u, '')}
}
`;

mkdirSync('packages/ui/src/themes', { recursive: true });
writeFileSync('packages/ui/src/themes/brainstrike.css', themeCss);
writeFileSync('packages/ui/src/themes/index.css', '@import "./brainstrike.css";\n');

const bridge = `:root {\n${rootParts.bridge.join('\n')}\n}\n`;
const before = source.slice(0, root.start);
const after = source.slice(dark.end);
const rewritten = `${before}${bridge}${wrap(after)}`
  .replace('/* @import "tailwindcss"; - Removed to prevent conflict with main app\'s Tailwind import */\n', '')
  .replace(/^\/\*/u, '@import "./themes/index.css";\n\n/*');
writeFileSync(GLOBALS, rewritten);
console.log('ok');
```

Expected: `ok`. Then inspect: `head -20 packages/ui/src/globals.css` shows `@import "./themes/index.css";` as the first line; `grep -c "hsl(" packages/ui/src/themes/brainstrike.css` is at least 80; `grep -n "^:root\|^\.dark" packages/ui/src/globals.css` shows one `:root {` (the bridge) before the high-contrast block.

- [ ] **Step 4: Verify the bridge is complete and single**

```bash
grep -c "var(--bs-" packages/ui/src/globals.css
```

Expected: `37` (the bridge lines, once). If the `.dark` bridge copy survived, delete it by hand; the bridge must appear exactly once.

- [ ] **Step 5: Update the focus-ring test for the new format**

Replace the body of `packages/ui/src/__tests__/focus-ring-theme.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_SOURCE_ROOT = join(process.cwd(), 'src');

describe('focus ring theme', () => {
  it('keeps global and sidebar focus tokens neutral in every mode of the baseline theme', () => {
    const source = readFileSync(join(UI_SOURCE_ROOT, 'themes', 'brainstrike.css'), 'utf8');
    const focusTokenDeclarations = [
      ...source.matchAll(/--bs-(?:sidebar-)?ring:\s*hsl\((\d+)\s/gu),
    ];

    expect(focusTokenDeclarations.length).toBe(4);
    for (const declaration of focusTokenDeclarations) {
      const hue = Number(declaration[1]);
      expect(hue === 0 || (hue >= 20 && hue <= 40)).toBe(true);
    }
  });

  it('keeps high-contrast focus tokens neutral', () => {
    const source = readFileSync(join(UI_SOURCE_ROOT, 'globals.css'), 'utf8');
    const highContrast = source.split('@media (prefers-contrast: more)')[1] ?? '';
    const declarations = [...highContrast.matchAll(/--bs-(?:sidebar-)?ring:\s*hsl\((\d+)\s/gu)];
    expect(declarations.length).toBe(4);
    for (const declaration of declarations) {
      expect(Number(declaration[1])).toBe(0);
    }
  });
});
```

- [ ] **Step 6: Copy the theme files in the package build**

In `packages/ui/package.json`, change the `build` script's copy call to:

```
node ../../scripts/copy-files.mjs src/globals.css dist/globals.css styles.css dist/styles.css src/themes/index.css dist/themes/index.css src/themes/brainstrike.css dist/themes/brainstrike.css
```

- [ ] **Step 7: Run the ui unit tests**

```bash
cd packages/ui && pnpm vitest run --project unit src/__tests__/theme-token-format.test.ts src/__tests__/focus-ring-theme.test.ts src/__tests__/theme-css-variables.test.tsx
```

Expected: PASS, 3 files.

- [ ] **Step 8: Build the package and check the dist layout**

```bash
pnpm --filter @brainstrike/ui build && ls packages/ui/dist/themes && head -3 packages/ui/dist/globals.css
```

Expected: `brainstrike.css index.css`; first line `@import "./themes/index.css";`.

- [ ] **Step 9: Commit**

```bash
pnpm dlx ultracite fix
git add packages/ui/src/themes packages/ui/src/globals.css packages/ui/package.json packages/ui/src/__tests__/theme-token-format.test.ts packages/ui/src/__tests__/focus-ring-theme.test.ts
git commit -m "refactor(theming): carve the baseline palette into themes/brainstrike.css with full colour values

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: One shared Tailwind mapping in `packages/ui/src/theme.css`

**Files:**
- Create: `packages/ui/src/theme.css`
- Modify: `packages/ui/package.json`, `apps/web/src/app/globals.css`, `apps/desktop/src/renderer/styles.css`
- Test: `packages/ui/src/__tests__/theme-css-mapping.test.ts`, `scripts/__tests__/theme-css-contract.test.mjs`

**Interfaces:**
- Produces: `@brainstrike/ui/theme.css` (package export) that every app imports once, right after `@plugin "@tailwindcss/typography"`. Utilities `bg-background` etc. resolve to `var(--background)`; `font-sans`/`font-mono`/`font-heading` resolve to the `--bs-font-*` hooks.

- [ ] **Step 1: Write the failing mapping-parity test**

Create `packages/ui/src/__tests__/theme-css-mapping.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function bridgeTokens(): string[] {
  const globals = readFileSync(join(SRC, 'globals.css'), 'utf8');
  const bridge = globals.split('@media (prefers-contrast: more)')[0] ?? '';
  return [...bridge.matchAll(/^\s*--([a-z0-9-]+):\s*var\(--bs-[a-z0-9-]+\);/gmu)].map((m) => m[1] ?? '');
}

describe('theme.css mapping', () => {
  const themeCss = readFileSync(join(SRC, 'theme.css'), 'utf8');
  const inlineBlock = /@theme inline \{(?<body>[\s\S]*?)\n\}/u.exec(themeCss)?.groups?.body ?? '';

  it('maps every colour token from the bridge with the inline idiom', () => {
    const tokens = bridgeTokens().filter((t) => t !== 'radius' && !t.startsWith('panel-surface'));
    expect(tokens.length).toBeGreaterThan(30);
    for (const token of tokens) {
      expect(inlineBlock, token).toContain(`--color-${token}: var(--${token});`);
    }
  });

  it('never wraps a mapping in hsl()', () => {
    expect(themeCss).not.toMatch(/hsl\(var\(/u);
  });

  it('exposes the font hooks and the radius scale inline', () => {
    expect(inlineBlock).toContain('--font-sans: var(--bs-font-sans);');
    expect(inlineBlock).toContain('--font-heading: var(--bs-font-heading);');
    expect(inlineBlock).toContain('--font-mono: var(--bs-font-mono);');
    expect(inlineBlock).toContain('--radius-md: calc(var(--radius) - 2px);');
  });

  it('declares the dark variant once', () => {
    expect(themeCss.match(/@custom-variant dark/gu)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/ui && pnpm vitest run --project unit src/__tests__/theme-css-mapping.test.ts
```

Expected: FAIL (`ENOENT` on `theme.css`).

- [ ] **Step 3: Create `packages/ui/src/theme.css`**

```css
/*
 * Shared Tailwind v4 mapping for every Brainstrike app. Import ONCE per app,
 * right after `@plugin "@tailwindcss/typography"` and before any @layer.
 *
 * Colour, radius and font mappings are `@theme inline` on purpose: utilities
 * then emit `var(--background)` at the use site, so a `data-theme` override
 * resolves where it is applied instead of being frozen at :root. The
 * typography scale stays in a plain `@theme` so its CSS variables keep being
 * emitted exactly as before this file existed.
 */

@custom-variant dark (&:is(.dark *));

@theme {
  /* Typography scale — 2025 visual identity */
  --text-display: clamp(2rem, 4vw, 3rem);
  --text-h1: clamp(1.5rem, 2.5vw, 2rem);
  --text-h2: 1.25rem;
  --text-h3: 1rem;
  --text-body: 0.9375rem;
  --text-ui: 0.8125rem;
  --text-caption: 0.75rem;
  --text-micro: 0.6875rem;

  --weight-light: 300;
  --weight-normal: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --weight-bold: 700;

  --tracking-tighter: -0.02em;
  --tracking-tight: -0.015em;
  --tracking-normal: 0;
  --tracking-wide: 0.01em;
  --tracking-wider: 0.02em;
  --tracking-widest: 0.03em;

  --leading-none: 1;
  --leading-tight: 1.25;
  --leading-snug: 1.375;
  --leading-normal: 1.5;
  --leading-relaxed: 1.625;
  --leading-loose: 2;

  --breakpoint-sm: 640px;
  --breakpoint-md: 768px;
  --breakpoint-lg: 1024px;
  --breakpoint-xl: 1280px;
  --breakpoint-2xl: 1536px;

  --animate-accordion-down: accordion-down 0.2s ease-out;
  --animate-accordion-up: accordion-up 0.2s ease-out;

  @keyframes accordion-down {
    from {
      height: 0;
    }
    to {
      height: var(--radix-accordion-content-height);
    }
  }
  @keyframes accordion-up {
    from {
      height: var(--radix-accordion-content-height);
    }
    to {
      height: 0;
    }
  }
}

@theme inline {
  --font-sans: var(--bs-font-sans);
  --font-heading: var(--bs-font-heading);
  --font-mono: var(--bs-font-mono);

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-border: var(--border);
  --color-panel-divider: var(--panel-divider);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);
}
```

Note: the bridge in `globals.css` currently has no `--success`/`--info` lines (only `--bs-success` etc.), so the mapping does not include them; the parity test derives its list from the bridge, which keeps this honest. `--panel-surface` is a gradient consumed by the `.bg-panel-surface` utility in `globals.css`, not a colour utility, and is skipped by the test.

- [ ] **Step 4: Export and copy it from the package**

In `packages/ui/package.json`:
- Add to `exports`: `"./theme.css": "./dist/theme.css",` directly after the `"./globals.css"` entry.
- Append to the `build` copy call: ` src/theme.css dist/theme.css`.

- [ ] **Step 5: Replace the duplicated blocks in both apps**

In `apps/web/src/app/globals.css`:
1. After the line `@plugin "@tailwindcss/typography";` insert `@import "@brainstrike/ui/theme.css";`.
2. Delete from the line `@custom-variant dark (&:is(.dark *));` through the closing `}` of the `@theme {` block (the block that ends after the `accordion-up` keyframes). Keep the `@layer components` container block and everything after it.
3. In the `body` rule inside `@layer base`, replace the `font-family:` declaration value with `var(--bs-font-sans);`.
4. In the `code, pre, kbd, samp, .font-mono` rule, replace the `font-family:` value with `var(--bs-font-mono);`.

In `apps/desktop/src/renderer/styles.css`:
1. Same insertion after `@plugin "@tailwindcss/typography";`.
2. Delete from `@custom-variant dark (&:is(.dark *));` through the closing `}` of the `@theme {` block.
3. Replace the two `font-family:` values as above (body → `var(--bs-font-sans)`, code group → `var(--bs-font-mono)`).

The desktop `body` rule still contains `background-color: hsl(var(--background));` and `color: hsl(var(--foreground));`; Task 5's codemod rewrites those.

- [ ] **Step 6: Write the failing single-owner script test**

Create `scripts/__tests__/theme-css-contract.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

const APP_STYLESHEETS = ['apps/web/src/app/globals.css', 'apps/desktop/src/renderer/styles.css'];

test('apps import the shared theme mapping exactly once and own no mapping of their own', () => {
  for (const file of APP_STYLESHEETS) {
    const source = read(file);
    const imports = source.match(/@import "@brainstrike\/ui\/theme\.css";/gu) ?? [];
    assert.equal(imports.length, 1, `${file} must import @brainstrike/ui/theme.css exactly once`);
    assert.doesNotMatch(source, /@theme\b/u, `${file} must not declare @theme; theme.css owns it`);
    assert.doesNotMatch(source, /@custom-variant dark/u, `${file} must not redeclare the dark variant`);
  }
});

test('theme.css is the only owner of the dark variant and the colour mapping', () => {
  const themeCss = read('packages/ui/src/theme.css');
  assert.equal((themeCss.match(/@custom-variant dark/gu) ?? []).length, 1);
  assert.match(themeCss, /@theme inline \{[\s\S]*--color-background: var\(--background\);/u);
});
```

- [ ] **Step 7: Run both tests**

```bash
pnpm test:scripts 2>&1 | grep -E "theme-css-contract|^# (pass|fail)"
cd packages/ui && pnpm vitest run --project unit src/__tests__/theme-css-mapping.test.ts
```

Expected: script test passes; mapping test PASS (4 tests).

- [ ] **Step 8: Build the web app to prove Tailwind accepts the layout**

```bash
pnpm --filter @brainstrike/ui build && pnpm --filter @brainstrike/web build
```

Expected: both succeed; no `Cannot apply unknown utility class` error. If `border-border` or `bg-background` is reported unknown, `theme.css` is imported after a `@layer` in the app file; move the import up.

- [ ] **Step 9: Commit**

```bash
pnpm dlx ultracite fix
git add packages/ui/src/theme.css packages/ui/package.json packages/ui/src/__tests__/theme-css-mapping.test.ts scripts/__tests__/theme-css-contract.test.mjs apps/web/src/app/globals.css apps/desktop/src/renderer/styles.css
git commit -m "refactor(theming): hoist the Tailwind mapping into @brainstrike/ui/theme.css

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: Replace the `hsl(var(--x))` idiom everywhere and guard it

**Files:**
- Modify (exact list):
  - `packages/ui/src/globals.css`
  - `apps/desktop/src/renderer/styles.css`
  - `packages/ui/src/diff-view/diff-view.tsx`
  - `packages/ui/src/code-surface/code-surface.tsx`
  - `packages/assistant-ui/src/overrides.css`
  - `packages/assistant-ui/src/__tests__/assistant-chat-polish.browser.test.tsx`
  - `packages/db-explorer/src/components/settings-panel.tsx`
  - `packages/app-shell/src/assistant-thread-tabs-dnd-elements.tsx`
  - `packages/file-explorer-ui/src/preview/preview-panel-summary.tsx`
  - `packages/file-explorer-ui/src/indexing/token-meter.tsx`
  - `packages/file-explorer-ui/src/indexing/token-summary-bar.tsx`
- Test: `scripts/__tests__/theme-css-contract.test.mjs` (extend)

Out of scope on purpose: `packages/config/tailwind/tailwind.config.js` and `packages/config/__tests__/tailwind-config.test.ts` are a Tailwind v3 preset that no stylesheet loads (`@config` appears nowhere; the v4 Vite plugin ignores `tailwind.config.js`). Leave them; the guard excludes `packages/config/tailwind/` and that test, and a separate follow-up deletes the dead config.

**Interfaces:**
- Produces: every colour consumer uses `var(--x)`; alpha uses `color-mix(in oklab, var(--x) N%, transparent)`.

- [ ] **Step 1: Extend the guard test (failing)**

Append to `scripts/__tests__/theme-css-contract.test.mjs`:

```js
import { execFileSync } from 'node:child_process';

const IDIOM_SCAN_ROOTS = ['apps', 'packages'];
const IDIOM_EXCLUDES = ['packages/config/tailwind/', 'packages/config/__tests__/tailwind-config.test.ts'];

function grepIdiom() {
  try {
    const output = execFileSync(
      'grep',
      ['-rn', '--include=*.ts', '--include=*.tsx', '--include=*.css', '--exclude-dir=node_modules', '--exclude-dir=dist', 'hsl(var(--', ...IDIOM_SCAN_ROOTS],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    return output.split('\n').filter((line) => line && !IDIOM_EXCLUDES.some((prefix) => line.startsWith(prefix)));
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      return [];
    }
    throw error;
  }
}

test('no source uses the legacy hsl(var(--x)) idiom', () => {
  const hits = grepIdiom();
  assert.deepEqual(hits, [], `legacy idiom found:\n${hits.join('\n')}`);
});
```

Run `pnpm test:scripts 2>&1 | grep -A3 "legacy hsl"`. Expected: FAIL listing 172 hits.

- [ ] **Step 2: Run the codemod (alpha forms first, then plain)**

From the repo root, with `FILES` set to the eleven files listed above:

```bash
FILES="packages/ui/src/globals.css apps/desktop/src/renderer/styles.css packages/ui/src/diff-view/diff-view.tsx packages/ui/src/code-surface/code-surface.tsx packages/assistant-ui/src/overrides.css packages/assistant-ui/src/__tests__/assistant-chat-polish.browser.test.tsx packages/db-explorer/src/components/settings-panel.tsx packages/app-shell/src/assistant-thread-tabs-dnd-elements.tsx packages/file-explorer-ui/src/preview/preview-panel-summary.tsx packages/file-explorer-ui/src/indexing/token-meter.tsx packages/file-explorer-ui/src/indexing/token-summary-bar.tsx"
perl -pi -e 's/hsl\(var\((--[a-z0-9-]+)\)\s*\/\s*(0?\.\d+|1(?:\.0)?)\)/"color-mix(in oklab, var($1) ".sprintf("%g",$2*100)."%, transparent)"/ge' $FILES
perl -pi -e 's/hsl\(var\((--[a-z0-9-]+)\)\)/var($1)/g' $FILES
perl -pi -e 's/var\((--bs-[a-z0-9-]+),\s*(\d[\d.]*\s+[\d.]+%\s+[\d.]+%)\)/var($1, hsl($2))/g' packages/assistant-ui/src/overrides.css
grep -rn "hsl(var(" $FILES; echo "exit=$?"
```

Expected: the final grep prints nothing and `exit=1`.

- [ ] **Step 3: Rewrite the three Tailwind arbitrary-value sites by hand**

- `packages/file-explorer-ui/src/indexing/token-meter.tsx:170`: `text-[hsl(var(--chart-2))]` → `text-chart-2`
- `packages/file-explorer-ui/src/preview/preview-panel-summary.tsx:329`: `'bg-[hsl(var(--chart-2))]/80'` → `'bg-chart-2/80'`
- `packages/file-explorer-ui/src/indexing/token-summary-bar.tsx:262`: `iconColor="text-[hsl(var(--chart-2))]"` → `iconColor="text-chart-2"`

(The perl in Step 2 already turned these into `text-[var(--chart-2)]`; replace that form with the plain utility.) Verify: `grep -rn "\[var(--chart" packages/file-explorer-ui/src` prints nothing.

- [ ] **Step 4: Spot-check the alpha conversions**

```bash
grep -n "color-mix" packages/ui/src/diff-view/diff-view.tsx | head -3
grep -n "color-mix" packages/assistant-ui/src/overrides.css | head -3
grep -n "var(--bs-background, hsl(" packages/assistant-ui/src/overrides.css
```

Expected: e.g. `backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)'`; two `--bs-background` fallback lines wrapped in `hsl()`.

- [ ] **Step 5: Run the guard and the affected package suites**

```bash
pnpm test:scripts 2>&1 | grep -E "legacy hsl|^# (pass|fail)"
pnpm --filter @brainstrike/ui test
pnpm --filter @brainstrike/assistant-ui test
pnpm --filter @brainstrike/file-explorer-ui test
pnpm --filter @brainstrike/db-explorer test
pnpm --filter @brainstrike/app-shell test
pnpm --filter @brainstrike/ui test:browser
pnpm --filter @brainstrike/assistant-ui test:browser
```

Expected: guard passes; every suite green. A browser test asserting a computed colour equal to a specific `rgb()` string will still pass, because the resolved colours are identical.

- [ ] **Step 6: Type-check and lint**

```bash
pnpm type-check
pnpm dlx ultracite check
```

Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add $FILES scripts/__tests__/theme-css-contract.test.mjs
git commit -m "refactor(theming): consume tokens as var(--x) and guard the legacy hsl(var()) idiom

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: Update the web e2e assertions for full-value tokens

**Files:**
- Modify: `apps/web/e2e/theme-css-consistency.test.ts`

Why: the suite parses `--bs-background` as a bare triplet (`split(' ')[2]`) and reads `--color-background`, which `@theme inline` no longer emits as a custom property.

- [ ] **Step 1: Add a parser helper at the top of the file (after the imports)**

```ts
interface HslParts {
  hue: number;
  lightness: number;
  saturation: number;
}

/** The baseline theme authors every token as `hsl(H S% L%)`; anything else is a regression. */
function parseHsl(value: string): HslParts {
  const match = /^hsl\((?<hue>\d+(?:\.\d+)?)\s+(?<saturation>\d+(?:\.\d+)?)%\s+(?<lightness>\d+(?:\.\d+)?)%\)$/u.exec(
    value
  );
  if (!match?.groups) {
    throw new Error(`Expected an hsl(H S% L%) token, got "${value}"`);
  }
  return {
    hue: Number(match.groups.hue),
    lightness: Number(match.groups.lightness),
    saturation: Number(match.groups.saturation),
  };
}
```

- [ ] **Step 2: Rewrite each affected test body**

`should load CSS variables in light mode` and `... in dark mode`: in the `page.evaluate` return object replace the `colorBackground` line with
`bodyBackground: getComputedStyle(document.body).backgroundColor,` and replace the assertion `expect(variables.colorBackground).toBeTruthy();` with
`expect(variables.bodyBackground).not.toBe('rgba(0, 0, 0, 0)');`. Replace the lightness lines with `expect(parseHsl(variables.bsBackground).lightness).toBeGreaterThan(90);` (light) and `.toBeLessThan(20)` (dark).

`should maintain warm neutral theme in dark mode`: make the evaluate return only `getComputedStyle(document.documentElement).getPropertyValue('--bs-background').trim()` as a string, then in Node: `const themeValues = parseHsl(background);` and keep the existing hue/saturation/lightness expectations.

`uses neutral focus tokens instead of brand-blue borders`: replace the inner loop body with `const { hue } = parseHsl(token); expect(hue === 0 || (hue >= 20 && hue <= 40)).toBe(true);`.

`should not have assistant-ui hardcoded values overriding theme`: evaluate returns the `--background` string; in Node: `const { hue, saturation } = parseHsl(background); expect(hue === 240 && saturation === 10).toBe(false);`.

`should have visible gradients with sufficient color separation`: evaluate returns `{ background, muted }` strings; in Node: `const colorSeparation = Math.abs(parseHsl(background).lightness - parseHsl(muted).lightness);` and keep the `>= 5` expectation.

The `--background` equals `--bs-background` tests need no change: both computed strings are now `hsl(...)`.

- [ ] **Step 3: Build, then run the two theme suites**

The web e2e serves `dist`; never run it without a build first.

```bash
pnpm --filter @brainstrike/ui build && pnpm --filter @brainstrike/web build
pnpm --filter @brainstrike/web test:e2e -- theme-css-consistency theme-switching
```

Expected: all tests in both files pass.

- [ ] **Step 4: Commit**

```bash
pnpm dlx ultracite fix
git add apps/web/e2e/theme-css-consistency.test.ts
git commit -m "test(theming): parse full-value tokens in the web theme e2e suite

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: Prove zero visual change and open PR 1

- [ ] **Step 1: After screenshots**

Repeat Task 2 Steps 2 and 3 exactly, saving as `after-web-<mode>.png/.json` and `after-desktop-<mode>.png/.json`.

- [ ] **Step 2: Compare**

```bash
for f in web-light web-dark desktop-light desktop-dark; do diff <(jq -S . baseline-$f.json) <(jq -S . after-$f.json) && echo "$f: identical"; done
```

Expected: four `identical` lines (`ring` and `primary` strings change from `30 25% 99%` form to `hsl(30 25% 99%)` form; if so, compare `bg` and `fg` only and note the token-string change in the PR body). Visually compare the PNG pairs side by side; any difference is a defect to fix before opening the PR.

- [ ] **Step 3: Full gates**

```bash
pnpm type-check
pnpm test:scripts
pnpm run react-doctor
pnpm dlx ultracite check
```

Expected: clean.

- [ ] **Step 4: Ticket and PR**

File a Linear ticket per `docs/agents/issue-tracker.md` (title: "Theming: full-value tokens and shared Tailwind mapping"), then:

```bash
git push -u origin theming/token-format-refactor
gh pr create --base main --title "refactor(theming): full-value tokens and shared Tailwind mapping (BST-XXXX)" --body-file <scratchpad>/pr1-body.md
```

Replace `BST-XXXX` with the ticket id. The body lists: the format change with the `hsl()` wrap rule, the single mapping file, the idiom rewrite counts (128 plain, 53 alpha, 3 arbitrary utilities, 68 fallbacks), before/after screenshot pairs, and the dead v3 config follow-up. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

# PR 2 — palettes

### Task 8: Preset-to-theme generator, fixture, and the three generated themes

**Files:**
- Create: `scripts/import-shadcn-theme.mjs`, `scripts/shadcn-theme-fixture/{components.json,package.json,tsconfig.json,vite.config.ts,index.html,src/index.css}`, `scripts/__tests__/import-shadcn-theme.test.mjs`, `scripts/__tests__/fixtures/shadcn-apply-buKEvLs.css`, `packages/ui/src/themes/{ember,tide,orchid}.css`
- Modify: `packages/ui/src/themes/index.css`, `packages/ui/package.json`

**Interfaces:**
- Produces (ESM exports of `scripts/import-shadcn-theme.mjs`): `extractBlock(css: string, selector: string): Map<string, string>`, `renderThemeCss(input: { id: string; code: string; decoded: Record<string, string>; light: Map<string, string>; dark: Map<string, string> }): string`, `assertThemeId(id: string): void`. CLI: `node scripts/import-shadcn-theme.mjs <code> <id> [--from-css <file>]`.
- Generated selectors: `:root[data-theme="<id>"]` and `:root[data-theme="<id>"].dark`.

- [ ] **Step 1: Create the PR 2 branch on top of PR 1**

```bash
git checkout -b theming/multi-theme theming/token-format-refactor
```

- [ ] **Step 2: Create the fixture**

`scripts/shadcn-theme-fixture/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-vega",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "rtl": false,
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "menuColor": "default",
  "menuAccent": "subtle",
  "registries": {}
}
```

`scripts/shadcn-theme-fixture/package.json`:

```json
{ "name": "shadcn-theme-fixture", "private": true, "type": "module" }
```

`scripts/shadcn-theme-fixture/tsconfig.json`:

```json
{ "files": [], "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
```

`scripts/shadcn-theme-fixture/vite.config.ts` (framework marker the CLI requires; never executed):

```ts
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
})
```

`scripts/shadcn-theme-fixture/index.html`:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>shadcn-theme-fixture</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`scripts/shadcn-theme-fixture/src/index.css` (seed; `apply` fills in the rest):

```css
@import "tailwindcss";

:root {
  --background: oklch(1 0 0);
  --radius: 0.625rem;
}

.dark {
  --background: oklch(0.145 0 0);
}
```

Add a `scripts/shadcn-theme-fixture/README.md`:

```md
Fixture project for `scripts/import-shadcn-theme.mjs`. The shadcn CLI refuses to `apply`
a preset without Vite framework markers (`vite.config.ts`, `index.html`) and a
`components.json`; none of these files are built or executed. Do not add dependencies.
```


- [ ] **Step 3: Capture the applied CSS fixture and write the failing generator unit test**

Capture the vendor's applied output once (network) so the unit tests stay offline:

```bash
TMP=$(mktemp -d) && cp -r scripts/shadcn-theme-fixture/. "$TMP" && (cd "$TMP" && npx -y shadcn@latest apply buKEvLs --only theme -y) && cp "$TMP/src/index.css" scripts/__tests__/fixtures/shadcn-apply-buKEvLs.css && rm -rf "$TMP"
```

Create `scripts/__tests__/import-shadcn-theme.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertThemeId, extractBlock, renderThemeCss } from '../import-shadcn-theme.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const applied = readFileSync(path.join(here, 'fixtures', 'shadcn-apply-buKEvLs.css'), 'utf8');

const DECODED_EMBER = {
  baseColor: 'neutral',
  chartColor: 'neutral',
  font: 'inter',
  fontHeading: 'inherit',
  iconLibrary: 'lucide',
  menuAccent: 'subtle',
  menuColor: 'default',
  radius: 'large',
  style: 'lyra',
  theme: 'red',
};

test('extractBlock reads the :root and .dark token maps', () => {
  const light = extractBlock(applied, ':root');
  const dark = extractBlock(applied, '.dark');
  assert.equal(light.get('primary'), 'oklch(0.505 0.213 27.518)');
  assert.equal(light.get('radius'), '0.875rem');
  assert.equal(dark.get('primary'), 'oklch(0.444 0.177 26.899)');
  assert.equal(dark.has('radius'), false);
});

test('renderThemeCss emits scoped selectors, renamed tokens and derived tokens', () => {
  const css = renderThemeCss({
    code: 'buKEvLs',
    dark: extractBlock(applied, '.dark'),
    decoded: DECODED_EMBER,
    id: 'ember',
    light: extractBlock(applied, ':root'),
  });
  assert.match(css, /^\/\*[\s\S]*preset buKEvLs[\s\S]*style\s+lyra/u);
  assert.match(css, /\n:root\[data-theme="ember"\] \{\n/u);
  assert.match(css, /\n:root\[data-theme="ember"\]\.dark \{\n/u);
  assert.match(css, /--bs-primary: oklch\(0\.505 0\.213 27\.518\);/u);
  assert.match(css, /--bs-radius: 0\.875rem;/u);
  assert.match(css, /--bs-destructive-foreground: oklch\(0\.985 0 0\);/u);
  assert.match(css, /--bs-panel-divider: oklch\(from var\(--bs-border\) calc\(l - 0\.06\) c h\);/u);
  assert.match(css, /--bs-panel-divider: oklch\(from var\(--bs-border\) calc\(l \+ 0\.06\) c h\);/u);
  assert.match(css, /--bs-panel-surface: linear-gradient\(to bottom, var\(--bs-background\), var\(--bs-muted\)\);/u);
  assert.doesNotMatch(css, /--bs-success|--bs-warning|--bs-info|--bs-font-/u);
});

test('the checked-in ember.css is exactly what the generator produces (regenerate is a no-op)', () => {
  const expected = renderThemeCss({
    code: 'buKEvLs',
    dark: extractBlock(applied, '.dark'),
    decoded: DECODED_EMBER,
    id: 'ember',
    light: extractBlock(applied, ':root'),
  });
  const actual = readFileSync(path.join(repoRoot, 'packages/ui/src/themes/ember.css'), 'utf8');
  assert.equal(actual, expected);
});

test('assertThemeId rejects anything but a lowercase slug', () => {
  assertThemeId('ember');
  assert.throws(() => assertThemeId('Ember'), /theme id/u);
  assert.throws(() => assertThemeId('brainstrike'), /reserved/u);
});
```

- [ ] **Step 4: Run it to verify it fails**

```bash
pnpm test:scripts 2>&1 | grep -E "import-shadcn-theme|Cannot find module" | head -3
```

Expected: fails with `Cannot find module '../import-shadcn-theme.mjs'`.

- [ ] **Step 5: Write the generator**

Create `scripts/import-shadcn-theme.mjs`:

```js
#!/usr/bin/env node
/**
 * Turn a shadcn preset code into a Brainstrike theme file.
 *
 *   node scripts/import-shadcn-theme.mjs <preset-code> <theme-id> [--from-css <applied-index.css>]
 *
 * Without --from-css the script copies scripts/shadcn-theme-fixture to a temp
 * dir and runs `npx shadcn@latest apply <code> --only theme` there (network).
 * With --from-css it renders from an already-applied index.css (offline; used
 * by the tests and for capturing fixtures). Values are never hand-edited:
 * re-run this script to change a theme.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(repoRoot, 'scripts', 'shadcn-theme-fixture');
const THEMES_DIR = path.join(repoRoot, 'packages', 'ui', 'src', 'themes');
const RESERVED_IDS = new Set(['brainstrike']);
const THEME_ID = /^[a-z][a-z0-9-]*$/u;

export function assertThemeId(id) {
  if (!THEME_ID.test(id)) {
    throw new Error(`theme id "${id}" must be a lowercase slug (a-z, 0-9, -)`);
  }
  if (RESERVED_IDS.has(id)) {
    throw new Error(`theme id "${id}" is reserved for the hand-maintained baseline`);
  }
}

/** Reads `selector { --x: value; ... }` into a Map of token name (without --) to value. */
export function extractBlock(css, selector) {
  const pattern = new RegExp(`^${selector.replace(/[.[\]]/gu, '\\$&')}\\s*\\{([\\s\\S]*?)^\\}`, 'mu');
  const match = pattern.exec(css);
  if (!match) {
    throw new Error(`block "${selector}" not found in applied CSS`);
  }
  const tokens = new Map();
  for (const line of match[1].split('\n')) {
    const declaration = /^\s*--([a-z0-9-]+):\s*(.+?);\s*$/u.exec(line);
    if (declaration) {
      tokens.set(declaration[1], declaration[2]);
    }
  }
  return tokens;
}

const DERIVED = {
  dark: [
    ['panel-divider', 'oklch(from var(--bs-border) calc(l + 0.06) c h)'],
    ['panel-surface', 'linear-gradient(to bottom, var(--bs-background), var(--bs-muted))'],
  ],
  light: [
    ['panel-divider', 'oklch(from var(--bs-border) calc(l - 0.06) c h)'],
    ['panel-surface', 'linear-gradient(to bottom, var(--bs-background), var(--bs-muted))'],
  ],
};
const DESTRUCTIVE_FOREGROUND_FALLBACK = 'oklch(0.985 0 0)';

function renderBlock(selector, tokens, derived) {
  const lines = [];
  for (const [name, value] of tokens) {
    lines.push(`  --bs-${name}: ${value};`);
  }
  if (!tokens.has('destructive-foreground')) {
    lines.push(`  --bs-destructive-foreground: ${DESTRUCTIVE_FOREGROUND_FALLBACK};`);
  }
  for (const [name, value] of derived) {
    lines.push(`  --bs-${name}: ${value};`);
  }
  return `${selector} {\n${lines.join('\n')}\n}\n`;
}

export function renderThemeCss({ id, code, decoded, light, dark }) {
  assertThemeId(id);
  const decodedLines = Object.entries(decoded)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ` *   ${key.padEnd(12)}${value}`)
    .join('\n');
  const header = `/*
 * Theme "${id}" — GENERATED from shadcn preset ${code}. Do not hand-edit values.
 * Regenerate: node scripts/import-shadcn-theme.mjs ${code} ${id}
 * Preview:    https://ui.shadcn.com/create?preset=${code}
 *
 * Decoded preset:
${decodedLines}
 *
 * Only the colour palette and radius are adopted. Style, fonts and icons are
 * project-wide choices and are not part of a theme. Semantic status tokens
 * (success/warning/info) and the font hooks inherit from themes/brainstrike.css.
 */
`;
  return `${header}${renderBlock(`:root[data-theme="${id}"]`, light, DERIVED.light)}\n${renderBlock(
    `:root[data-theme="${id}"].dark`,
    dark,
    DERIVED.dark
  )}`;
}

function decodePreset(code) {
  const output = execFileSync('npx', ['-y', 'shadcn@latest', 'preset', 'decode', code], { encoding: 'utf8' });
  const decoded = {};
  for (const line of output.split('\n')) {
    const match = /^\s{2}([a-zA-Z]+)\s{2,}(\S+)\s*$/u.exec(line);
    if (match && match[1] !== 'code' && match[1] !== 'version' && match[1] !== 'url') {
      decoded[match[1]] = match[2];
    }
  }
  if (!decoded.style) {
    throw new Error(`could not decode preset "${code}":\n${output}`);
  }
  return decoded;
}

function applyPreset(code) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'shadcn-theme-'));
  try {
    cpSync(FIXTURE_DIR, tmp, { recursive: true });
    execFileSync('npx', ['-y', 'shadcn@latest', 'apply', code, '--only', 'theme', '-y'], { cwd: tmp, stdio: 'inherit' });
    return readFileSync(path.join(tmp, 'src', 'index.css'), 'utf8');
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
}

function main(argv) {
  const [code, id, ...rest] = argv;
  if (!code || !id) {
    console.error('usage: node scripts/import-shadcn-theme.mjs <preset-code> <theme-id> [--from-css <file>]');
    process.exit(1);
  }
  assertThemeId(id);
  const fromCssIndex = rest.indexOf('--from-css');
  const applied = fromCssIndex >= 0 ? readFileSync(path.resolve(rest[fromCssIndex + 1]), 'utf8') : applyPreset(code);
  const decoded = decodePreset(code);
  const light = extractBlock(applied, ':root');
  const dark = extractBlock(applied, '.dark');
  const css = renderThemeCss({ code, dark, decoded, id, light });
  const target = path.join(THEMES_DIR, `${id}.css`);
  writeFileSync(target, css);
  console.log(`wrote ${path.relative(repoRoot, target)}`);
  console.log('Registry entry (packages/ui/src/themes/index.ts):');
  console.log(
    JSON.stringify(
      {
        id,
        label: id.charAt(0).toUpperCase() + id.slice(1),
        presetCode: code,
        swatch: {
          dark: { background: dark.get('background'), primary: dark.get('primary') },
          light: { background: light.get('background'), primary: light.get('primary') },
        },
      },
      null,
      2
    )
  );
  console.log('Then add `@import "./' + id + '.css";` to packages/ui/src/themes/index.css and the dist copy pair in packages/ui/package.json.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
```

- [ ] **Step 6: Generate the three themes**

```bash
node scripts/import-shadcn-theme.mjs buKEvLs ember
node scripts/import-shadcn-theme.mjs bNRM0gzE1 tide
node scripts/import-shadcn-theme.mjs b4aRK71bRz orchid
ls packages/ui/src/themes
```

Expected: `brainstrike.css ember.css index.css orchid.css tide.css`. Record each printed registry entry for Task 9.

- [ ] **Step 7: Register the files for import and dist copy**

`packages/ui/src/themes/index.css`:

```css
@import "./brainstrike.css";
@import "./ember.css";
@import "./tide.css";
@import "./orchid.css";
```

In `packages/ui/package.json` `build`, append ` src/themes/ember.css dist/themes/ember.css src/themes/tide.css dist/themes/tide.css src/themes/orchid.css dist/themes/orchid.css`.

- [ ] **Step 8: Run the generator tests and the ui build**

```bash
pnpm test:scripts 2>&1 | grep -E "import-shadcn-theme|regenerate|^# (pass|fail)"
pnpm --filter @brainstrike/ui build && ls packages/ui/dist/themes
```

Expected: 4 generator tests pass; dist lists five css files.

- [ ] **Step 9: Commit**

```bash
pnpm dlx ultracite fix
git add scripts/import-shadcn-theme.mjs scripts/shadcn-theme-fixture scripts/__tests__/import-shadcn-theme.test.mjs scripts/__tests__/fixtures/shadcn-apply-buKEvLs.css packages/ui/src/themes packages/ui/package.json
git commit -m "feat(theming): generate ember, tide and orchid palettes from shadcn presets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: Theme registry and parity test

**Files:**
- Create: `packages/ui/src/themes/index.ts`, `packages/ui/src/__tests__/theme-registry.test.ts`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**
- Produces: `type ThemeId = 'brainstrike' | 'ember' | 'tide' | 'orchid'`, `interface ThemeDefinition`, `const THEMES: readonly ThemeDefinition[]`, `const DEFAULT_THEME: ThemeId`, `function isThemeId(value: unknown): value is ThemeId`, all exported from `@brainstrike/ui`.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/__tests__/theme-registry.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, isThemeId, THEMES } from '../themes';

const THEMES_DIR = join(process.cwd(), 'src', 'themes');
const PACKAGE_JSON = join(process.cwd(), 'package.json');

const REQUIRED_COLOUR_TOKENS = [
  'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
  'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground',
  'accent', 'accent-foreground', 'destructive', 'destructive-foreground', 'border', 'input', 'ring',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
  'sidebar', 'sidebar-foreground', 'sidebar-primary', 'sidebar-primary-foreground',
  'sidebar-accent', 'sidebar-accent-foreground', 'sidebar-border', 'sidebar-ring',
  'panel-divider', 'panel-surface',
] as const;

function block(source: string, selector: string): string {
  const escaped = selector.replace(/[.[\]]/gu, '\\$&');
  const match = new RegExp(`^${escaped} \\{([\\s\\S]*?)^\\}`, 'mu').exec(source);
  if (!match) {
    throw new Error(`selector ${selector} missing`);
  }
  return match[1] ?? '';
}

describe('theme registry', () => {
  const cssFiles = readdirSync(THEMES_DIR).filter((f) => f.endsWith('.css') && f !== 'index.css');
  const indexCss = readFileSync(join(THEMES_DIR, 'index.css'), 'utf8');
  const buildScript = (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { scripts: { build: string } }).scripts.build;

  it('has one css file per registry entry and one entry per css file', () => {
    expect(cssFiles.sort()).toEqual(THEMES.map((t) => `${t.id}.css`).sort());
  });

  it('imports every theme exactly once and copies it to dist', () => {
    for (const theme of THEMES) {
      expect(indexCss.match(new RegExp(`@import "\\./${theme.id}\\.css";`, 'gu'))).toHaveLength(1);
      expect(buildScript).toContain(`src/themes/${theme.id}.css dist/themes/${theme.id}.css`);
    }
    expect(buildScript).toContain('src/themes/index.css dist/themes/index.css');
  });

  it('scopes every generated theme and declares the complete token set in both modes', () => {
    for (const theme of THEMES.filter((t) => t.id !== DEFAULT_THEME)) {
      const source = readFileSync(join(THEMES_DIR, `${theme.id}.css`), 'utf8');
      expect(source).toContain(`preset ${theme.presetCode}`);
      const light = block(source, `:root[data-theme="${theme.id}"]`);
      const dark = block(source, `:root[data-theme="${theme.id}"].dark`);
      for (const token of REQUIRED_COLOUR_TOKENS) {
        expect(light, `${theme.id} light --bs-${token}`).toMatch(new RegExp(`--bs-${token}:`, 'u'));
        expect(dark, `${theme.id} dark --bs-${token}`).toMatch(new RegExp(`--bs-${token}:`, 'u'));
      }
      expect(light).toMatch(/--bs-radius:/u);
      expect(source).not.toMatch(/^:root \{|^\.dark \{/mu);
    }
  });

  it('keeps focus rings near-neutral in every generated theme', () => {
    for (const theme of THEMES.filter((t) => t.id !== DEFAULT_THEME)) {
      const source = readFileSync(join(THEMES_DIR, `${theme.id}.css`), 'utf8');
      const rings = [...source.matchAll(/--bs-(?:sidebar-)?ring:\s*oklch\([\d.]+\s+([\d.]+)\s/gu)];
      expect(rings).toHaveLength(4);
      for (const ring of rings) {
        expect(Number(ring[1])).toBeLessThanOrEqual(0.04);
      }
    }
  });

  it('exposes a default, a guard and swatches', () => {
    expect(isThemeId(DEFAULT_THEME)).toBe(true);
    expect(isThemeId('nope')).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
    for (const theme of THEMES) {
      expect(theme.swatch.light.background).toMatch(/^(?:hsl|oklch)\(/u);
      expect(theme.swatch.dark.primary).toMatch(/^(?:hsl|oklch)\(/u);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/ui && pnpm vitest run --project unit src/__tests__/theme-registry.test.ts
```

Expected: FAIL (cannot resolve `../themes`).

- [ ] **Step 3: Create the registry**

`packages/ui/src/themes/index.ts` (fill the three generated swatches from the values Task 8 Step 6 printed; the brainstrike values are the baseline `--bs-background`/`--bs-primary` from `brainstrike.css`):

```ts
/**
 * Palette registry. One entry per file in this directory (parity is pinned by
 * theme-registry.test.ts). Add a theme with scripts/import-shadcn-theme.mjs,
 * then append its entry here.
 */
export type ThemeId = 'brainstrike' | 'ember' | 'tide' | 'orchid';

export interface ThemeSwatch {
  readonly background: string;
  readonly primary: string;
}

export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly label: string;
  /** shadcn preset code the file was generated from; null for the hand-maintained baseline. */
  readonly presetCode: string | null;
  readonly swatch: { readonly dark: ThemeSwatch; readonly light: ThemeSwatch };
}

export const DEFAULT_THEME: ThemeId = 'brainstrike';

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'brainstrike',
    label: 'Brainstrike',
    presetCode: null,
    swatch: {
      dark: { background: 'hsl(30 8% 9%)', primary: 'hsl(215 50% 58%)' },
      light: { background: 'hsl(30 25% 99%)', primary: 'hsl(215 55% 45%)' },
    },
  },
  {
    id: 'ember',
    label: 'Ember',
    presetCode: 'buKEvLs',
    swatch: {
      dark: { background: 'oklch(0.145 0 0)', primary: 'oklch(0.444 0.177 26.899)' },
      light: { background: 'oklch(1 0 0)', primary: 'oklch(0.505 0.213 27.518)' },
    },
  },
  {
    id: 'tide',
    label: 'Tide',
    presetCode: 'bNRM0gzE1',
    swatch: {
      dark: { background: 'oklch(0.148 0.004 228.8)', primary: 'oklch(0.45 0.085 224.283)' },
      light: { background: 'oklch(1 0 0)', primary: 'oklch(0.52 0.105 223.128)' },
    },
  },
  {
    id: 'orchid',
    label: 'Orchid',
    presetCode: 'b4aRK71bRz',
    swatch: {
      dark: { background: 'oklch(0.145 0.008 326)', primary: 'oklch(0.459 0.187 3.815)' },
      light: { background: 'oklch(1 0 0)', primary: 'oklch(0.525 0.223 3.958)' },
    },
  },
];

const THEME_IDS: ReadonlySet<string> = new Set(THEMES.map((theme) => theme.id));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_IDS.has(value);
}
```

Append to `packages/ui/src/index.ts` next to the theme exports: `export * from './themes';`.

- [ ] **Step 4: Run the test, then mutate it**

```bash
cd packages/ui && pnpm vitest run --project unit src/__tests__/theme-registry.test.ts
```

Expected: PASS (5 tests). Mutation check: temporarily delete the `@import "./tide.css";` line from `index.css`, re-run, expect the import test to FAIL, restore the line, re-run, expect PASS.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix
git add packages/ui/src/themes/index.ts packages/ui/src/index.ts packages/ui/src/__tests__/theme-registry.test.ts
git commit -m "feat(theming): add the palette registry with file parity and focus-ring guards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: Provider with mode and theme, persistence, and consumers

**Files:**
- Modify: `packages/ui/src/theme-provider.tsx`, `packages/ui/src/hooks/use-resolved-theme.ts`, `packages/ui/src/theme-toggle.tsx`, `packages/app-shell/src/types.ts`, `packages/app-shell/src/app-config.tsx`, `packages/app-shell/src/app-layout.tsx`, `packages/app-shell/src/use-global-command-handlers.ts`
- Test: `packages/ui/src/__tests__/theme-provider.test.tsx` (rewrite), `packages/ui/src/__tests__/theme-css-variables.test.tsx`, `packages/ui/src/__tests__/use-resolved-theme.test.tsx`, `packages/ui/src/__tests__/theme-toggle.test.tsx`

**Interfaces:**
- Produces: `export type ThemeMode = 'dark' | 'light' | 'system'`; `useTheme(): { mode: ThemeMode; setMode(mode: ThemeMode): void; theme: ThemeId; setTheme(theme: ThemeId): void }`; `ThemeProvider` props `{ children; defaultMode?: ThemeMode; defaultTheme?: ThemeId; storageAdapter: ThemeStorageAdapter; storageKey?: string; themeStorageKey?: string }`; `AppShellConfig.themePaletteStorageKey: string` defaulting to `'app-theme-palette'`.

- [ ] **Step 1: Rewrite the provider test (failing)**

Replace `packages/ui/src/__tests__/theme-provider.test.tsx` entirely:

```tsx
/**
 * @vitest-environment happy-dom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, type ThemeStorageAdapter, useTheme } from '../theme-provider';

const warn = vi.fn();
vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn }),
}));

function createStorage(seed: Record<string, string> = {}): ThemeStorageAdapter & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: vi.fn(async (key: string) => data.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

function wrapperFor(storage: ThemeStorageAdapter, extra: Partial<Parameters<typeof ThemeProvider>[0]> = {}) {
  return ({ children }: { children: ReactNode }) => (
    <ThemeProvider storageAdapter={storage} {...extra}>
      {children}
    </ThemeProvider>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    warn.mockClear();
    document.documentElement.className = '';
    delete document.documentElement.dataset.theme;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to system mode and the brainstrike theme', async () => {
    const { result } = renderHook(() => useTheme(), { wrapper: wrapperFor(createStorage()) });
    await waitFor(() => expect(result.current.mode).toBe('system'));
    expect(result.current.theme).toBe('brainstrike');
    expect(document.documentElement.dataset.theme).toBe('brainstrike');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('loads a persisted mode and theme from separate keys', async () => {
    const storage = createStorage({ 'ui-theme': 'light', 'ui-theme-palette': 'tide' });
    const { result } = renderHook(() => useTheme(), { wrapper: wrapperFor(storage) });
    await waitFor(() => expect(result.current.theme).toBe('tide'));
    expect(result.current.mode).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('tide');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('persists setMode and setTheme under their own keys', async () => {
    const storage = createStorage();
    const { result } = renderHook(() => useTheme(), { wrapper: wrapperFor(storage, { storageKey: 'k-mode', themeStorageKey: 'k-theme' }) });
    await waitFor(() => expect(result.current.mode).toBe('system'));
    act(() => result.current.setMode('dark'));
    act(() => result.current.setTheme('orchid'));
    expect(storage.setItem).toHaveBeenCalledWith('k-mode', 'dark');
    expect(storage.setItem).toHaveBeenCalledWith('k-theme', 'orchid');
    expect(document.documentElement.dataset.theme).toBe('orchid');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('resets an unknown persisted theme to the default and warns', async () => {
    const storage = createStorage({ 'ui-theme-palette': 'retired-theme' });
    const { result } = renderHook(() => useTheme(), { wrapper: wrapperFor(storage) });
    await waitFor(() => expect(result.current.theme).toBe('brainstrike'));
    expect(warn).toHaveBeenCalledWith(
      'Ignoring unknown persisted theme',
      expect.objectContaining({ key: 'ui-theme-palette', value: 'retired-theme' })
    );
  });

  it('resets an unknown persisted mode to the default and warns', async () => {
    const storage = createStorage({ 'ui-theme': 'sepia' });
    const { result } = renderHook(() => useTheme(), { wrapper: wrapperFor(storage, { defaultMode: 'light' }) });
    await waitFor(() => expect(result.current.mode).toBe('light'));
    expect(warn).toHaveBeenCalledWith(
      'Ignoring unknown persisted theme mode',
      expect.objectContaining({ key: 'ui-theme', value: 'sepia' })
    );
  });

  it('honours defaultMode and defaultTheme when nothing is persisted', async () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: wrapperFor(createStorage(), { defaultMode: 'light', defaultTheme: 'ember' }),
    });
    await waitFor(() => expect(result.current.theme).toBe('ember'));
    expect(result.current.mode).toBe('light');
  });

  it('throws when useTheme is used outside the provider', () => {
    expect(() => renderHook(() => useTheme())).toThrow('useTheme must be used within a ThemeProvider');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/ui && pnpm vitest run --project unit src/__tests__/theme-provider.test.tsx
```

Expected: FAIL (`result.current.mode` undefined; `ThemeProvider` has no `defaultMode`).

- [ ] **Step 3: Rewrite the provider**

Replace `packages/ui/src/theme-provider.tsx`:

```tsx
import { createLogger } from '@brainstrike/logging';
import * as React from 'react';
import { DEFAULT_THEME, isThemeId, type ThemeId } from './themes';

const logger = createLogger('ThemeProvider');

export type ThemeMode = 'dark' | 'light' | 'system';

const THEME_MODES: ReadonlySet<string> = new Set(['dark', 'light', 'system']);

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && THEME_MODES.has(value);
}

export interface ThemeStorageAdapter {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

interface ThemeProviderProps {
  children: React.ReactNode;
  /** Light/dark/system. Persisted under `storageKey`. */
  defaultMode?: ThemeMode;
  /** Palette id. Persisted under `themeStorageKey`. */
  defaultTheme?: ThemeId;
  storageAdapter: ThemeStorageAdapter;
  storageKey?: string;
  themeStorageKey?: string;
}

interface ThemeProviderState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  setTheme: (theme: ThemeId) => void;
  theme: ThemeId;
}

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined);

export function ThemeProvider({
  children,
  defaultMode = 'system',
  defaultTheme = DEFAULT_THEME,
  storageAdapter,
  storageKey = 'ui-theme',
  themeStorageKey = 'ui-theme-palette',
}: ThemeProviderProps) {
  const [mode, setModeState] = React.useState<ThemeMode>(defaultMode);
  const [theme, setThemeState] = React.useState<ThemeId>(defaultTheme);
  const [mounted, setMounted] = React.useState(false);

  // Storage is async and only reachable after mount (client-side). An unknown
  // persisted value (e.g. a theme removed in a later release) must not blank
  // the app, and must not be silent: it falls back to the default and warns.
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      const [savedMode, savedTheme] = await Promise.all([
        storageAdapter.getItem(storageKey),
        storageAdapter.getItem(themeStorageKey),
      ]);
      if (cancelled) {
        return;
      }
      if (savedMode !== null) {
        if (isThemeMode(savedMode)) {
          setModeState(savedMode);
        } else {
          logger.warn('Ignoring unknown persisted theme mode', { key: storageKey, value: savedMode });
        }
      }
      if (savedTheme !== null) {
        if (isThemeId(savedTheme)) {
          setThemeState(savedTheme);
        } else {
          logger.warn('Ignoring unknown persisted theme', { key: themeStorageKey, value: savedTheme });
        }
      }
      setMounted(true);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [storageAdapter, storageKey, themeStorageKey]);

  React.useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    if (mode === 'system') {
      const systemMode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.classList.add(systemMode);
      return;
    }
    root.classList.add(mode);
  }, [mode]);

  React.useEffect(() => {
    window.document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setMode = React.useCallback(
    (next: ThemeMode) => {
      void storageAdapter.setItem(storageKey, next);
      setModeState(next);
    },
    [storageAdapter, storageKey]
  );

  const setTheme = React.useCallback(
    (next: ThemeId) => {
      void storageAdapter.setItem(themeStorageKey, next);
      setThemeState(next);
    },
    [storageAdapter, themeStorageKey]
  );

  const value = React.useMemo(() => ({ mode, setMode, setTheme, theme }), [mode, setMode, setTheme, theme]);

  // Prevent a flash of the wrong mode/theme before storage has been read.
  if (!mounted) {
    return null;
  }

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
```

- [ ] **Step 4: Update the hook and the consumers that only care about mode**

`packages/ui/src/hooks/use-resolved-theme.ts`: change `const { theme: configuredTheme } = useTheme();` to `const { mode: configuredMode } = useTheme();` and rename every `configuredTheme` to `configuredMode`; the final line becomes `setResolvedTheme(configuredMode);` (no cast needed because `configuredMode` is narrowed to `'light' | 'dark'` after the `system` early return). Exported `ResolvedTheme` and the hook name stay.

`packages/ui/src/theme-toggle.tsx`: `const { mode, setMode } = useTheme(); const nextMode = mode === 'light' ? 'dark' : 'light';` and `onClick={() => setMode(nextMode)}`; tooltip text `Switch to ${nextMode} mode`.

`packages/app-shell/src/use-global-command-handlers.ts` lines 38 and 59-69: `const { mode, setMode } = useTheme();` and

```ts
  const toggleTheme = useCallback(() => {
    // Resolve `system` toward its effective value, then flip — so a single
    // invocation always produces a visible change. Flips MODE only; the
    // palette (`theme`) is untouched.
    const effective =
      mode === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : mode;
    setMode(effective === 'dark' ? 'light' : 'dark');
  }, [mode, setMode]);
```

`packages/app-shell/src/types.ts`: add `themePaletteStorageKey: string;` after `themeStorageKey`.
`packages/app-shell/src/app-config.tsx`: add `themePaletteStorageKey: 'app-theme-palette',` after `themeStorageKey: 'app-theme',`.
`packages/app-shell/src/app-layout.tsx`: the provider becomes

```tsx
    <ThemeProvider
      defaultMode="light"
      storageAdapter={storageAdapter}
      storageKey={config.themeStorageKey}
      themeStorageKey={config.themePaletteStorageKey}
    >
```

- [ ] **Step 5: Update the mode-only tests**

`packages/ui/src/__tests__/theme-css-variables.test.tsx`: replace every `defaultTheme="light"` / `defaultTheme="dark"` / `defaultTheme="system"` with `defaultMode=...`, and add to the first test: `expect(document.documentElement.dataset.theme).toBe('brainstrike');`.

`packages/ui/src/__tests__/use-resolved-theme.test.tsx`: every `useThemeMock.mockReturnValue({ theme: 'dark' ... })` becomes `{ mode: 'dark' }` (and `system` likewise).

`packages/ui/src/__tests__/theme-toggle.test.tsx`: the mocked `useTheme` return becomes `{ mode: 'light', setMode: mockSetMode }` (rename `mockSetTheme` to `mockSetMode` and the assertion `expect(mockSetMode).toHaveBeenCalledWith('dark')`).

- [ ] **Step 6: Run the ui and app-shell suites and type-check**

```bash
cd packages/ui && pnpm vitest run --project unit src/__tests__/theme-provider.test.tsx src/__tests__/theme-css-variables.test.tsx src/__tests__/use-resolved-theme.test.tsx src/__tests__/theme-toggle.test.tsx
cd ../.. && pnpm --filter @brainstrike/app-shell test && pnpm type-check
```

Expected: all green. Type-check is the migration inventory: any consumer still comparing `theme` to `'light'` fails to compile and must be switched to `mode`.

- [ ] **Step 7: Commit**

```bash
pnpm dlx ultracite fix
git add packages/ui/src/theme-provider.tsx packages/ui/src/hooks/use-resolved-theme.ts packages/ui/src/theme-toggle.tsx packages/ui/src/__tests__ packages/app-shell/src
git commit -m "feat(theming): split the theme provider into mode and palette with separate persistence

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: Settings UI — theme cards

**Files:**
- Modify: `packages/ui/src/theme-settings.tsx`
- Test: `packages/ui/src/__tests__/theme-settings.test.tsx` (rewrite)

- [ ] **Step 1: Rewrite the test (failing)**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../theme-provider';
import { ThemeSettings } from '../theme-settings';
import { THEMES } from '../themes';

vi.mock('../theme-provider', () => ({
  useTheme: vi.fn(),
}));

describe('ThemeSettings', () => {
  const setMode = vi.fn();
  const setTheme = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useTheme as ReturnType<typeof vi.fn>).mockReturnValue({ mode: 'light', setMode, setTheme, theme: 'brainstrike' });
  });

  it('renders the mode buttons and highlights the active one', () => {
    render(<ThemeSettings />);
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls setMode with the clicked mode', () => {
    render(<ThemeSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(setMode).toHaveBeenCalledWith('dark');
  });

  it('renders one theme card per registry entry inside a radiogroup', () => {
    render(<ThemeSettings />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    const cards = screen.getAllByRole('radio');
    expect(cards).toHaveLength(THEMES.length);
    for (const theme of THEMES) {
      expect(group).toContainElement(screen.getByRole('radio', { name: theme.label }));
    }
  });

  it('marks the active theme card checked and switches on click', () => {
    render(<ThemeSettings />);
    expect(screen.getByRole('radio', { name: 'Brainstrike' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Tide' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('radio', { name: 'Tide' }));
    expect(setTheme).toHaveBeenCalledWith('tide');
  });

  it('paints each card swatch from the registry', () => {
    render(<ThemeSettings />);
    const ember = THEMES.find((t) => t.id === 'ember');
    const swatch = screen.getByTestId('theme-swatch-ember-light-primary');
    expect(swatch).toHaveStyle({ backgroundColor: ember?.swatch.light.primary });
  });

  it('renders the mode icons', () => {
    render(<ThemeSettings />);
    expect(screen.getByTestId('light-theme-icon')).toBeInTheDocument();
    expect(screen.getByTestId('dark-theme-icon')).toBeInTheDocument();
    expect(screen.getByTestId('system-theme-icon')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/ui && pnpm vitest run --project unit src/__tests__/theme-settings.test.tsx
```

Expected: FAIL (no radiogroup; `aria-pressed` missing).

- [ ] **Step 3: Rewrite the component**

Replace `packages/ui/src/theme-settings.tsx`:

```tsx
// Sibling components below use relative paths, never this package's own
// `@brainstrike/ui` barrel — that would close a source cycle. See the fuller
// note in error-boundary.tsx (BST-890).

import { Monitor, Moon, Sun } from 'lucide-react';
import type { ComponentType } from 'react';
import { Button } from './button';
import { Label } from './label';
import { cn } from './lib/utils';
import { type ThemeMode, useTheme } from './theme-provider';
import { type ThemeDefinition, THEMES } from './themes';

const MODE_OPTIONS: ReadonlyArray<{
  icon: ComponentType<{ className?: string; 'data-testid'?: string }>;
  label: string;
  mode: ThemeMode;
  testId: string;
}> = [
  { icon: Sun, label: 'Light', mode: 'light', testId: 'light-theme-icon' },
  { icon: Moon, label: 'Dark', mode: 'dark', testId: 'dark-theme-icon' },
  { icon: Monitor, label: 'System', mode: 'system', testId: 'system-theme-icon' },
];

function Swatch({ color, testId }: { color: string; testId: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-4 rounded-sm border border-border"
      data-testid={testId}
      style={{ backgroundColor: color }}
    />
  );
}

function ThemeCard({ active, onSelect, theme }: { active: boolean; onSelect: () => void; theme: ThemeDefinition }) {
  return (
    <button
      aria-checked={active}
      aria-label={theme.label}
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors',
        active ? 'border-primary ring-2 ring-ring/50' : 'border-border hover:bg-accent'
      )}
      data-testid={`theme-card-${theme.id}`}
      onClick={onSelect}
      role="radio"
      type="button"
    >
      <span className="flex gap-1">
        <Swatch color={theme.swatch.light.background} testId={`theme-swatch-${theme.id}-light-background`} />
        <Swatch color={theme.swatch.light.primary} testId={`theme-swatch-${theme.id}-light-primary`} />
        <Swatch color={theme.swatch.dark.background} testId={`theme-swatch-${theme.id}-dark-background`} />
        <Swatch color={theme.swatch.dark.primary} testId={`theme-swatch-${theme.id}-dark-primary`} />
      </span>
      <span className="font-medium text-sm">{theme.label}</span>
    </button>
  );
}

export function ThemeSettings() {
  const { mode, setMode, setTheme, theme } = useTheme();

  return (
    <div className="grid gap-6">
      <div className="space-y-2">
        <Label>Mode</Label>
        <div className="grid grid-cols-3 gap-4">
          {MODE_OPTIONS.map(({ icon: Icon, label, mode: option, testId }) => (
            <Button
              aria-pressed={mode === option}
              className="w-full"
              key={option}
              onClick={() => setMode(option)}
              variant={mode === option ? 'default' : 'outline'}
            >
              <Icon className="mr-2 h-5 w-5" data-testid={testId} />
              {label}
            </Button>
          ))}
        </div>
        <p className="text-muted-foreground text-sm">
          Light, dark, or follow your device setting. Every theme below has both a light and a dark look.
        </p>
      </div>
      <div className="space-y-2">
        <Label id="theme-palette-label">Theme</Label>
        <div aria-labelledby="theme-palette-label" className="grid grid-cols-2 gap-3 sm:grid-cols-4" role="radiogroup">
          {THEMES.map((definition) => (
            <ThemeCard
              active={theme === definition.id}
              key={definition.id}
              onSelect={() => setTheme(definition.id)}
              theme={definition}
            />
          ))}
        </div>
        <p className="text-muted-foreground text-sm">Pick a colour palette. Fonts and icons stay the same.</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

```bash
cd packages/ui && pnpm vitest run --project unit src/__tests__/theme-settings.test.tsx
```

Expected: PASS (6 tests). If `toHaveStyle` fails on an `oklch()` value under jsdom, assert on the `style` attribute string instead: `expect(swatch.getAttribute('style')).toContain(ember?.swatch.light.primary ?? '')`.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix
git add packages/ui/src/theme-settings.tsx packages/ui/src/__tests__/theme-settings.test.tsx
git commit -m "feat(theming): theme cards in Settings > Appearance

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: High-contrast cascade and the static cascade guard

**Files:**
- Modify: `packages/ui/src/globals.css` (high-contrast block only), `scripts/__tests__/theme-css-contract.test.mjs`

Why: generated themes use `:root[data-theme="x"]` (0,2,0), which beats the high-contrast block's `:root` (0,1,0). The block must tie on specificity and win on order.

- [ ] **Step 1: Extend the script test (failing)**

Append to `scripts/__tests__/theme-css-contract.test.mjs`:

```js
test('globals.css imports the theme files first and the high-contrast override outranks every theme', () => {
  const globals = read('packages/ui/src/globals.css');
  assert.match(globals, /^@import "\.\/themes\/index\.css";/u, 'themes/index.css must be the first statement');
  const highContrast = globals.split('@media (prefers-contrast: more)')[1];
  assert.ok(highContrast, 'high-contrast block present');
  assert.match(highContrast, /:root\[data-theme\] \{/u, 'light high-contrast selector must be :root[data-theme]');
  assert.match(highContrast, /:root\[data-theme\]\.dark \{/u, 'dark high-contrast selector must be :root[data-theme].dark');
  assert.doesNotMatch(highContrast, /^\s*:root \{|^\s*\.dark \{/mu, 'bare :root/.dark would lose to themed selectors');
});
```

Run `pnpm test:scripts 2>&1 | grep -B1 -A3 "high-contrast"`. Expected: FAIL on the `:root[data-theme]` assertion.

- [ ] **Step 2: Rewrite the two selectors**

In `packages/ui/src/globals.css`, inside `@media (prefers-contrast: more) { ... }`, change `  :root {` to `  :root[data-theme] {` and `  .dark {` to `  :root[data-theme].dark {`. Add above the block:

```css
/*
 * Selector shape is load-bearing: generated themes declare their tokens under
 * :root[data-theme="<id>"] (specificity 0,2,0). A bare `:root` here would LOSE
 * to them. `:root[data-theme]` ties, and this block sits after the theme
 * imports, so accessibility wins for every palette. The provider always sets
 * data-theme (the default writes "brainstrike"), so the attribute is never absent.
 */
```

- [ ] **Step 3: Run the guard and the ui format tests**

```bash
pnpm test:scripts 2>&1 | grep -E "high-contrast|^# (pass|fail)"
cd packages/ui && pnpm vitest run --project unit src/__tests__/theme-token-format.test.ts src/__tests__/focus-ring-theme.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/globals.css scripts/__tests__/theme-css-contract.test.mjs
git commit -m "fix(theming): keep the high-contrast override above every palette

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 13: Factory reset coverage for both keys

**Files:**
- Create: `packages/app-state/src/__tests__/factory-reset-theme-keys.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../factory-reset';

const globalWindow = window as Window & typeof globalThis & { caches?: CacheStorage };

describe('factory reset clears the theme preference keys', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    originalCaches = globalWindow.caches;
    Object.defineProperty(globalWindow, 'caches', {
      configurable: true,
      value: { delete: async () => true, keys: async () => [] as string[] } as unknown as CacheStorage,
    });
    localStorage.setItem('app-theme', 'dark');
    localStorage.setItem('app-theme-palette', 'tide');
  });

  afterEach(() => {
    if (originalCaches) {
      Object.defineProperty(globalWindow, 'caches', { configurable: true, value: originalCaches });
    } else {
      Reflect.deleteProperty(globalWindow, 'caches');
    }
    localStorage.clear();
  });

  it('removes app-theme and app-theme-palette from localStorage', async () => {
    await clearPersistentUiState({ skipIndexedDb: true });
    expect(localStorage.getItem('app-theme')).toBeNull();
    expect(localStorage.getItem('app-theme-palette')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm --filter @brainstrike/app-state test -- factory-reset-theme-keys
```

Expected: PASS (the web reset already does a blanket `localStorage.clear()`; this pins it for these keys). Mutation check: temporarily comment out the `localStorage.clear()` call in `packages/app-state/src/factory-reset.ts`, re-run, expect FAIL, restore.

- [ ] **Step 3: Confirm the desktop path by reading, not guessing**

```bash
grep -n "storage.clear\|userData" apps/desktop/src/__tests__/main/desktop-factory-reset.test.ts | head -5
```

Expected: assertions that the desktop reset wipes the electron storage / userData wholesale. Cite the matching line numbers in the PR body; no desktop code change is needed.

- [ ] **Step 4: Commit**

```bash
git add packages/app-state/src/__tests__/factory-reset-theme-keys.test.ts
git commit -m "test(theming): pin factory reset coverage for the theme preference keys

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 14: Web e2e for palettes, persistence, and high contrast

**Files:**
- Modify: `apps/web/e2e/utils/app-state.ts`, `apps/web/e2e/utils/layout-helpers.ts`, `apps/web/e2e/theme-switching.test.ts`, `apps/web/e2e/theme-css-consistency.test.ts`

- [ ] **Step 1: Reset both keys between tests**

In `apps/web/e2e/utils/app-state.ts` add `'app-theme'` and `'app-theme-palette'` to `APP_STATE_KEYS`.

- [ ] **Step 2: Add a helper beside `activateAppearanceThemeButton`**

In `apps/web/e2e/utils/layout-helpers.ts`:

```ts
/**
 * Select a palette card inside the Appearance section. Cards are radios in
 * the "Theme" radiogroup; dispatchEvent for the same reason as the mode
 * buttons (a plain click can land on the focus ring while the route settles).
 */
export async function activateAppearanceThemeCard(
  page: Page,
  label: 'Brainstrike' | 'Ember' | 'Tide' | 'Orchid'
): Promise<void> {
  const expect = await getPlaywrightExpect();
  const appearanceSection = await waitForAppearanceSection(page);
  const card = appearanceSection.getByRole('radio', { exact: true, name: label });
  await expect(card).toBeVisible();
  await card.dispatchEvent('click');
}
```

- [ ] **Step 3: Update the existing label assertion and add palette tests**

In `apps/web/e2e/theme-switching.test.ts`, the first test's `await expect(page.getByText('Theme', { exact: true })).toBeVisible();` becomes `await expect(page.getByText('Mode', { exact: true })).toBeVisible();`. Add the import of `activateAppearanceThemeCard`, then append inside the describe:

```ts
  test('switches palette independently of mode and persists across reload', async ({ page }) => {
    const html = page.locator('html');
    await openSettingsPage(page);
    await waitForSettingsPage(page);
    await expect(html).toHaveAttribute('data-theme', 'brainstrike');

    const baselinePrimary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim()
    );

    await activateAppearanceThemeButton(page, 'Dark');
    await expect(html).toHaveClass(/dark/);
    await activateAppearanceThemeCard(page, 'Ember');
    await expect(html).toHaveAttribute('data-theme', 'ember');
    await expect(html).toHaveClass(/dark/);

    const emberPrimary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim()
    );
    expect(emberPrimary).not.toBe(baselinePrimary);
    expect(emberPrimary.startsWith('oklch(')).toBe(true);

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    await expect(html).toHaveAttribute('data-theme', 'ember');
    await expect(html).toHaveClass(/dark/);

    // Mode changes leave the palette alone.
    await openSettingsPage(page);
    await waitForSettingsPage(page);
    await activateAppearanceThemeButton(page, 'Light');
    await expect(html).not.toHaveClass(/dark/);
    await expect(html).toHaveAttribute('data-theme', 'ember');
  });

  test('every registered palette paints the body from its own tokens', async ({ page }) => {
    await openSettingsPage(page);
    await waitForSettingsPage(page);
    const seen = new Set<string>();
    for (const label of ['Brainstrike', 'Ember', 'Tide', 'Orchid'] as const) {
      await activateAppearanceThemeCard(page, label);
      await expect(page.locator('html')).toHaveAttribute('data-theme', label.toLowerCase());
      const primary = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim()
      );
      expect(seen.has(primary), `${label} must not reuse another palette's primary`).toBe(false);
      seen.add(primary);
    }
  });
```

- [ ] **Step 4: Add the high-contrast test to the CSS-consistency suite**

Append inside the describe in `apps/web/e2e/theme-css-consistency.test.ts` (import `activateAppearanceThemeCard`):

```ts
  test('prefers-contrast: more overrides a non-default palette', async ({ page }) => {
    await openAppearanceSettings(page);
    await activateAppearanceThemeCard(page, 'Orchid');
    await clickSettingsThemeButton(page, 'Light');
    await waitForThemeApplied(page, 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'orchid');

    await page.emulateMedia({ contrast: 'more' });
    const background = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bs-background').trim()
    );
    expect(background).toBe('hsl(0 0% 100%)');

    await page.emulateMedia({ contrast: 'no-preference' });
    const restored = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bs-background').trim()
    );
    expect(restored).toBe('oklch(1 0 0)');
  });
```

- [ ] **Step 5: Build and run the two suites**

```bash
pnpm --filter @brainstrike/ui build && pnpm --filter @brainstrike/web build
pnpm --filter @brainstrike/web test:e2e -- theme-css-consistency theme-switching
```

Expected: all pass, including the three new tests.

- [ ] **Step 6: Commit**

```bash
pnpm dlx ultracite fix
git add apps/web/e2e
git commit -m "test(theming): e2e coverage for palette switching, persistence and high contrast

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 15: Living docs, spec note, screenshots, PR 2

**Files:**
- Modify: `docs/agents/ui-conventions.md`, `AGENTS.md`, `docs/superpowers/specs/2026-09-10-multi-theme-shadcn-presets-design.md`

- [ ] **Step 1: Add the Theming section to `docs/agents/ui-conventions.md`**

Insert before `## TERMINAL SURFACES`:

```md
## THEMING TOKENS AND PALETTES

- `--bs-*` in `packages/ui/src/themes/*.css` is the single source of truth and
  holds COMPLETE colour values (`hsl(...)`, `oklch(...)`). The shadcn-named
  bridge (`--background: var(--bs-background)`) lives once in
  `packages/ui/src/globals.css`; `packages/ui/src/theme.css` is the only
  Tailwind mapping (`@theme inline`), imported once per app. Apps own no
  `@theme` / `@custom-variant` (`scripts/__tests__/theme-css-contract.test.mjs`).
- Consume tokens as `var(--x)`; alpha as `color-mix(in oklab, var(--x) N%, transparent)`.
  The legacy `hsl(var(--x))` idiom is guarded out; `hsl(oklch(...))` is invalid.
- Palette (`data-theme` on `<html>`) and mode (`light`/`dark` class) are
  orthogonal. `ThemeProvider` exposes `{ mode, setMode, theme, setTheme }`;
  keys `app-theme` (mode) and `app-theme-palette` (theme). Unknown persisted
  values reset to defaults WITH a logged warning, never silently.
- Generated themes (`ember`, `tide`, `orchid`) come from
  `scripts/import-shadcn-theme.mjs <preset-code> <id>`; values are never
  hand-edited (`import-shadcn-theme.test.mjs` proves regenerate is a no-op).
  Selectors are `:root[data-theme="<id>"]` / `...dark` (0,2,0 / 0,3,0) so import
  order is irrelevant; the high-contrast block uses `:root[data-theme]` and
  sits after the imports so accessibility wins. Do not "fix" import placement.
- Token ownership: preset-provided colours, radius, chart and sidebar sets, plus
  derived `panel-divider`/`panel-surface` and a `destructive-foreground`
  fallback come from the theme file; `success`/`warning`/`info` and the
  `--bs-font-*` hooks are baseline-only and inherit. A future font theme
  overrides the font hooks; loading font files per theme is a separate design.
- Focus rings stay neutral in every theme (`focus-ring-theme.test.ts`,
  `theme-registry.test.ts` chroma ≤ 0.04).
```

- [ ] **Step 2: Point the AGENTS.md table at it**

In the `AGENTS.md` row for `docs/agents/ui-conventions.md`, extend the "Touching…" cell with `, theming tokens / palettes / `data-theme``.

- [ ] **Step 3: Record the derivation the spec missed**

In the spec's token table, change the `preset-provided` row's tokens text from `destructive (+foregrounds)` to `destructive (foreground derived: presets omit it, generator emits oklch(0.985 0 0))`.

- [ ] **Step 4: Screenshots of every theme in both modes**

Start `web-dev` (Task 2 launch config), and for each of the four cards and each mode capture `theme-<id>-<mode>.png` to the scratchpad. Attach them to the PR body.

- [ ] **Step 5: Full gates**

```bash
pnpm --filter @brainstrike/ui test && pnpm --filter @brainstrike/ui test:browser
pnpm --filter @brainstrike/app-shell test && pnpm --filter @brainstrike/settings-ui test && pnpm --filter @brainstrike/app-state test
pnpm test:scripts
pnpm type-check
pnpm run react-doctor
pnpm dlx ultracite check
```

Expected: clean.

- [ ] **Step 6: Ticket and stacked PR**

File a Linear ticket ("Theming: selectable palettes from shadcn presets"), then:

```bash
git push -u origin theming/multi-theme
gh pr create --base theming/token-format-refactor --title "feat(theming): selectable palettes generated from shadcn presets (BST-YYYY)" --body-file <scratchpad>/pr2-body.md
```

The body: stack order (this PR lands after PR 1; retarget to `main` before merging PR 1 per the stacked-PR playbook), the four themes and their preset codes, the generator usage, screenshots, and the desktop factory-reset citation from Task 13. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Follow-ups (separate branches, never ride along)

- Delete the dead Tailwind v3 preset `packages/config/tailwind/` with `apps/*/tailwind.config.js` and its test, then drop the guard exclusions in `scripts/__tests__/theme-css-contract.test.mjs`.
- Font axis: a theme overriding `--bs-font-sans`/`--bs-font-heading` plus per-theme font loading; acceptance is a screenshot sweep of the 51 `whitespace-nowrap` and 107 fixed-width sites.
