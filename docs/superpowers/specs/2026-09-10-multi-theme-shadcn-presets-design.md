# Multi-theme support from shadcn presets — design

Date: 2026-09-10. Status: approved design, awaiting implementation plan.
Research: `docs/superpowers/research/2026-09-09-shadcn-preset-multi-theme-research.md`.

## Goal

Brainstrike offers one colour palette with light/dark/system modes. Add three more
palettes, each with its own light and dark mode, sourced from shadcn `create` presets,
and make adding a fourth a one-command job. Align the CSS token layer with the current
shadcn idiom while doing it, and remove the duplicated Tailwind mapping in the two apps.

Themes: `brainstrike` (existing palette, default), `ember` (preset `buKEvLs`,
lyra / neutral / red), `tide` (preset `bNRM0gzE1`, luma / mist / cyan),
`orchid` (preset `b4aRK71bRz`, maia / mauve / pink).

## Non-goals (settled)

- No `components.json`, no CLI-managed components, no Base UI. The 39 Radix components
  in `packages/ui` stay hand-maintained.
- No preset `style`, icon library, or font adoption. Geist and lucide stay. The theme
  layer exposes font tokens so a font axis can be added later without re-architecting;
  loading extra font files is explicitly out of scope now (measured width drift of
  −1% to +6% per font is recorded in the research doc).
- No `shadcn/tailwind.css`, `tw-animate-css`, or the `cn` package: nothing consumes them.
- The radius scale keeps Brainstrike's `calc(var(--radius) - 2px)` steps, not the
  vendor multipliers; changing that re-rounds every component and is a separate call.

## Architecture

Palette and mode are orthogonal axes on `<html>`:

- Mode: the existing `light` / `dark` class. Untouched. All `dark:` utilities, shiki's
  `html.dark` rules, the xterm palette, and the mode e2e suites keep working.
- Palette: `data-theme="<ThemeId>"`, always present (the default writes
  `data-theme="brainstrike"`).

### Token contract

`--bs-*` remains the single source of truth and now holds complete colour values.
The existing palette converts by wrapping each triplet, e.g.
`--bs-background: hsl(30 25% 99%)`, so the default theme is numerically unchanged.
Generated themes hold oklch values verbatim from the preset.

The shadcn-named bridge (`--background: var(--bs-background)` …) is declared once on
`:root` in `packages/ui/src/globals.css`; the identical `.dark` copy is removed.

Token groups and who owns them:

| group | tokens | owner |
| --- | --- | --- |
| preset-provided | background, foreground, card, popover, primary, secondary, muted, accent, destructive (foreground derived: presets omit it, generator emits oklch(0.985 0 0)), border, input, ring, chart-1..5, sidebar set, radius | every theme file |
| derived | panel-divider, panel-surface | every theme file, via relative colour syntax (see generator) |
| semantic status | success, warning, info (+foregrounds) | `brainstrike.css` baseline only; themes inherit through the cascade |
| font hooks | font-sans, font-heading, font-mono | `brainstrike.css` baseline only, set to Geist; a future font theme overrides |

### Files

```
packages/ui/src/
  theme.css              # shared Tailwind mapping, exported as @brainstrike/ui/theme.css
  globals.css            # bridge, high-contrast, reduced-motion, base rules (imports themes/index.css first)
  themes/
    index.css            # @import of every theme file
    brainstrike.css      # baseline, hand-maintained: :root { --bs-* } and .dark { --bs-* }
    ember.css            # generated
    tide.css             # generated
    orchid.css           # generated
    index.ts             # ThemeId union + THEMES registry
scripts/
  import-shadcn-theme.mjs        # preset code -> themes/<id>.css
  shadcn-theme-fixture/          # minimal components.json + index.css the generator applies presets to
```

`theme.css` contains `@custom-variant dark (&:is(.dark *))`, the typography scale that
both apps currently duplicate, and the vendor-idiom mapping:

