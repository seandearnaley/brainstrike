# Message Hover-Toolbar Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the assistant message hover toolbar (copy/retry) bare and smaller — drop the rounded bordered box, keep float-on-hover.

**Architecture:** Restyle one component (`AssistantActionBar`) by extracting its classNames to exported constants (drop the box classes, shrink buttons/icons), guarded by a deterministic className regression test, plus a desktop e2e hover screenshot for visual confirmation.

**Tech Stack:** TypeScript (strict), React 19, Tailwind v4, `@assistant-ui/react`, Vitest, Playwright (desktop e2e). pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-05-assistant-toolbar-polish-design.md`

**Verified facts (current code, [assistant-ui-panel.tsx:1132-1155](../../../packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx)):**
- Root className: `col-start-3 row-start-2 -ml-1 flex gap-1 text-muted-foreground data-[floating]:absolute data-[floating]:rounded-md data-[floating]:border data-[floating]:bg-background data-[floating]:p-1 data-[floating]:shadow-sm`.
- Buttons: `TooltipIconButton` (default `size-6 p-1`, merges extra className via `cn`), `aria-label="Copy message"` / `"Regenerate response"`. Icons `CheckIcon`/`CopyIcon`/`RefreshCwIcon` at `size-4`.
- `TooltipIconButton` sets the accessible name from the passed `aria-label` ("Copy message"), so e2e can target `getByRole('button', { name: 'Copy message' })`.
- UI tests: `*.test.ts(x)` under `__tests__/`, `cd packages/ui && pnpm vitest run --project unit <path>`.
- Desktop e2e: `apps/desktop/e2e/*.desktop.test.ts`; `assistant-panel.desktop.test.ts` already drives a simple response and asserts `"Hello from desktop assistant!"` — copy its open-chat/send pattern. Run via `node ../../scripts/run-env.mjs ... -- pnpm exec playwright test e2e/<file> --project=regression --workers=1`.
- ultracite: accept formatting. Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` | Extract + restyle `AssistantActionBar` classNames + icon sizes | Modify |
| `packages/ui/src/assistant-ui-panel/__tests__/assistant-action-bar.test.ts` | className regression | New |
| `apps/desktop/e2e/assistant-toolbar-visuals.desktop.test.ts` | hover screenshot + presence | New |
| `apps/desktop/.gitignore` | ignore `e2e-artifacts/` (if not already) | Modify |

---

## Task 1: Restyle the hover toolbar

**Files:**
- Modify: `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx`
- Test: `packages/ui/src/assistant-ui-panel/__tests__/assistant-action-bar.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/assistant-ui-panel/__tests__/assistant-action-bar.test.ts
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME,
  ASSISTANT_ACTION_BAR_CLASSNAME,
} from '../assistant-ui-panel';

describe('AssistantActionBar styling', () => {
  it('drops the floating box (no border/shadow/background/rounded)', () => {
    for (const token of ['border', 'shadow', 'bg-background', 'rounded-md']) {
      expect(ASSISTANT_ACTION_BAR_CLASSNAME).not.toContain(token);
    }
  });

  it('keeps floating on hover', () => {
    expect(ASSISTANT_ACTION_BAR_CLASSNAME).toContain('data-[floating]:absolute');
  });

  it('uses smaller buttons', () => {
    expect(ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME).toContain('size-5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ui && pnpm vitest run --project unit src/assistant-ui-panel/__tests__/assistant-action-bar.test.ts`
Expected: FAIL — the constants aren't exported yet.

- [ ] **Step 3: Extract constants + restyle**

In `assistant-ui-panel.tsx`, add exported constants near `AssistantActionBar` (above the component):

```ts
export const ASSISTANT_ACTION_BAR_CLASSNAME =
  'col-start-3 row-start-2 -ml-1 flex gap-0.5 text-muted-foreground data-[floating]:absolute';
export const ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME = 'size-5';
```

Rewrite `AssistantActionBar` to use them, drop the box, shrink icons to `size-3.5`:

```tsx
const AssistantActionBar: FC = () => (
  <ActionBarPrimitive.Root
    autohide="not-last"
    autohideFloat="single-branch"
    className={ASSISTANT_ACTION_BAR_CLASSNAME}
    hideWhenRunning
  >
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton
        aria-label="Copy message"
        className={ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME}
        tooltip="Copy"
      >
        <MessagePrimitive.If copied>
          <CheckIcon className="size-3.5" />
        </MessagePrimitive.If>
        <MessagePrimitive.If copied={false}>
          <CopyIcon className="size-3.5" />
        </MessagePrimitive.If>
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.Reload asChild>
      <TooltipIconButton
        aria-label="Regenerate response"
        className={ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME}
        tooltip="Retry"
      >
        <RefreshCwIcon className="size-3.5" />
      </TooltipIconButton>
    </ActionBarPrimitive.Reload>
  </ActionBarPrimitive.Root>
);
```

(Keep the `autohide`/`autohideFloat`/`hideWhenRunning` props exactly. `TooltipIconButton` merges `size-5` over its default `size-6` via `cn`.)

- [ ] **Step 4: Run test to verify it passes + the assistant-panel suite**

Run: `cd packages/ui && pnpm vitest run --project unit src/assistant-ui-panel`
Expected: new test passes; existing assistant-panel tests still pass.

- [ ] **Step 5: Type-check + lint + commit**

```bash
cd packages/ui && pnpm exec tsc --noEmit
pnpm dlx ultracite fix packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx packages/ui/src/assistant-ui-panel/__tests__/assistant-action-bar.test.ts
git add packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx packages/ui/src/assistant-ui-panel/__tests__/assistant-action-bar.test.ts
git commit -m "feat(ui): bare, smaller message hover toolbar (drop the box)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Scope guard
Modify ONLY `AssistantActionBar` + its test. Do NOT change the `UserActionBar`/`EditComposer`, tool cards, run timeline, or composer. Preserve the floating/autohide behavior and aria-labels.

---

## Task 2: Desktop e2e hover screenshot

**Files:**
- Create: `apps/desktop/e2e/assistant-toolbar-visuals.desktop.test.ts`
- Modify: `apps/desktop/.gitignore` (ensure `e2e-artifacts/` ignored — likely added in workstream #3; verify)

- [ ] **Step 1: Study the harness**

Read `apps/desktop/e2e/assistant-panel.desktop.test.ts` for the exact open-chat + send-prompt flow that yields `"Hello from desktop assistant!"`, and `apps/desktop/e2e/assistant-tool-card-visuals.desktop.test.ts` (workstream #3) for the run command/project + screenshot pattern. Confirm `apps/desktop/.gitignore` already ignores `e2e-artifacts/` (added in #3); if this branch is off main without that ignore, add `e2e-artifacts/` to `apps/desktop/.gitignore`.

- [ ] **Step 2: Write the test**

Create `apps/desktop/e2e/assistant-toolbar-visuals.desktop.test.ts` that: opens the assistant, sends a prompt, waits for the assistant response text, hovers the assistant message to reveal the action bar, asserts the copy button is present, and screenshots. Mirror the helper calls from `assistant-panel.desktop.test.ts` (do not invent selectors):

```ts
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

test.describe('Assistant hover toolbar (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
  });

  test('shows a bare, smaller copy/retry toolbar on hover', async ({ window }) => {
    await setupAssistantMock(window, { variant: 'detailed', message: 'Hello from desktop assistant!' });
    await ensureAssistantShellVisible(window);
    const input = window.locator('#assistant-input');
    await input.fill('hi');
    await window.getByRole('button', { name: 'Send' }).click();

    const reply = window.getByText('Hello from desktop assistant!').first();
    await expect(reply).toBeVisible({ timeout: E2E_TIMEOUTS.messageVisibility });
    await reply.hover();

    const copyButton = window.getByRole('button', { name: 'Copy message' }).first();
    await expect(copyButton).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
    await window.screenshot({ path: 'e2e-artifacts/hover-toolbar.png' });
  });
});
```

ADAPT: use the actual helper names/flow from `assistant-panel.desktop.test.ts` (it may define its own open/send helpers — mirror them). Confirm the mock `detailed`/default variant produces a visible assistant reply. If the action bar's copy button is not reliably revealed by hovering the reply text (autohide is CSS; it shows for the LAST message), hover the message container instead, or assert presence in the DOM (`toHaveCount(1)`) and still screenshot — report whichever you used. Do NOT weaken to a no-op.

- [ ] **Step 3: Run it (twice for flake)**

Run: `cd apps/desktop && node ../../scripts/run-env.mjs NO_COLOR= BRAINSTRIKE_DISABLE_FILE_LOGS=1 LOG_LEVEL=warn -- pnpm exec playwright test e2e/assistant-toolbar-visuals.desktop.test.ts --project=regression --workers=1`
Expected: PASS, twice. Confirm `apps/desktop/e2e-artifacts/hover-toolbar.png` was written.

- [ ] **Step 4: Commit (test + gitignore only; NO PNG)**

```bash
git status --porcelain | grep -i 'e2e-artifacts/.*png' && echo "PNG STAGED - DO NOT COMMIT" || true
git add apps/desktop/e2e/assistant-toolbar-visuals.desktop.test.ts apps/desktop/.gitignore
git commit -m "test(desktop): e2e hover screenshot for the bare message toolbar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Scope guard
Add the e2e spec (+ gitignore entry if missing). Do NOT commit screenshots. Do NOT modify product code.

---

## Task 3: Full gate + PR

- [ ] **Step 1: Full local gate (CI parity)**

Run from repo root: `pnpm type-check && pnpm lint:ci && pnpm build && pnpm test`
Expected: all green together. Fix anything red; re-run the whole suite. (jsdom-heavy packages / `db#test` can flake under turbo concurrency — re-run in isolation to confirm before treating as real.)

- [ ] **Step 2: Push + PR + monitor CI**

```bash
git push -u origin harden/assistant-toolbar-polish
gh pr create --base main --fill
gh pr checks --watch
```
Fix any red checks (incl. `codecov/patch`) and push until green. After a green run, the controller attaches `apps/desktop/e2e-artifacts/hover-toolbar.png` for the user.

---

## Self-Review (completed by author)

- **Spec coverage:** Drop box + smaller buttons/icons → Task 1 (extract constants, drop `border/shadow/bg-background/rounded-md`, keep `data-[floating]:absolute`, `size-5` buttons, `size-3.5` icons). Keep float/autohide/a11y → Task 1 (props unchanged, aria-labels kept). className regression test → Task 1. e2e hover screenshot → Task 2. Gitignore artifacts → Task 2. Gate + PR → Task 3.
- **Type consistency:** `ASSISTANT_ACTION_BAR_CLASSNAME` / `ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME` exported in Task 1 and imported by the Task 1 test; e2e targets `'Copy message'` consistent with the kept aria-label.
- **Investigate-then-implement spot:** Task 2 mirrors the real helpers in `assistant-panel.desktop.test.ts` (read first) and has a stated fallback if hover-reveal is flaky — not vague.
