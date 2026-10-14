# Step row grammar and geometry — evidence

Supports `docs/agents/ui-conventions.md` § "Step rows".
Read before changing `StepRowHeader`, its accessible-name composition, or the stylesheet-owned `.bs-step-*` geometry.

Extracted verbatim from the pre-distillation contract.

---

### Step rows

L1 step rows (`docs/agents/assistant-runtime.md` § ACTIVITY GROUPS, "L1 step
rows / L2 bodies") are the shared `StepRowHeader` grammar
(`activity-step-row.tsx`) every card inside an activity trace renders through
— `ToolFallback`, `SubagentExecutionCard`, `TaskListToolCard`, and the
reasoning block: family icon · verb in tense (the active form while the step
is `running` OR `waiting` — a gated call has not run yet) · target chip (the
tool id when the args name no primary arg) · timing (rendered only when the
caller supplies one) · state glyph · chevron, one row per step in part order.
A row with a body is a real `<button>`; a row with none is a non-interactive
`role="group"` — never a disabled button standing in for "nothing to expand".
That includes a `TaskListToolCard` with neither raw args nor a raw result: the
`bodyId`/`expanded`/`onToggle` trio travels together, exactly as in
`ToolFallback`.

Either form is named by what it SHOWS (BST-1682, WCAG 2.5.3 Label in Name).
The `role="group"` form is `aria-labelledby` its content span; the button form
composes `aria-label` as visible content first, affordance last —
`Read src/app.ts, expand details` — and drops `aria-describedby`, since
content already in the name must not be described a second time. `label` is
the affordance clause, not the whole name, and `nameFromContent` (default
`true`) is the opt-out for a row whose `label` already names the step: only
the reasoning row takes it, keeping `Show thinking` / `Hide thinking` exactly.
The raw tool id is never pulled into a name from the sr-only span — it reaches
a name only where the caller already put it in the visible `target` chip. Any
test or e2e spec asserting the affordance must match it as a substring
(`{ name: /expand details/i }`), never as the full name.

Geometry is stylesheet-owned, not utility classes, because the browser
vitest lane loads no Tailwind preflight (`overrides.css`): `.bs-step-row`
itself owns `box-sizing: border-box`, `width: 100%` and `flex: 1 1 0%`; a
sibling control sharing `.bs-step-row-line` with it (the checkpoint revert
button) gets `flex: 0 0 auto` from `.bs-step-row-line > :not(.bs-step-row)`;
`.bs-step-row-chevron` pins the chevron's own box; `.bs-step-row-meta` clamps
to `9rem` so an unbounded result-summary or root-name chip cannot push the
row wide. `.bs-step-row-timing` is the one slot that SHRINKS
(`flex: 0 1 auto`) under a `max-inline-size: 60%` ceiling, with
`overflow: hidden` + `white-space: nowrap`: the running progress label is
unbounded at the call site, and those are two separate guards — shrinking
bounds the slot only while something else competes for the row, the ceiling
is what keeps a short target legible when nothing does.
`.bs-step-list` is a BLOCK container by design — the row's own
width rule is written for a non-flex parent — so inter-row rhythm comes from
`.bs-step-list > * + *` block margins rather than a flex `gap` (adjoining
block margins collapse, which is why the value is `0.75rem` and not the
arithmetic top-up of the layout it replaced). The one exception is
`.bs-run-timeline`: at Developer detail level, run-event rows render as
direct children of `.bs-step-list` too (they are group-transparent), so they
CONSUME `:nth-child` slots and shift the `--bs-stagger` of every step row
after them one step along — but they carry no `.bs-trace-reveal` and do not
animate. The step rows themselves are never the list's direct children
either: `--bs-stagger` lands on `ActivityPartLayout`'s wrapper (two more
levels down for `ToolFallback`) and reaches the row by INHERITANCE. Run-event
rows keep their own tighter `0.25rem` margin
(`.bs-step-list > * + .bs-run-timeline`) rather than the step rows' rhythm,
since they are designed to read as one quiet block. `sr-only` is a Tailwind
utility with no matching rule in that same lane (it loads only
`@brainstrike/ui/globals.css` and `overrides.css`), so the row's hidden
tool-id span does NOT hide there — a browser test asserting on the row must
account for that visible text, or omit `toolName`
(`activity-step-row.browser.test.tsx`).

State glyphs follow one naming rule: `role="img"` plus `aria-label` from the
total `STEP_STATE_LABELS` map (`activity-step-tokens.ts`) — colour alone
never carries the state.