```css
@theme inline {
  --color-background: var(--background);
  /* … every token, no hsl() wrapper … */
  --font-sans: var(--bs-font-sans);
  --font-heading: var(--bs-font-heading);
  --font-mono: var(--bs-font-mono);
  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);
}
```

`inline` is required: utilities then emit `var(--background)` at the use site, so a
`data-theme` override resolves where it is applied instead of being frozen at `:root`.

Both apps replace their duplicated `@theme` and `@custom-variant` blocks with
`@import "@brainstrike/ui/theme.css"`. `packages/ui`'s build copies `themes/` into
`dist/` alongside `globals.css` (the copy-files step gains the directory).

### Cascade rules

Generated theme files use `:root[data-theme="ember"]` and
`:root[data-theme="ember"].dark`. Specificity (0,2,0) and (0,3,0) beat the baseline
`:root` / `.dark` regardless of import order, which matters because `@import` must sit
at the top of `globals.css` and therefore precedes the baseline in source order.

The high-contrast block rewrites its selectors to `:root[data-theme]` and
`:root[data-theme].dark` and stays after the imports, so it ties on specificity and
wins on order for every theme. Both rules are pinned: a static test parses the built
CSS and asserts selector shapes and order, and an e2e case emulates
`prefers-contrast: more` on a non-default theme and asserts the high-contrast
`--bs-background` wins.

Everything stays unlayered, as today: unlayered declarations beat Tailwind's layers.

### Generator

`node scripts/import-shadcn-theme.mjs <preset-code> <theme-id>`:

1. Decodes the code with `shadcn/preset` to record style, base colour and accent in
   the file header, and refuses ids that are not a valid `ThemeId` slug.
2. Copies `scripts/shadcn-theme-fixture/` to a temp dir and runs
   `npx shadcn@latest apply <code> --only theme -y` there.
3. Extracts the `:root` and `.dark` blocks from the fixture's `index.css`, renames
   `--x` to `--bs-x`, and wraps them in the `:root[data-theme="<id>"]` selectors.
4. Appends the derived tokens using relative colour syntax so they track the theme
   without the script doing colour math:
   `--bs-panel-divider: oklch(from var(--bs-border) calc(l - 0.06) c h)` in light,
   `calc(l + 0.06)` in dark; `--bs-panel-surface: linear-gradient(to bottom,
   var(--bs-background), var(--bs-muted))` in both.
5. Writes `packages/ui/src/themes/<id>.css` and prints the registry entry to add.

The header records the preset code and decoded config; values are never hand-edited.
Re-running with the same id regenerates the file. The first implementation task
verifies that `apply` succeeds in the fixture without installed dependencies; if it
does not, the generator scaffolds with `shadcn create --preset` instead. One
mechanism ships, never both.

### Registry

```ts
export type ThemeId = 'brainstrike' | 'ember' | 'tide' | 'orchid';
export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly label: string;
  readonly presetCode: string | null;   // null for brainstrike
  readonly swatch: {
    light: { background: string; primary: string };
    dark: { background: string; primary: string };
  };
}
export const THEMES: readonly ThemeDefinition[];
export const DEFAULT_THEME: ThemeId = 'brainstrike';
export function isThemeId(value: unknown): value is ThemeId;
```

Swatch values are copied from the theme file by the generator output. A parity test
asserts every `ThemeId` has a file under `themes/`, every file has a registry entry,
`index.css` imports each one exactly once, and every non-baseline file declares the
full preset-provided plus derived token set in both selectors.

### Provider and persistence

`ThemeProvider` state becomes:

```ts
interface ThemeProviderState {
  mode: 'light' | 'dark' | 'system';
  setMode: (mode: Mode) => void;
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}
```

