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

