# Approval surface geometry — evidence

Supports `docs/agents/ui-conventions.md` § "Approval surfaces".
Read before changing approval nesting, delegation colour rails, or the embedded-card presentation.

Extracted verbatim from the pre-distillation contract.

---

### Approval surfaces

Approval cards and rows (`approval-card.tsx`, `approval-row.tsx`) follow the
step-row grammar for the collapsed form — rail(s) · persona · requested action
· target chip · status chip · chevron — with geometry owned by
`overrides.css` (`.bs-approval*`), never utilities. Delegation identity is a
colour rail from the eight `--bs-delegation-N` tokens (light on `:root`, dark
under `.dark`, `packages/ui/src/globals.css`), picked by a stable FNV-1a hash
of the delegation call id (`delegation-colour.ts`) so a reloaded thread keeps
its colours. Colour is never the only signal: the persona chain text and the
status chip text always accompany a rail, and a root pause has no rail at
all. Nesting is `--bs-approval-depth` (1.25rem per level) plus one rail per
ancestor edge; it never re-parents DOM. The outermost surface owns the
nesting: the card an expanded row embeds (`presentation="embedded"`) carries
no `.bs-approval` class, depth, delegation colour or rails. The depth custom
property inherits, so an embedded card that kept the class would indent a
second time (`approval-row.browser.test.tsx`). The row's toggle is named by its
visible content with the affordance trailing ("Explorer listed apps/desktop,
show approval details"), the same Label-in-Name rule as step rows.


## 2026-09-23 agent-color approval treatment

The earlier hash rails let a single approval show green or pink delegation
stripes beside an amber card even when its owner had another durable agent
color. The owner lookup now supplies `colorId` to the standalone approval
surface. The shared 18-color conversation palette paints its fill and border
in light and dark themes. Nesting still uses the existing depth indent, and
persona/status text still identifies the owner and decision. An expanded row
owns the color and depth; its embedded card inherits both and adds no separate
identity. `approval-row.browser.test.tsx` guards the computed colors, depth,
and embedded-card geometry.

## 2026-09-23 continuous family colors

The durable owner color can now be a validated `family:<hue>:<tone>` token as
well as one of the named semantic colors. `agent-color-style.ts` derives
light and dark accent variables only after `isAgentColor` accepts the token;
malformed values throw before they can become CSS. The existing named color
selectors preserve their earlier appearance. Approval cards and rows read the
family variables through `--agent-accent`, switching under `.dark`. An
`unresolved` owner remains neutral while authorization is pending, and an
embedded card inherits its row's identity. `approval-row.browser.test.tsx`
checks both themes, the neutral state, and embedded geometry.

### Rendered verification (2026-09-24)

CDT attached to the actual Electron debug renderer with its compiled stylesheet.
A temporary offscreen approval probe for `family:1820:204` computed a background
of `oklab(0.940503 -0.0155805 0.00036391)` in light mode and
`oklab(0.276189 -0.0168027 0.00304041)` in dark mode. All five sibling probes
had distinct fills in both themes and a uniform `1px` left border. These probes
verify CSS resolution; the four real-component browser cases verify rendering
and embedded geometry. The desktop reload E2E also verifies that a saved family
accent's computed icon-tile background survives renderer reload.
