# Tool-Call & Run-Event UI Refresh — Design

- **Date:** 2026-06-05
- **Workstream:** #3 of 5 in the assistant-hardening decomposition (tool-call UI / observability)
- **Branch:** `harden/tool-call-ui-refresh`
- **Grounding:** Playwright e2e screenshots (per decision) + component/unit tests. No live-attach.
- **Scope:** Full cohesive refresh (per decision).
- **Status:** Approved approach + scope; pending spec review.

## Problem

The assistant conversation renders two kinds of activity cards, both with the same UX
problems the user reported:

1. **Per-tool card** — [tool-fallback.tsx](https://github.com/seandearnaley/brainstrike/blob/b0b960a2bd36cb7f86f2150cfc8572739032b72a/packages/ui/src/assistant-ui-panel/tool-fallback.tsx)
   ("Used <toolName>").
2. **Run-event card** — [assistant-run-timeline.tsx](https://github.com/seandearnaley/brainstrike/blob/b0b960a2bd36cb7f86f2150cfc8572739032b72a/packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx)
   ("working memory loaded", "Generation step started", "observational memory read", etc.).

Issues (verified in code):
- **Stuck spinner (real bug):** `resolveAssistantRunEventStatus` finds a running event's
  completion by name via `getMatchingCompletedKind`, which maps any `*.started` →
  `*.completed`. But generation-step events are emitted as `run.step.started` →
  **`run.step.finished`** (not `.completed`) — confirmed in
  [agent-runtime.ts:727,743](../../../packages/agent/src/mastra/agent-runtime.ts). So
  `run.step.started` searches for a non-existent `run.step.completed` and stays `running`
  forever → the spinner never flips, even in saved history.
- **Vertical bloat:** each event/tool is a full bordered card with a two-line body (label
  line + `kind · time · duration` line) and `px-4 py-3` padding.
- **Redundant status badge:** a text pill ("Running/Completed/Failed/Observed") sits right
  next to the status icon — duplicative.
- **No per-tool-type tinting:** every card is neutral (only failures tint red), so internal
  Brainstrike tools, external MCP tools, memory operations, and run lifecycle all look the
  same.
- Args/results: the per-tool card **already** has an args/results expander; run-event cards
  already show metadata in a fold. (Keep; verify.)

## Goals

- Generation-step (and any running) events resolve to a terminal state — no perpetual
  spinners in live or historical threads.
- Tighter vertical density: a single-line header (status icon + label + inline time);
  secondary detail (kind, duration, metadata, args/results) lives in the expandable fold.
- Status is conveyed by the icon (+ accessible tooltip), not a redundant text pill.
- Per-tool-type tinting distinguishes: **memory**, **internal** (Brainstrike), **mcp**
  (external), **lifecycle** (run/step). Failure tint (red) overrides.
- Changes are covered by deterministic component/unit tests, plus Playwright e2e screenshots
  for visual confirmation (attached for review, not used as flaky pixel assertions).
- Accessibility preserved: keyboard-operable expander, `aria-expanded`/`aria-controls`,
  status conveyed to screen readers (tooltip/`title` + visually-hidden label, not color
  alone).

## Non-Goals (deferred)

- True tree nesting of tool cards under a run (assistant-ui renders parts flatly;
  restructuring that is a larger change). We achieve grouping via a colored left rail +
  consistent indentation, not a real treegrid.
- The message hover toolbar (copy/retry) polish — that's workstream #5.
- Reasoning persistence / tool-effectiveness prompting — workstream #4.
- Web-vs-desktop differences: these components are shared `@brainstrike/ui`, so the refresh
  applies everywhere they render (desktop is where we screenshot).

## Design

### Unit 1 — stuck-spinner fix (`assistant-run-timeline.tsx`)

Fix `getMatchingCompletedKind` so `run.*` started events map to `*.finished` (the kind that
is actually emitted), while non-run started events keep mapping to `*.completed`:

```ts
function getMatchingCompletedKind(kind: AssistantRunEventKind): AssistantRunEventKind | null {
  if (kind === 'run.started') return 'run.finished';
  if (kind === 'tool.started') return 'tool.completed';
  if (kind.startsWith('run.') && kind.endsWith('.started')) {
    return kind.replace(/\.started$/, '.finished') as AssistantRunEventKind;
  }
  if (kind.endsWith('.started')) {
    return kind.replace(/\.started$/, '.completed') as AssistantRunEventKind;
  }
  return null;
}
```

This makes `run.step.started` resolve to `run.step.finished` (and is future-proof for other
`run.*.started` events). `tool.*`/`memory.*` keep `.completed`.

### Unit 2 — shared visual classification (new pure module)

`packages/ui/src/assistant-ui-panel/tool-visual-classification.ts`

```ts
export type ToolVisualCategory = 'memory' | 'internal' | 'mcp' | 'lifecycle';

/** Internal Brainstrike tools appear as `brainstrike.x` (contract/mock) or
 *  `brainstrike_x` (Mastra-sanitized). Match both. */
export function isInternalToolName(name: string): boolean;          // /^brainstrike[._]/i

/** Classify a per-tool card by its tool name. */
export function classifyToolName(name: string): 'internal' | 'mcp'; // internal if brainstrike*, else mcp

/** Classify a run-event card by kind + optional tool metadata. */
export function classifyRunEvent(kind: string, toolName?: string): ToolVisualCategory;
//   kind starts 'memory.' -> 'memory'
//   kind starts 'tool.'   -> classifyToolName(toolName) ('internal' | 'mcp')
//   otherwise (run.*, step, etc.) -> 'lifecycle'

/** Map a category to subtle, theme-aware tint classNames for the card + left rail.
 *  Failures are handled separately (red) by the caller and override the tint. */
export function categoryTintClasses(category: ToolVisualCategory): {
  card: string;   // e.g. border + faint bg
  rail: string;   // left-rail accent color
};
```

Tints are subtle and theme-aware (light/dark), e.g. memory=violet, internal=sky, mcp=teal,
lifecycle=neutral. Each card also gets a stable `data-tool-category` attribute for tests and
debugging. The exact Tailwind classes are finalized in the plan; they must read clearly in
both themes and never rely on color alone for meaning.

### Unit 3 — compact, badge-free per-tool card (`tool-fallback.tsx`)

- Single-line header: `[status icon] Used <toolName>  [chevron]`. The per-tool card has no
  timestamp data today, so it stays timeless (no invented time); the run-event card owns
  timestamps.
- Remove the `STATUS_LABELS` text pill. Wrap the status icon in a tooltip exposing the
  status word ("Completed"/"Running"/"Failed") + a visually-hidden span for screen readers.
- Apply `categoryTintClasses(classifyToolName(toolName))` to the card border/rail; failure
  state keeps the existing red treatment and overrides the tint.
- Keep the existing args/results expander; move it under the single-line header. The
  "Waiting for tool result…" running hint and error message stay (error inline, concise).
- Preserve `data-testid="tool-fallback"`; add `data-tool-category`.

### Unit 4 — compact, badge-free run-event card (`assistant-run-timeline.tsx`)

- Single-line header: `[status icon] <label>  <inline time>  [chevron]`. Move `kind` and
  `duration` into the fold (alongside existing `detail` + metadata). Keep the time inline
  (it's the most glanceable secondary signal) but small/muted.
- Remove the `STATUS_LABELS` pill; tooltip on the status icon (+ visually-hidden label).
- Apply `categoryTintClasses(classifyRunEvent(event.kind, event.metadata?.toolName))`;
  failed overrides to red (keep).
- Preserve `data-testid="assistant-run-timeline"`; add `data-tool-category`.
- Keep `resolveAssistantRunEventStatus` wiring; it now benefits from the Unit 1 fix.

### Unit 5 — grouping via left rail (CSS, `overrides.css`)

Both cards already render a left "rail" column (`.bs-tool-timeline-rail` /
`.bs-run-timeline-rail`). Give the rail a category-colored accent (from Unit 2) so a run and
its tools read as a visually coherent, lightly-indented stream without restructuring the
flat part list. Keep spacing tighter (reduce `my-2`/`py-3` to a denser rhythm) consistent
across both cards.

## Testing (red → green; deterministic + screenshots)

1. **Unit — spinner fix (RED first):** `getMatchingCompletedKind('run.step.started')` ===
   `'run.step.finished'`; and `resolveAssistantRunEventStatus([...startThenFinish], stepStarted)`
   === `'completed'` (fails before the fix — currently returns `'running'`).
2. **Unit — classifier:** `isInternalToolName` matches `brainstrike.x` and `brainstrike_x`,
   not `someMcpTool`; `classifyRunEvent` maps `memory.*`→memory, `tool.*`+brainstrike→internal,
   `tool.*`+other→mcp, `run.*`/step→lifecycle; `categoryTintClasses` returns distinct
   classes per category.
3. **Component — tool-fallback:** renders no status pill text ("Running/Completed/Failed"
   text is absent as a standalone badge); status icon present with an accessible
   name/tooltip; `data-tool-category` reflects internal vs mcp; expander reveals
   args + result; running shows spinner, success shows check.
4. **Component — run-timeline:** no pill; single-line header; `kind`/`duration` only in the
   fold; `data-tool-category` per kind; failed → red.
5. **E2E (Playwright, desktop mock harness):** drive a tool result, a tool-error, and a
   memory/run event; capture screenshots to files for visual review (attached to the PR /
   shared with the user). Assert structurally (no badge text node, category data-attr,
   composer still usable) — NOT pixel `toHaveScreenshot` (avoids cross-env font flake).

CI-parity gate (AGENTS.md): build + lint + type-check + unit/integration green together
before opening the PR.

## Risks & mitigations

- **Real sanitized tool names differ from the mock** (`brainstrike_` vs `brainstrike.`):
  the classifier matches both; the e2e screenshot run uses the mock's `brainstrike.` form,
  and a unit test covers the `brainstrike_` form.
- **Tint legibility in dark mode:** finalize Tailwind classes against both themes; never
  encode status/meaning with color alone (icon + tooltip carry it).
- **assistant-ui upgrades** may change `tool-fallback` props; we keep the existing prop
  surface and `data-testid`s.
- **Stuck-spinner fix breadth:** the `run.*`→`.finished` rule could mis-handle a future
  `run.*` that uses `.completed`; none exist today, and the tool/memory `.completed` path is
  unchanged. Covered by the classifier/resolution tests.

## Files (anticipated)

- New: `packages/ui/src/assistant-ui-panel/tool-visual-classification.ts` (+ test)
- Edit: `packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx` (spinner fix +
  header/badge/tint) (+ test)
- Edit: `packages/ui/src/assistant-ui-panel/tool-fallback.tsx` (header/badge/tint) (+ test)
- Edit: `packages/ui/src/assistant-ui-panel/overrides.css` (rail accents, density)
- New: `apps/desktop/e2e/assistant-tool-card-visuals.desktop.test.ts` (screenshots +
  structural assertions)
- Possibly: a tooltip primitive reuse from `@brainstrike/ui` (existing `TooltipIconButton`
  / Radix tooltip) for the status-icon tooltip.

## Out of scope (later)

- True nested tool grouping (treegrid). Reasoning persistence (#4). Toolbar polish (#5).
