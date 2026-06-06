# Message Hover-Toolbar Polish — Design

- **Date:** 2026-06-05
- **Workstream:** #5 of 5 (message-toolbar polish)
- **Branch:** `harden/assistant-toolbar-polish`
- **Scope:** Shrink the assistant message hover toolbar (copy/retry) and drop the rounded box. Decision: drop the box entirely.
- **Grounding:** Deterministic className regression test + a desktop e2e hover screenshot.
- **Status:** Approved approach + decisions; pending spec review.

## Problem

The per-message hover toolbar (`AssistantActionBar` in
[assistant-ui-panel.tsx:1132-1155](../../../packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx))
renders copy/retry as `size-6` icon buttons inside a floating **rounded bordered box**
(`data-[floating]:rounded-md border bg-background p-1 shadow-sm`). The user finds the box
unnecessary and the buttons larger than needed.

## Goal

On hover, show bare, smaller copy/retry icons that still float in place — no border,
background, shadow, or rounded box — while preserving the existing hover/float behavior
(`autohide`, `autohideFloat`, `hideWhenRunning`) and accessibility (tooltips + aria-labels).

## Non-Goals

- Any other assistant-panel surface (tool cards, run timeline, reasoning, composer).
- Adding/removing toolbar actions (copy/retry stay; edit on user messages unchanged).
- Behavior changes to floating/autohide.

## Design

Single component: `AssistantActionBar`. To make the change testable without rendering
assistant-ui's runtime, extract the two classNames to exported named constants and assert
their content.

### Unit 1 — extract + restyle classNames

```ts
// exported for regression testing
export const ASSISTANT_ACTION_BAR_CLASSNAME =
  'col-start-3 row-start-2 -ml-1 flex gap-0.5 text-muted-foreground data-[floating]:absolute';
export const ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME = 'size-5';
```

- Root: drop `data-[floating]:rounded-md`, `data-[floating]:border`,
  `data-[floating]:bg-background`, `data-[floating]:p-1`, `data-[floating]:shadow-sm`; keep
  `data-[floating]:absolute`; tighten `gap-1` → `gap-0.5`.
- Buttons: pass `className={ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME}` (`size-5`) to each
  `TooltipIconButton` (overrides the default `size-6` via `cn` merge).
- Icons: `size-4` → `size-3.5` for `CopyIcon`, `CheckIcon`, `RefreshCwIcon`.
- `ActionBarPrimitive.Root` uses `className={ASSISTANT_ACTION_BAR_CLASSNAME}`; the
  `autohide`/`autohideFloat`/`hideWhenRunning` props are unchanged.

### Unit 2 — keep tooltips/a11y

`TooltipIconButton` already provides `aria-label` + tooltip; unchanged. The smaller size
must keep an adequate hit target — `size-5` (20px) with the tooltip-button padding is
acceptable for a hover affordance; icons at `size-3.5` (14px) remain legible.

## Testing

1. **Deterministic regression (unit):** assert `ASSISTANT_ACTION_BAR_CLASSNAME` does NOT
   contain `border`, `shadow`, `bg-background`, or `rounded-md`; DOES contain
   `data-[floating]:absolute`; and `ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME` is `size-5`.
   (Guards against accidental reintroduction of the box.) Add to a small new test in the
   `packages/ui/src/assistant-ui-panel/__tests__/` directory; the constants are imported
   directly (no assistant-ui runtime needed).
2. **Desktop e2e hover screenshot:** drive a simple assistant text response via the mock
   harness, hover the (last) assistant message to reveal the action bar, assert the copy
   button (`aria-label="Copy message"`) is present, and capture a screenshot to
   `apps/desktop/e2e-artifacts/` (gitignored; not committed) for visual review.

CI-parity gate (AGENTS.md): build + lint + type-check + unit/integration green together.

## Risks & mitigations

- **Legibility without a backing:** icons use `text-muted-foreground`; if they prove hard to
  see over message text, a faint backing is a one-line follow-up (the user chose
  drop-entirely). The screenshot confirms.
- **Hover-toolbar e2e flakiness:** the action bar is hover-triggered; the e2e hovers the
  message and waits for the copy button before screenshotting; if hover proves flaky in
  headless Electron, fall back to asserting the button exists in the DOM (autohide is CSS)
  and still capture the screenshot. Reported, not bypassed.
- **assistant-ui prop changes:** none touched; only classNames + icon sizes change.

## Files (anticipated)

- Edit: `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` (extract + restyle
  `AssistantActionBar` classNames + icon sizes).
- New: `packages/ui/src/assistant-ui-panel/__tests__/assistant-action-bar.test.ts`
  (className regression).
- New: `apps/desktop/e2e/assistant-toolbar-visuals.desktop.test.ts` (hover screenshot +
  presence assertion); ensure `apps/desktop/e2e-artifacts/` is gitignored.

## Out of scope

Future toolbar actions/build-out (the user noted they may extend it later — not now).
