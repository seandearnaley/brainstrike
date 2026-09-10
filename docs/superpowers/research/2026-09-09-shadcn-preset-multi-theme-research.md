# Research: multi-theme support via shadcn presets (2026-09-09)

Status: research only, no design decision taken. Companion spec will live in
`docs/superpowers/specs/`.

Presets supplied: `buKEvLs`, `bNRM0gzE1`, `b4aRK71bRz` (from https://ui.shadcn.com/create).

## 1. What a shadcn preset actually is (verified with shadcn CLI 4.21.0)

A preset code is a base62-encoded `PresetConfig` (type exported from `shadcn/preset`):
`style, baseColor, theme, chartColor, iconLibrary, font, fontHeading, radius, menuAccent, menuColor`.

| code | style | baseColor | theme (accent) | chart | icons | font / heading | radius | menu |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| buKEvLs | lyra | neutral | red | neutral | lucide | inter / inherit | large (0.875rem) | default / subtle |
| bNRM0gzE1 | luma | mist | cyan | lime | remixicon | noto-sans / inter | small (0.45rem) | inverted / bold |
| b4aRK71bRz | maia | mauve | pink | red | hugeicons | ibm-plex-sans / merriweather | default (0.625rem) | inverted-translucent / subtle |

Decoded via `npx shadcn@latest preset decode <code>`; scaffolds produced with
`npx shadcn@latest create -t vite --preset <code>` (kept in the session scratchpad).

Key facts:

- **A preset is more than a theme.** `style` (lyra/luma/maia/nova/vega/mira/sera/rhea)
  rewrites component *source* (verified: `button.tsx` differs per style in radius,
  height, text size, ring width). `iconLibrary` and fonts are project-level.
  `components.json` holds exactly one `style`. None of this is runtime-switchable.
- **The runtime-switchable part is the CSS only:** `:root` / `.dark` token blocks
  (oklch values), `--radius`, and `--font-sans` / `--font-heading`.
- `npx shadcn@latest apply <code> --only theme` on an existing project rewrites
  ONLY the `:root` / `.dark` values in the configured CSS file and
  `tailwind.baseColor` in `components.json`; component files untouched (verified by
  diff). `--only` accepts `theme` and `font`. It requires a `components.json`.
- There is **no vendor concept of multiple installed themes**. `apply` overwrites the
  single theme. The vendor's documented multi-mode story is still just CSS variables
  plus the class-based `dark` variant; multi-palette switching is left to the app.
- All three presets are `base-*` (Base UI) because that is the create page default.
  Radix is still a first-class base (`--base radix`). The theme CSS is base-agnostic.
- Registry endpoints for theme colours as JSON (`/r/colors/<name>.json`,
  `/r/themes/<name>.json`) return 404; the only reliable machine path from preset code
  to CSS is the CLI (`create` or `apply --only theme`).
- Current vendor CSS idiom: raw oklch values in `--background` etc.,
  `@theme inline { --color-background: var(--background); … }` (no `hsl()` wrapper),
  radius scale as multipliers of `--radius`, `@import "shadcn/tailwind.css"`
  (data-* variants, scroll-fade, shimmer utilities), `tw-animate-css`, the `cn`
  package, `@custom-variant dark (&:is(.dark *))`.

## 2. Brainstrike today

- **Not CLI-managed.** No `components.json` anywhere. `shadcn info -c apps/web`
  reports a Vite project with `preset: null`, `components: []`. `packages/ui` holds
  39 hand-maintained Radix + cva components with hard-won rulings
  (kinetic-depress popup anchors, focus tokens, z-index layers).
- **Token format is legacy HSL triplets** (`--bs-background: 30 25% 99%`) consumed as
  `hsl(var(--x))`. Count of raw `hsl(var(--` sites: 172 across 8 packages
  (65 in `packages/assistant-ui/src/overrides.css`, 7 in `packages/ui/src/globals.css`,
  rest in tsx). The `@theme { --color-x: hsl(var(--x)) }` block is **duplicated
  verbatim in `apps/web/src/app/globals.css` and `apps/desktop/src/renderer/styles.css`**
  (~150 lines each, drift risk). oklch appears nowhere.
- **Two-layer variables:** `--bs-*` is the source of truth, then `--* = var(--bs-*)`.
  `assistant-ui/src/overrides.css` re-maps `--*` back to `--bs-*` in `:root`, `.dark`
  and `.bs-thread` because `@assistant-ui/styles` hardcodes its own `:root`/`.dark`.
  Consequence: any new theme must set `--bs-*`, and this layer is the natural seam.
- **Tokens beyond the shadcn set:** `success/warning/info` (+foreground),
  `panel-divider`, `panel-surface` (gradient), high-contrast `@media (prefers-contrast)`
  override, full sidebar set. Presets do not carry these; each imported theme needs
  derived values.
- **Mode mechanics:** `light`/`dark` class on `<html>`, `@custom-variant dark`,
  171 `dark:` utility uses, shiki dual-theme keyed on `html.dark`, xterm palette
  hardcoded (canvas cannot read CSS vars). `ThemeProvider` (`packages/ui/src/theme-provider.tsx`)
  `Theme = 'dark'|'light'|'system'`, persisted through the `StorageAdapter` under
  `config.themeStorageKey = 'app-theme'`, mounted in `packages/app-shell/src/app-layout.tsx`
  with `defaultTheme="light"`. Consumers: `useResolvedTheme` (model picker, collection
  picker, canvas), `theme.toggle` global command, `ThemeSettings` (Light/Dark/System
  buttons) in Settings > Appearance.
- **Tests pinning behaviour:** `apps/web/e2e/theme-css-consistency.test.ts` asserts
  `--bs-background`, `--background`, `--color-background` resolve;
  `apps/web/e2e/theme-switching.test.ts` asserts `.dark` class and Settings buttons;
  `packages/ui/src/__tests__/theme-*.test.tsx`, `focus-ring-theme.test.ts`.
- **Fonts/icons:** Geist + Geist Mono via `@fontsource-variable` in both apps; lucide
  everywhere. Presets' fonts/icons would be new dependencies and are not part of
  `apply --only theme`.
- **Factory reset:** `app-theme` lives in the StorageAdapter; adding a second key or
  changing the value shape must be wired into the reset path
  (`docs/agents/platform-contracts.md` FACTORY RESET CONTRACT).

## 3. Implications

1. Preset CSS cannot be dropped in verbatim: `hsl(oklch(...))` is invalid. Either
   convert oklch to HSL triplets on import (lossy, non-canonical) or migrate the token
   format to full colour values first. The existing palette migrates losslessly by
   wrapping each triplet in `hsl()` (`--bs-background: hsl(30 25% 99%)`), so the
   current theme has zero visual drift.
2. The vendor's "add a theme later" path is the CLI, so the repeatable pipeline is:
   preset code → `shadcn apply --only theme` in a throwaway scaffold → extract
   `:root`/`.dark` → emit a Brainstrike theme block. That script is the durable asset.
3. Palette and mode are orthogonal: `data-theme="<id>"` on `<html>` alongside the
   existing `light`/`dark` class keeps all 171 `dark:` uses, shiki, and e2e assertions
   intact.
4. Adopting the presets' `style`, fonts, or icon libraries is a separate, non-switchable,
   project-wide decision and is out of scope for "more themes".