Reusing `theme` for the palette is deliberate: every current consumer compares it to
`'light'` / `'dark'` / `'system'`, which no longer type-checks against `ThemeId`, so
the compiler enumerates the migration. Consumers to update: `use-resolved-theme.ts`
(reads `mode`, external contract unchanged), `theme-settings.tsx`, `theme-toggle.tsx`,
`app-shell/use-global-command-handlers.ts`, and their tests.

Effects: mode keeps toggling the class; theme writes `document.documentElement.dataset.theme`.

Storage stays on the `StorageAdapter`. `app-theme` keeps holding the bare mode string
(no migration for existing users). A new key from `config.themePaletteStorageKey`
(`'app-theme-palette'`) holds the theme id. On load, a value that fails `isThemeId`
resets to `DEFAULT_THEME` and logs a warning through `@brainstrike/logging`; it is not
thrown, because a removed theme must not blank the app, and it is not silent.
Both keys are covered by factory reset: the plan verifies the existing wholesale
storage wipe reaches them on web and desktop and adds an assertion to the
factory-reset tests, per `docs/agents/platform-contracts.md`.

### Settings UI

`ThemeSettings` keeps the Light / Dark / System button row and adds a "Theme" row: one
card per `THEMES` entry in a `radiogroup`, showing the light and dark swatches and the
label, with the active card `aria-checked`. Selecting a card calls `setTheme`. The nav
`ThemeToggle` and the `theme.toggle` command flip mode only. No new commands.

### Legacy idiom removal

All 172 `hsl(var(--x))` sites become `var(--x)`; alpha forms
`hsl(var(--x) / a)` become `color-mix(in oklab, var(--x) <a*100>%, transparent)`.
Tailwind opacity modifiers (`bg-foreground/20`) need no change. A script test
(`scripts/__tests__/no-hsl-var-idiom.test.mjs`) asserts zero occurrences under
`apps/` and `packages/` source so the idiom cannot return.

## Testing

- Unit (`packages/ui`): provider applies `data-theme`, persists both keys, resets an
  unknown id with a logged warning; `ThemeSettings` renders one card per theme and
  reflects the active one; registry parity and theme-file completeness.
- Script tests: `no-hsl-var-idiom`, cascade selector/order check on built CSS,
  generator golden test against the checked-in `ember.css` (regenerate must be a no-op).
- E2E (`apps/web/e2e/theme-css-consistency.test.ts` and `theme-switching.test.ts`):
  selecting Ember changes computed `--bs-primary` and sets `data-theme`, survives
  reload, is independent of mode; high-contrast override wins on a non-default theme.
  Existing mode assertions stay untouched.
- Visual: PR 1 is a zero-change refactor, proven with before/after CDT screenshots on
  web and desktop in both modes. PR 2 ships screenshots of every theme in both modes.

## Delivery

Stacked, landed bottom-up, each independently green:

1. `refactor(theming)`: full-value tokens, `theme.css` extraction, app imports,
   `themes/brainstrike.css` carve-out, 172-site idiom rewrite, `no-hsl-var-idiom`
   guard. No behaviour change. The mechanical rewrite goes to Codex per the model
   matrix; review focuses on alpha conversions and the two app stylesheets.
2. `feat(theming)`: `data-theme`, provider/storage/config, registry, generator and
   fixture, the three generated themes, Settings UI, cascade rules for high contrast,
   unit/script/e2e coverage, and a Theming section in `docs/agents/ui-conventions.md`
   recording: token ownership table, the `:root[data-theme]` specificity rule, the
   "values are generated, never hand-edited" rule, and the font-axis hook.

## Landmines recorded during design

- Fonts: declared `@font-face` files stay unloaded until rendered; any metric test
  must `document.fonts.load()` first or it measures the fallback.
- `@import` placement forces theme files before the baseline in source order; the
  specificity rule above is what makes order irrelevant. Do not "fix" it by moving
  imports.
- `hsl(oklch(...))` is invalid; never paste preset CSS into the old idiom.
- `--color-*` must be `@theme inline`; plain `@theme` freezes resolution at `:root`.
