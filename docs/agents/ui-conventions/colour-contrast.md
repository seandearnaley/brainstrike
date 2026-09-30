# Colour-token and foreground contrast evidence

Supports `ui-conventions.md` § "Colour tokens and contrast".

## 2026-09-29: status-token and regression-guard contract

BST-1618 follows BST-1617's warning/error repairs and accompanies BST-1619's
informational/status migration and BST-1612's semantic mapping guard. The
required Static job already runs `pnpm test:scripts`; no new lane is needed.

The policy distinguishes foregrounds from surface decoration. The BST-1618
comment measured the old warning token on a 15% tint of itself at 4.21:1 versus
4.63:1 on the original pale amber tint. A blanket ban on palette backgrounds
would have made the repair worse. The new semantic-status test measures four
effective modes (light, dark, high-contrast light/dark), eight plain surfaces,
5%/10% same-token fills, and each status's filled-background foreground.
Those checks do not authorize arbitrary higher-opacity fills.

## Arithmetic and corrected assumptions

`color-contrast.mjs` computes WCAG 2.x relative luminance after sRGB alpha
compositing. OKLCH comes from the **installed** `tailwindcss/theme.css`; HSL
surface values come from the shared stylesheet's effective cascade. The test
compares the unrounded ratio, never a displayed rounded number. The documented
gamut policy clips out-of-range sRGB channels rather than pretending to perform
browser-specific perceptual gamut mapping.

The ticket's "lightest plausible surface (strictest)" is reversed for dark
foregrounds on light backgrounds: the darker light surface generally yields
the lowest contrast. The guard takes the minimum across all 16 light/contrast
surface combinations instead of depending on either heuristic.

Nor is "every -600 fails, every -700 passes" valid across families or modes.
For installed Tailwind 4.3.3 and the stylesheet measured for this change:

| Foreground | Light background | Light muted | High-contrast light accent |
| --- | ---: | ---: | ---: |
| amber-700 | 4.946 | 4.433 | 3.569 |
| gray-600 | 7.404 | 6.636 | 5.343 |
| blue-600 | 5.147 | 4.613 | 3.715 |
| purple-500 | 4.030 | 3.612 | 2.908 |

These are historical measurements, not hard-coded thresholds or a shade table
to copy into new UI. The live checks recompute on palette/theme changes.

## Coverage and precise exclusions

`source-foreground-contract.test.mjs` discovers production JS/TS/JSX/TSX beneath
every app/package `src` directory. It ignores tests, declarations, stories,
test fixture directories and `dist`/`node_modules` directories. Its minimum file count
and representative app/shared paths prevent vacuous success. One explicit
non-UI exclusion is `file-system/src/fixtures/dev-inline-fixture.ts`: its
`@mock/ui/Badge.tsx` is example text displayed in the editor, never mounted UI.
The excluded file must still exist; the entire `src/fixtures` namespace is not
exempted.

The TypeScript parser reads complete class tokens from string literals and
static template segments, ignoring comments and JSX prose. It handles state,
responsive and arbitrary selector variants, important modifiers and numeric
foreground alpha (including bracket notation). Dark-only palette text is not
tested against a light surface, but raw amber/yellow foregrounds in **either**
mode violate the semantic-warning policy.
An unresolved alpha modifier on a numbered light foreground fails with a
diagnostic instead of silently bypassing measurement; its rendered composition
must be checked when moving it to a semantic foreground.

The installed palette's complete numbered-colour inventory is checked, including
Tailwind 4.3.3's mauve/olive/mist/taupe families and powerless `none` hues. New
families or an unsupported colour representation fail a completeness assertion
rather than silently shrinking coverage. Tokens touching template interpolation
are runtime-composed; only whitespace-bounded static segments are audited.

Seven exact foreground occurrences paint on explicit dark surfaces: six
desktop-bootstrap diagnostic labels on fixed `#111827` panels before theme
providers mount, and command-session output on `bg-black/95`. The latter is
tested over white, the brightest possible sRGB underlying surface. These
exceptions substitute their real backdrop and **still require 4.5:1**. Each
entry pins path, literal, utility, occurrence count and live backdrop anchors.

Two further exceptions are redundant ornamentation: the prompt builder's
`Braces` beside spelled-out variable badges and `WandSparkles` beside the
"Contextual recall" heading. Each pins the exact utility/literal, path, count,
component and AST-verified `aria-hidden="true"`. They carry no exclusive signal.
Favorite stars remain meaningful state indicators and receive semantic colours.
New low-contrast text, duplicated exceptions, missing evidence, changed
backdrops, changed icon roles, or stale entries fail negative-control tests.

## Deliberate static limits

This is a regression guard, not a blanket WCAG certification. It cannot infer
runtime-composed class names, dynamic arbitrary colours/alpha, ancestor opacity,
the runtime DOM, a gradient/image backdrop or every ancestor tint. It does not
audit unnumbered colours such as `text-white`, arbitrary CSS declarations,
fill/stroke utilities, wide-gamut browser
painting, or all semantic foreground uses at reduced opacity. Semantic token
definitions and known same-token fills are measured separately; consumers with
different compositions still need rendered checks in both themes/contrast
modes. Defaulting unknown text/icon roles to 4.5:1 is intentionally conservative;
`aria-hidden` alone never creates an automatic exemption.

## 2026-09-30: measured-surface association and guard review

BST-1618's review found that a live backdrop literal elsewhere in a file did
not prove the foreground painted on that backdrop. The guard now additionally
requires a literal `className` on the foreground's current JSX element and a
matching anchor on the nearest statically visible background-bearing element,
including that current element. Direct intrinsic-element ancestors and JSX
fragments are supported. Moving a real bootstrap label outside its panel fails
even when every foreground and anchor literal/count is unchanged; the real
bootstrap panels and same-element terminal background remain positive controls.

The association gate stops at any intervening `bg-*` utility or arbitrary
`background`, `background-color` or `background-image` property, including
variant/important forms. Even a transparent fill or tint needs its own qualified
measurement. Inline styles, spread props, dynamic class names and custom
component boundaries fail closed on the path to the anchor. Expressions,
callbacks, portals and reusable class constants cannot establish ancestry.
This is bounded JSX evidence, not a CSS engine: custom stylesheet selectors,
ancestor opacity and runtime DOM/paint remain rendered-check responsibilities.
The exact exception literals, counts, measured ratios and decorative-role
requirements are unchanged, including rejection of `aria-hidden={false}`.

Production discovery excludes conventional `__tests__`, `__fixtures__` and
`__mocks__` directories and test/spec/story filenames, but does not infer that
bare `src/test` or `src/tests` directories contain only tests. Negative controls
put low-contrast production TSX in both directories and require discovery and
audit failures. The explicit non-UI fixture exclusion remains exact.

The separate filled-variant guard intentionally rejects important modifiers on
background utilities, with an explicit unsupported-paint diagnostic. Leading
and trailing `!`, variant and alpha forms are tested through both destructive
fill helpers before theme filtering. Other-family background overrides still
fail qualification. This narrower guard does not change the palette-foreground
parser's support for important foreground modifiers.

The filled-variant background detector also recognizes arbitrary-property
`[background:...]`, `[background-color:...]` and `[background-image:...]`
overrides. Plain, state, arbitrary-variant and leading/trailing important forms
fail closed through the Button/Badge fill model and Toast's opaque-fill check;
none may silently preserve the old measured destructive background. These
properties require explicit paint qualification, not inferred CSS evaluation.
