# BST-1837 TabStrip Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the presentational tab-strip system in `@brainstrike/ui`: `TabStrip`, `TabStripTab`, overflow, keyboard model, reorder, the All-tabs menu and `TabPanelBoundary`. Also ship the shared `createTabStripActions` factory in `@brainstrike/context-actions`. Nothing is consumed yet; the migrations are BST-1838/1839/1840.

**Architecture:**
- The API is data-driven: `items` and `pinnedItems`, plus intent callbacks (`onActivate`, `onClose`, `onReorder`) and a `contextMenu` descriptor.
- The strip owns only DOM mechanics: roving focus, overflow, native drag-and-drop through pragmatic-dnd 3.x, and menu claiming. It holds no store and no domain type.
- Tab-management actions come from a pure factory in `context-actions`, so every strip offers the same menu.

**Tech Stack:** React 19.3, TypeScript strict (with `exactOptionalPropertyTypes`), Tailwind v4.3, Radix Context Menu and Dropdown Menu, `@atlaskit/pragmatic-drag-and-drop` 3.1 (plus hitbox 2.2 and auto-scroll 3.2), and Vitest. Unit tests run under happy-dom; browser tests run under Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-09-27-unified-tab-controllers-design.md` (approved 2026-09-27, all decisions D1–D9 as recommended).

## Global Constraints

- Work on branch `seandearnaley/bst-1837-tabstrip-primitives-in-brainstrikeui-strip-tab-overflow` in its own worktree.
- `packages/ui` stays a leaf. It imports no feature package; the allowed dependencies are `@brainstrike/context-actions`, `hooks`, `logging` and `utils`.
- Class names are literal strings, never composed at runtime. There is no hardcoded `z-` utility anywhere in `packages/ui` (guard: `floating-layer-tokens.test.ts`).
- Activation is manual: arrows move focus, and Enter/Space (native button click) activate. The close button is `aria-hidden="true"` with `tabIndex={-1}`.
- pragmatic-dnd imports use only the paths already used in app-shell: `/adapter/element-adapter`, `/utils/combine`, `-hitbox/closest-edge` and `-auto-scroll/element`. Versions match app-shell exactly: `^3.1.0` / `^2.2.0` / `^3.2.0`.
- Every action run resolves an `ActionOutcome`, re-checks its target at execution, and fails loudly. No silent fallbacks.
- TypeScript: never `any`, and annotate parameters and return types. Filenames are kebab-case.
- Test commands (from repo root):
  - `pnpm --filter @brainstrike/ui exec vitest run --project unit <path>`
  - `pnpm --filter @brainstrike/ui exec vitest run --project browser <path>`
  - `pnpm --filter @brainstrike/context-actions exec vitest run <path>`
- Before every commit, run `pnpm dlx ultracite fix <changed files>`. The commit trailer is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

```
packages/context-actions/src/
  types.ts                         MODIFY  add `tab-strip` ContextTarget kind
  tab-strip-actions.ts             CREATE  moveTabId + createTabStripActions
  index.ts                         MODIFY  export the above
  __tests__/tab-strip-actions.test.ts CREATE
packages/ui/
  package.json                     MODIFY  pragmatic-dnd deps; devDeps axe-core, @tailwindcss/vite
  vitest.config.mts                MODIFY  tailwindcss() plugin for the browser project
  src/index.ts                     MODIFY  export * from './tab-strip'
  src/tab-strip/
    types.ts                       CREATE  TabStripItem, TabStripProps, TabStatus, TabAppearance, TabStripContextMenu
    tab-strip-tokens.ts            CREATE  literal geometry/state classes (spec §5)
    tab-strip-order.ts             CREATE  pure: drop order, focus-after-close, roving index
    tab-status.tsx                 CREATE  status icon + default status labels
    tab-strip-reorder.ts           CREATE  pragmatic-dnd item + monitor hooks
    tab-strip-tab.tsx              CREATE  memoized visual tab
    use-tab-strip-overflow.ts      CREATE  overflow flags, mask style, native wheel mapping
    tab-strip-keyboard.ts          CREATE  APG keyboard dispatcher
    tab-strip-all-tabs-menu.tsx    CREATE  All-tabs dropdown
    tab-panel-boundary.tsx         CREATE  per-panel error boundary
    tab-strip.tsx                  CREATE  composition
    index.ts                       CREATE  public surface
    __tests__/tab-strip-order.test.ts
    __tests__/tab-strip-tab.test.tsx
    __tests__/tab-panel-boundary.test.tsx
    __tests__/use-tab-strip-overflow.test.tsx
    __tests__/tab-strip.test.tsx
    __tests__/tab-strip.browser.css
    __tests__/tab-strip.browser.test.tsx
docs/agents/ui-conventions.md      MODIFY  new "## TAB STRIPS" section
docs/archive/agent-contract-history/ui-conventions/tab-strips.md CREATE evidence file
```

---

### Task 1: Shared tab actions and the `tab-strip` target kind (`@brainstrike/context-actions`)

**Files:**
- Modify: `packages/context-actions/src/types.ts` (add a union member before `| { kind: 'collection'; id: string; name: string }`)
- Create: `packages/context-actions/src/tab-strip-actions.ts`
- Modify: `packages/context-actions/src/index.ts`
- Test: `packages/context-actions/src/__tests__/tab-strip-actions.test.ts`

**Interfaces:**
- Produces `moveTabId(orderedIds: readonly string[], id: string, direction: 'left' | 'right'): readonly string[] | null`.
- Produces `createTabStripActions<K extends ContextTargetKind>(operations: TabStripActionOperations<K>): readonly AnyContextAction[]`, with action ids `${idPrefix}.close | .close-others | .close-right | .close-all | .move-left | .move-right`.
- Produces `ContextTarget` member `{ readonly kind: 'tab-strip'; readonly stripId: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/context-actions/src/__tests__/tab-strip-actions.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createActionRegistry } from '../registry.js';
import {
  createTabStripActions,
  moveTabId,
  type TabStripActionOperations,
} from '../tab-strip-actions.js';
import type { AnyContextAction, TargetOf } from '../types.js';

type ThreadTabTarget = TargetOf<'assistant-thread-tab'>;

function threadTab(id: string): ThreadTabTarget {
  return { id, kind: 'assistant-thread-tab', resourceId: 'resource', title: `Title ${id}` };
}

function setup(
  initial: readonly string[],
  overrides: Partial<TabStripActionOperations<'assistant-thread-tab'>> = {}
) {
  let order: readonly string[] = [...initial];
  const operations = {
    close: vi.fn((id: string) => {
      order = order.filter((candidate) => candidate !== id);
    }),
    closeAll: vi.fn(() => {
      order = [];
    }),
    closeOthers: vi.fn((id: string) => {
      order = [id];
    }),
    closeToRight: vi.fn((id: string) => {
      order = order.slice(0, order.indexOf(id) + 1);
    }),
    reorder: vi.fn((next: readonly string[]) => {
      order = [...next];
    }),
  };
  const actions = createTabStripActions({
    getId: (target) => target.id,
    getLabel: (target) => target.title,
    getOrderedIds: () => order,
    idPrefix: 'assistant-thread-tab',
    kind: 'assistant-thread-tab',
    noun: 'thread tab',
    ...operations,
    ...overrides,
  });
  const action = (suffix: string): AnyContextAction => {
    const found = actions.find((candidate) => candidate.id === `assistant-thread-tab.${suffix}`);
    if (!found) {
      throw new Error(`missing action ${suffix}`);
    }
    return found;
  };
  return { action, actions, getOrder: () => order, operations };
}

const enabled = (action: AnyContextAction, target: ThreadTabTarget): boolean =>
  action.isEnabled ? action.isEnabled(target) : true;

describe('moveTabId', () => {
  it('swaps a tab with its left or right neighbour', () => {
    expect(moveTabId(['a', 'b', 'c'], 'b', 'left')).toEqual(['b', 'a', 'c']);
    expect(moveTabId(['a', 'b', 'c'], 'b', 'right')).toEqual(['a', 'c', 'b']);
  });

  it('returns null at the edges and for an unknown id', () => {
    expect(moveTabId(['a', 'b'], 'a', 'left')).toBeNull();
    expect(moveTabId(['a', 'b'], 'b', 'right')).toBeNull();
    expect(moveTabId(['a', 'b'], 'z', 'left')).toBeNull();
  });
});

describe('createTabStripActions', () => {
  it('emits the standard set in menu order with namespaced ids', () => {
    const { actions } = setup(['a', 'b']);
    expect(actions.map((candidate) => candidate.id)).toEqual([
      'assistant-thread-tab.close',
      'assistant-thread-tab.close-others',
      'assistant-thread-tab.close-right',
      'assistant-thread-tab.close-all',
      'assistant-thread-tab.move-left',
      'assistant-thread-tab.move-right',
    ]);
    expect(actions.map((candidate) => candidate.label)).toEqual([
      'Close',
      'Close Others',
      'Close to the Right',
      'Close All',
      'Move Left',
      'Move Right',
    ]);
  });

  it('omits every action whose operation the strip does not provide', () => {
    const actions = createTabStripActions({
      close: () => undefined,
      getId: (target) => target.id,
      getLabel: (target) => target.title,
      getOrderedIds: () => ['a'],
      idPrefix: 'only-close',
      kind: 'assistant-thread-tab',
      noun: 'tab',
    });
    expect(actions.map((candidate) => candidate.id)).toEqual(['only-close.close']);
  });

  it('gates enablement on the live position of the tab', () => {
    const { action } = setup(['a', 'b', 'c']);
    expect(enabled(action('close-right'), threadTab('a'))).toBe(true);
    expect(enabled(action('close-right'), threadTab('c'))).toBe(false);
    expect(enabled(action('move-left'), threadTab('a'))).toBe(false);
    expect(enabled(action('move-right'), threadTab('a'))).toBe(true);
    expect(enabled(action('close'), threadTab('z'))).toBe(false);
    const single = setup(['a']);
    expect(enabled(single.action('close-others'), threadTab('a'))).toBe(false);
  });

  it('closes the target and re-validates it at execution time', async () => {
    const { action, getOrder, operations } = setup(['a', 'b', 'c']);
    await expect(action('close').run(threadTab('b'), {})).resolves.toEqual({ ok: true });
    expect(operations.close).toHaveBeenCalledWith('b');
    expect(getOrder()).toEqual(['a', 'c']);
    await expect(action('close').run(threadTab('b'), {})).resolves.toEqual({
      error: 'This thread tab is no longer open',
      ok: false,
    });
    expect(operations.close).toHaveBeenCalledTimes(1);
  });

  it('refuses bulk closes that have nothing to close', async () => {
    const { action, operations } = setup(['a', 'b']);
    await expect(action('close-right').run(threadTab('b'), {})).resolves.toEqual({
      error: 'No thread tabs are open to the right',
      ok: false,
    });
    expect(operations.closeToRight).not.toHaveBeenCalled();
    const single = setup(['a']);
    await expect(single.action('close-others').run(threadTab('a'), {})).resolves.toEqual({
      error: 'No other thread tabs are open',
      ok: false,
    });
  });

  it('moves within the live order and reports the move', async () => {
    const { action, getOrder } = setup(['a', 'b', 'c']);
    await expect(action('move-right').run(threadTab('a'), {})).resolves.toEqual({
      message: 'Moved Title a right',
      ok: true,
    });
    expect(getOrder()).toEqual(['b', 'a', 'c']);
    await expect(action('move-left').run(threadTab('b'), {})).resolves.toEqual({
      error: 'Title b cannot move left',
      ok: false,
    });
  });

  it('registers alongside global actions: close group first, move group second', () => {
    const { actions } = setup(['a', 'b']);
    const registry = createActionRegistry({ actions: [], capabilities: new Set(), services: {} });
    const groups = registry.actionsFor(threadTab('a'), actions);
    expect(groups.map((group) => group.group)).toEqual(['primary', 'tree']);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @brainstrike/context-actions exec vitest run src/__tests__/tab-strip-actions.test.ts`
Expected: FAIL, with "Failed to resolve import '../tab-strip-actions.js'".

- [ ] **Step 3: Add the target kind.** In `packages/context-actions/src/types.ts`, insert this member directly before `| { kind: 'collection'; id: string; name: string }`:

```ts
  /**
   * The empty background of a tab strip (BST-1836 §6.4). Strip-level local
   * actions (New, Close All) claim it; `stripId` names the owning strip.
   */
  | { readonly kind: 'tab-strip'; readonly stripId: string }
```

- [ ] **Step 4: Implement `packages/context-actions/src/tab-strip-actions.ts`**

```ts
import {
  type ActionOutcome,
  type AnyContextAction,
  type ContextTargetKind,
  defineContextAction,
  type TargetOf,
} from './types.js';

export type TabMoveDirection = 'left' | 'right';

/**
 * Swap `id` with its neighbour in `direction`. Null when `id` is absent or
 * already at that edge, so callers can tell "no move" from a move.
 */
export function moveTabId(
  orderedIds: readonly string[],
  id: string,
  direction: TabMoveDirection
): readonly string[] | null {
  const index = orderedIds.indexOf(id);
  if (index === -1) {
    return null;
  }
  const destination = index + (direction === 'left' ? -1 : 1);
  const neighbour = orderedIds[destination];
  if (neighbour === undefined) {
    return null;
  }
  const next = [...orderedIds];
  next[index] = neighbour;
  next[destination] = id;
  return next;
}

/**
 * Store-backed operations behind one strip's standard tab menu (BST-1836
 * §6.4). Each operation is optional: an absent one omits its action. Each must
 * be atomic in the owning store — this factory only resolves ids, gates
 * enablement on the live order, and re-validates at execution.
 */
export interface TabStripActionOperations<K extends ContextTargetKind> {
  readonly close?: ((id: string) => void) | undefined;
  readonly closeAll?: (() => void) | undefined;
  readonly closeOthers?: ((id: string) => void) | undefined;
  readonly closeToRight?: ((id: string) => void) | undefined;
  readonly getId: (target: TargetOf<K>) => string;
  readonly getLabel: (target: TargetOf<K>) => string;
  /** Live order of the target's group, read at menu-open AND at execution. */
  readonly getOrderedIds: (target: TargetOf<K>) => readonly string[];
  /** Namespaces action ids (`${idPrefix}.close`); unique per strip. */
  readonly idPrefix: string;
  readonly kind: K;
  /** Noun for failure copy: "This thread tab is no longer open". */
  readonly noun: string;
  readonly reorder?: ((orderedIds: readonly string[]) => void) | undefined;
}

const OK: ActionOutcome = { ok: true };

function fail(error: string): Promise<ActionOutcome> {
  return Promise.resolve({ error, ok: false });
}

export function createTabStripActions<K extends ContextTargetKind>(
  operations: TabStripActionOperations<K>
): readonly AnyContextAction[] {
  const { getId, getLabel, getOrderedIds, idPrefix, kind, noun } = operations;
  const locate = (target: TargetOf<K>): { index: number; orderedIds: readonly string[] } => {
    const orderedIds = getOrderedIds(target);
    return { index: orderedIds.indexOf(getId(target)), orderedIds };
  };
  const stale = (): Promise<ActionOutcome> => fail(`This ${noun} is no longer open`);
  const actions: AnyContextAction[] = [];

  const { close, closeAll, closeOthers, closeToRight, reorder } = operations;
  if (close) {
    actions.push(
      defineContextAction<K>({
        appliesTo: [kind],
        group: 'primary',
        id: `${idPrefix}.close`,
        isEnabled: (target) => locate(target).index >= 0,
        label: 'Close',
        run: (target) => {
          if (locate(target).index < 0) {
            return stale();
          }
          close(getId(target));
          return Promise.resolve(OK);
        },
      })
    );
  }
  if (closeOthers) {
    actions.push(
      defineContextAction<K>({
        appliesTo: [kind],
        group: 'primary',
        id: `${idPrefix}.close-others`,
        isEnabled: (target) => {
          const { index, orderedIds } = locate(target);
          return index >= 0 && orderedIds.length > 1;
        },
        label: 'Close Others',
        run: (target) => {
          const { index, orderedIds } = locate(target);
          if (index < 0) {
            return stale();
          }
          if (orderedIds.length <= 1) {
            return fail(`No other ${noun}s are open`);
          }
          closeOthers(getId(target));
          return Promise.resolve(OK);
        },
      })
    );
  }
  if (closeToRight) {
    actions.push(
      defineContextAction<K>({
        appliesTo: [kind],
        group: 'primary',
        id: `${idPrefix}.close-right`,
        isEnabled: (target) => {
          const { index, orderedIds } = locate(target);
          return index >= 0 && index < orderedIds.length - 1;
        },
        label: 'Close to the Right',
        run: (target) => {
          const { index, orderedIds } = locate(target);
          if (index < 0) {
            return stale();
          }
          if (index === orderedIds.length - 1) {
            return fail(`No ${noun}s are open to the right`);
          }
          closeToRight(getId(target));
          return Promise.resolve(OK);
        },
      })
    );
  }
  if (closeAll) {
    actions.push(
      defineContextAction<K>({
        appliesTo: [kind],
        group: 'primary',
        id: `${idPrefix}.close-all`,
        isEnabled: (target) => locate(target).index >= 0,
        label: 'Close All',
        run: (target) => {
          if (locate(target).index < 0) {
            return stale();
          }
          closeAll();
          return Promise.resolve(OK);
        },
      })
    );
  }
  if (reorder) {
    for (const direction of ['left', 'right'] as const) {
      actions.push(
        defineContextAction<K>({
          appliesTo: [kind],
          group: 'tree',
          id: `${idPrefix}.move-${direction}`,
          isEnabled: (target) => moveTabId(getOrderedIds(target), getId(target), direction) !== null,
          label: direction === 'left' ? 'Move Left' : 'Move Right',
          run: (target) => {
            const { index, orderedIds } = locate(target);
            if (index < 0) {
              return stale();
            }
            const next = moveTabId(orderedIds, getId(target), direction);
            if (!next) {
              return fail(`${getLabel(target)} cannot move ${direction}`);
            }
            reorder(next);
            return Promise.resolve({ message: `Moved ${getLabel(target)} ${direction}`, ok: true });
          },
        })
      );
    }
  }
  return actions;
}
```

- [ ] **Step 5: Export it.** Add this to `packages/context-actions/src/index.ts`, after the `registry.js` export block:

```ts
export {
  createTabStripActions,
  moveTabId,
  type TabMoveDirection,
  type TabStripActionOperations,
} from './tab-strip-actions.js';
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm --filter @brainstrike/context-actions exec vitest run`
Expected: all tests PASS, including the 9 new ones.
Run: `pnpm --filter @brainstrike/context-actions exec tsc -b .`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/context-actions/src
git commit -m "feat(BST-1837): shared tab-strip context actions and tab-strip target kind"
```

---

### Task 2: Tokens, types, pure ordering helpers and status icon (`@brainstrike/ui`)

**Files:**
- Create: `packages/ui/src/tab-strip/tab-strip-tokens.ts`, `types.ts`, `tab-strip-order.ts`, `tab-status.tsx`
- Test: `packages/ui/src/tab-strip/__tests__/tab-strip-order.test.ts`

**Interfaces:**
- Consumes `moveTabId` from `@brainstrike/context-actions` (Task 1).
- Produces:
  - `resolveTabDropOrder({ edge, orderedIds, sourceId, targetId }): TabDropResolution`
  - `resolveFocusAfterClose(orderedIds, closedId): string | null`
  - `resolveRovingTargetIndex(key, currentIndex, count): number | null`
  - `TabStatusIcon`
  - `resolveTabStatusLabel(status, override?)`
  - every type in `types.ts`
  - every token below

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/tab-strip/__tests__/tab-strip-order.test.ts
import { describe, expect, it } from 'vitest';
import {
  resolveFocusAfterClose,
  resolveRovingTargetIndex,
  resolveTabDropOrder,
} from '../tab-strip-order';

describe('resolveTabDropOrder', () => {
  const orderedIds = ['a', 'b', 'c', 'd'];

  it('inserts before the left edge and after the right edge of the target', () => {
    expect(resolveTabDropOrder({ edge: 'left', orderedIds, sourceId: 'd', targetId: 'b' })).toEqual({
      kind: 'reorder',
      orderedIds: ['a', 'd', 'b', 'c'],
    });
    expect(resolveTabDropOrder({ edge: 'right', orderedIds, sourceId: 'a', targetId: 'c' })).toEqual({
      kind: 'reorder',
      orderedIds: ['b', 'c', 'a', 'd'],
    });
  });

  it('returns none for a self-drop or an order-preserving drop', () => {
    expect(resolveTabDropOrder({ edge: 'left', orderedIds, sourceId: 'b', targetId: 'b' })).toEqual({
      kind: 'none',
    });
    expect(resolveTabDropOrder({ edge: 'right', orderedIds, sourceId: 'b', targetId: 'a' })).toEqual({
      kind: 'none',
    });
  });

  it('reports a drag that outlived its tab as stale instead of guessing', () => {
    expect(resolveTabDropOrder({ edge: 'left', orderedIds, sourceId: 'z', targetId: 'b' })).toEqual({
      kind: 'stale',
      missingId: 'z',
    });
    expect(resolveTabDropOrder({ edge: 'left', orderedIds, sourceId: 'a', targetId: 'y' })).toEqual({
      kind: 'stale',
      missingId: 'y',
    });
  });
});

describe('resolveFocusAfterClose', () => {
  it('prefers the next tab, then the previous one, then nothing', () => {
    expect(resolveFocusAfterClose(['a', 'b', 'c'], 'b')).toBe('c');
    expect(resolveFocusAfterClose(['a', 'b', 'c'], 'c')).toBe('b');
    expect(resolveFocusAfterClose(['a'], 'a')).toBeNull();
    expect(resolveFocusAfterClose(['a'], 'z')).toBeNull();
  });
});

describe('resolveRovingTargetIndex', () => {
  it('wraps arrows and jumps with Home/End', () => {
    expect(resolveRovingTargetIndex('ArrowRight', 2, 3)).toBe(0);
    expect(resolveRovingTargetIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(resolveRovingTargetIndex('ArrowRight', 0, 3)).toBe(1);
    expect(resolveRovingTargetIndex('Home', 2, 3)).toBe(0);
    expect(resolveRovingTargetIndex('End', 0, 3)).toBe(2);
  });

  it('ignores other keys and empty strips', () => {
    expect(resolveRovingTargetIndex('Enter', 0, 3)).toBeNull();
    expect(resolveRovingTargetIndex('ArrowRight', 0, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/tab-strip/__tests__/tab-strip-order.test.ts`
Expected: FAIL, with "Failed to resolve import '../tab-strip-order'".

- [ ] **Step 3: Implement `packages/ui/src/tab-strip/tab-strip-order.ts`**

```ts
export type TabEdge = 'left' | 'right';

export type TabDropResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'reorder'; readonly orderedIds: readonly string[] }
  | { readonly kind: 'stale'; readonly missingId: string };

const NONE: TabDropResolution = { kind: 'none' };

function hasSameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Order after dropping `sourceId` on `edge` of `targetId`. `stale` means the
 * drag outlived one of its tabs (closed mid-drag): the caller logs it and
 * changes nothing rather than guessing an order.
 */
export function resolveTabDropOrder({
  edge,
  orderedIds,
  sourceId,
  targetId,
}: {
  readonly edge: TabEdge;
  readonly orderedIds: readonly string[];
  readonly sourceId: string;
  readonly targetId: string;
}): TabDropResolution {
  for (const id of [sourceId, targetId]) {
    if (!orderedIds.includes(id)) {
      return { kind: 'stale', missingId: id };
    }
  }
  if (sourceId === targetId) {
    return NONE;
  }
  const remaining = orderedIds.filter((id) => id !== sourceId);
  const targetIndex = remaining.indexOf(targetId);
  const insertIndex = edge === 'left' ? targetIndex : targetIndex + 1;
  const next = [...remaining.slice(0, insertIndex), sourceId, ...remaining.slice(insertIndex)];
  return hasSameOrder(orderedIds, next) ? NONE : { kind: 'reorder', orderedIds: next };
}

/** APG: after Delete, focus the next tab, else the previous one. */
export function resolveFocusAfterClose(orderedIds: readonly string[], closedId: string): string | null {
  const index = orderedIds.indexOf(closedId);
  if (index === -1) {
    return null;
  }
  return orderedIds[index + 1] ?? orderedIds[index - 1] ?? null;
}

/** APG roving focus: arrows wrap, Home/End jump; any other key returns null. */
export function resolveRovingTargetIndex(
  key: string,
  currentIndex: number,
  count: number
): number | null {
  if (count === 0) {
    return null;
  }
  switch (key) {
    case 'ArrowLeft':
      return currentIndex <= 0 ? count - 1 : currentIndex - 1;
    case 'ArrowRight':
      return currentIndex === -1 || currentIndex >= count - 1 ? 0 : currentIndex + 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Create `packages/ui/src/tab-strip/tab-strip-tokens.ts`**

```ts
/**
 * Tab-strip geometry and state tokens (BST-1836 spec §5). Literal class strings
 * on purpose: Tailwind emits only classes its scanner sees in source text, so a
 * runtime-composed class produces no CSS. Painted values are pinned by
 * `__tests__/tab-strip.browser.test.tsx`, which runs with real Tailwind.
 */

/** Row container; `@container/tab-strip` drives the pinned-label collapse. */
export const TAB_STRIP_ROOT_CLASS_NAME = '@container/tab-strip flex min-w-0 items-center gap-1 px-1.5';
/** Standalone strips own their 36px row, hairline and surface. */
export const TAB_STRIP_STANDALONE_CLASS_NAME = 'h-9 shrink-0 border-border border-b bg-muted/30';
/** Embedded strips fill a host header (IdeLayout) that already owns row, hairline and surface. */
export const TAB_STRIP_EMBEDDED_CLASS_NAME = 'h-full flex-1';
/** Scroller: no visible scrollbar; scroll padding keeps a revealed tab clear of the 24px fades. */
export const TAB_STRIP_SCROLLER_CLASS_NAME =
  'flex h-full min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden scroll-px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';
export const TAB_STRIP_GROUP_SEPARATOR_CLASS_NAME = 'mx-0.5 h-4 w-px shrink-0 bg-border';
/** Strip chrome buttons (New, All tabs); pair with `Button size="icon-xs"` (28px). */
export const TAB_STRIP_ICON_BUTTON_CLASS_NAME = 'shrink-0 text-muted-foreground hover:text-foreground';

/** Tab shell: 28px pill, 6px radius; the inset focus ring follows the tab button. */
export const TAB_SHELL_CLASS_NAME =
  'group/tab relative flex h-7 items-center rounded-md transition-[color,background-color,box-shadow,opacity] duration-150 motion-reduce:transition-none has-[[role=tab]:focus-visible]:ring-2 has-[[role=tab]:focus-visible]:ring-ring has-[[role=tab]:focus-visible]:ring-inset';
export const TAB_SHELL_SCROLL_WIDTH_CLASS_NAME = 'min-w-24 max-w-56 shrink-0';
export const TAB_SHELL_PINNED_WIDTH_CLASS_NAME = 'shrink-0';
/** Neutral selected = the segmented control's raised surface (one selection language). */
export const TAB_SELECTED_CLASS_NAME = 'bg-background text-foreground shadow-xs ring-1 ring-border/70';
export const TAB_IDLE_CLASS_NAME = 'text-muted-foreground hover:bg-muted/60 hover:text-foreground';
/** Identity-tinted tabs take their fill from the consumer's appearance classes. */
export const TAB_SELECTED_TINTED_CLASS_NAME = 'text-foreground';
export const TAB_IDLE_TINTED_CLASS_NAME = 'text-muted-foreground hover:text-foreground';
export const TAB_DRAGGING_CLASS_NAME = 'opacity-45';

/** State never changes weight (no width jitter): 12/16 medium everywhere. */
export const TAB_TRIGGER_CLASS_NAME =
  'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pr-1 pl-2 text-left font-medium text-xs leading-4 outline-hidden';
export const TAB_TRIGGER_NO_CLOSE_CLASS_NAME = 'pr-2';
export const TAB_TRIGGER_REORDERABLE_CLASS_NAME = 'cursor-grab active:cursor-grabbing';
export const TAB_LABEL_CLASS_NAME = 'min-w-0 truncate';
export const TAB_PINNED_LABEL_CLASS_NAME = '@max-[520px]/tab-strip:sr-only';
export const TAB_DELETED_LABEL_CLASS_NAME = 'line-through';
export const TAB_ICON_CLASS_NAME = 'size-3.5 shrink-0';

/** 20px close slot with a 28px hit area; visibility changes opacity only, so space is reserved. */
export const TAB_CLOSE_CLASS_NAME =
  "relative mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity duration-150 after:absolute after:-inset-1 after:content-[''] hover:bg-foreground/10 hover:text-foreground motion-reduce:transition-none";
export const TAB_CLOSE_IDLE_VISIBILITY_CLASS_NAME =
  'pointer-events-none opacity-0 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100';
export const TAB_CLOSE_ACTIVE_VISIBILITY_CLASS_NAME = 'opacity-70 hover:opacity-100';
/** Drop indicator sits INSIDE the target's own box, so it needs no z-index. */
export const TAB_DROP_INDICATOR_CLASS_NAME = 'pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary';

/** Edge fade width in px. Must stay below the scroller's `scroll-px-8` (32px). */
export const TAB_STRIP_FADE_WIDTH_PX = 24;
```

- [ ] **Step 5: Create `packages/ui/src/tab-strip/types.ts`**

```ts
import type { AnyContextAction, ContextTarget } from '@brainstrike/context-actions';
import type { ComponentType, CSSProperties, ReactNode } from 'react';

export type TabStatus = 'attention' | 'deleted' | 'error' | 'loading' | 'locked' | 'running';

/** Identity tint (threads, agents): the shape `getAssistantThreadColorSurface()` produces. */
export interface TabAppearance {
  readonly idleClassName: string;
  readonly selectedClassName: string;
  readonly style?: CSSProperties | undefined;
}

export interface TabStripItem {
  readonly appearance?: TabAppearance | undefined;
  /** Close is offered only when BOTH the strip has `onClose` and this is true. */
  readonly closable: boolean;
  readonly closeTestId?: string | undefined;
  /** Spread onto the role=tab button (consumer test hooks such as `data-app-id`). */
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string>> | undefined;
  readonly icon?: ComponentType<{ className?: string }> | undefined;
  readonly id: string;
  readonly label: string;
  /**
   * Identity mark (thread/agent). When present the strip does NOT draw
   * `status`: the mark owns its corner badge (thread-row-status-glyph); the
   * status still reaches the accessible name.
   */
  readonly mark?: ReactNode;
  readonly panelDomId: string;
  readonly status?: TabStatus | undefined;
  /** Overrides the default status text in the accessible name. */
  readonly statusLabel?: string | undefined;
  /** Stable, consumer-owned DOM id of the tab (keeps existing ids/test ids). */
  readonly tabDomId: string;
  readonly testId?: string | undefined;
  readonly tooltip?: string | undefined;
}

export interface TabStripContextMenu {
  readonly getStripTarget?: (() => ContextTarget | null) | undefined;
  readonly getTabTarget: (id: string) => ContextTarget | null;
  readonly localActions: readonly AnyContextAction[];
}

export interface TabStripProps {
  readonly activeId: string | null;
  /** The "All tabs" menu in the trailing region. Default true. */
  readonly allTabsMenu?: boolean | undefined;
  readonly 'aria-label': string;
  /** `standalone` owns a 36px bordered row; `embedded` fills a host header. */
  readonly chrome?: 'embedded' | 'standalone' | undefined;
  readonly contextMenu?: TabStripContextMenu | undefined;
  readonly items: readonly TabStripItem[];
  readonly leading?: ReactNode;
  readonly onActivate: (id: string) => void;
  /** Absent ⇒ no close affordance anywhere (✕, Delete, middle-click). */
  readonly onClose?: ((id: string) => void) | undefined;
  /** Adds "Close All" to the All-tabs menu. */
  readonly onCloseAll?: (() => void) | undefined;
  /** Absent ⇒ no drag-and-drop and no ⌥⇧ arrows. Receives the scroll group's new order. */
  readonly onReorder?: ((orderedIds: readonly string[]) => void) | undefined;
  /** Non-scrolling, never reorderable group rendered before `items`. */
  readonly pinnedItems?: readonly TabStripItem[] | undefined;
  readonly scrollTestId?: string | undefined;
  readonly testId?: string | undefined;
  readonly trailing?: ReactNode;
}
```

- [ ] **Step 6: Create `packages/ui/src/tab-strip/tab-status.tsx`**

```tsx
import { AlertCircle, CircleDot, Loader2, LockKeyhole } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';
import { TAB_ICON_CLASS_NAME } from './tab-strip-tokens';
import type { TabStatus } from './types';

const DEFAULT_TAB_STATUS_LABELS: Readonly<Record<TabStatus, string>> = {
  attention: 'needs your input',
  deleted: 'deleted',
  error: 'error',
  loading: 'loading',
  locked: 'needs permission',
  running: 'running',
};

export function resolveTabStatusLabel(status: TabStatus, override?: string): string {
  return override ?? DEFAULT_TAB_STATUS_LABELS[status];
}

/** Status replaces a plain icon; colour is never the only cue (text rides in the name). */
export function TabStatusIcon({ status }: { readonly status: TabStatus }): ReactElement {
  switch (status) {
    case 'running':
    case 'loading':
      return (
        <Loader2
          aria-hidden="true"
          className={cn(TAB_ICON_CLASS_NAME, 'animate-spin motion-reduce:animate-none')}
          data-tab-status={status}
        />
      );
    case 'attention':
      return (
        <CircleDot
          aria-hidden="true"
          className={cn(TAB_ICON_CLASS_NAME, 'text-amber-500')}
          data-tab-status={status}
        />
      );
    case 'locked':
      return (
        <LockKeyhole
          aria-hidden="true"
          className={cn(TAB_ICON_CLASS_NAME, 'text-amber-500')}
          data-tab-status={status}
        />
      );
    case 'error':
    case 'deleted':
      return (
        <AlertCircle
          aria-hidden="true"
          className={cn(TAB_ICON_CLASS_NAME, 'text-destructive')}
          data-tab-status={status}
        />
      );
  }
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/tab-strip/__tests__/tab-strip-order.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/tab-strip
git commit -m "feat(BST-1837): tab-strip tokens, types, ordering helpers and status icon"
```

---

### Task 3: `TabPanelBoundary`

**Files:**
- Create: `packages/ui/src/tab-strip/tab-panel-boundary.tsx`
- Test: `packages/ui/src/tab-strip/__tests__/tab-panel-boundary.test.tsx`

**Interfaces:**
- Produces `TabPanelBoundary` (a class component) with props `{ children; label: string; layout?: 'inline' | 'panel'; resetKey?: string }`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/ui/src/tab-strip/__tests__/tab-panel-boundary.test.tsx
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabPanelBoundary } from '../tab-panel-boundary';

let shouldThrow = true;
function Flaky({ name }: { readonly name: string }) {
  if (shouldThrow) {
    throw new Error(`${name} exploded`);
  }
  return <p>{name} content</p>;
}

describe('TabPanelBoundary', () => {
  let records: LogRecord[] = [];
  let removeListener: () => void = () => undefined;
  beforeEach(() => {
    shouldThrow = true;
    records = [];
    removeListener = addLogListener((record) => records.push(record));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    removeListener();
    vi.restoreAllMocks();
  });

  it('contains a render crash to the panel and keeps siblings alive', () => {
    render(
      <div>
        <TabPanelBoundary label="Changes">
          <Flaky name="Changes" />
        </TabPanelBoundary>
        <button type="button">Sibling</button>
      </div>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Changes stopped working');
    expect(screen.getByRole('alert')).toHaveTextContent('Changes exploded');
    expect(screen.getByRole('button', { name: 'Sibling' })).toBeEnabled();
    expect(records.some((record) => record.message === 'Tab panel crashed')).toBe(true);
  });

  it('remounts the subtree when "Reload tab" is pressed', () => {
    render(
      <TabPanelBoundary label="Canvas">
        <Flaky name="Canvas" />
      </TabPanelBoundary>
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reload tab' }));
    expect(screen.getByText('Canvas content')).toBeInTheDocument();
  });

  it('clears the error when resetKey changes', () => {
    function Host() {
      const [key, setKey] = useState('one');
      return (
        <>
          <button onClick={() => setKey('two')} type="button">
            Switch
          </button>
          <TabPanelBoundary label="Panel" resetKey={key}>
            <Flaky name="Panel" />
          </TabPanelBoundary>
        </>
      );
    }
    render(<Host />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    expect(screen.getByText('Panel content')).toBeInTheDocument();
  });

  it('renders a one-row fallback in inline layout', () => {
    render(
      <TabPanelBoundary label="Tabs" layout="inline">
        <Flaky name="Tabs" />
      </TabPanelBoundary>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Tabs unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/tab-strip/__tests__/tab-panel-boundary.test.tsx`
Expected: FAIL, because the import cannot be resolved.

Also confirm `addLogListener` and `LogRecord` are exported from `@brainstrike/logging`. `action-context-menu.test.tsx` imports them already, so they should be. If `LogRecord` names the message field differently from `message`, check `packages/logging/src` and use that field name.

- [ ] **Step 3: Implement `packages/ui/src/tab-strip/tab-panel-boundary.tsx`**

```tsx
import { createLogger } from '@brainstrike/logging';
import { AlertTriangle, Copy, RotateCw } from 'lucide-react';
import { Component, type ErrorInfo, Fragment, type ReactElement, type ReactNode } from 'react';
import { Button } from '../button';
import { toast } from '../use-toast';

const logger = createLogger('TabPanelBoundary');

export interface TabPanelBoundaryProps {
  readonly children: ReactNode;
  /** Human name of what the boundary guards: "Changes", "Tabs". */
  readonly label: string;
  /** `panel` fills a tab panel; `inline` fits one 36px strip row. */
  readonly layout?: 'inline' | 'panel' | undefined;
  /** Changing it (e.g. the tab id) clears a caught error and remounts the subtree. */
  readonly resetKey?: string | undefined;
}

interface TabPanelBoundaryState {
  readonly componentStack: string | null;
  readonly error: Error | null;
  readonly generation: number;
}

function formatCrashDetails(label: string, error: Error, componentStack: string | null): string {
  return [`${label}: ${error.name}: ${error.message}`, error.stack ?? '', componentStack ?? '']
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/**
 * Per-panel error boundary (BST-1836 §7.3). A render crash in one tab panel is
 * contained to that panel, so siblings and the strip stay interactive, instead
 * of unmounting the React root. Class-only because React has no hook
 * equivalent. Event-handler and async errors are NOT caught here; they surface
 * through ActionOutcome toasts and logs.
 */
export class TabPanelBoundary extends Component<TabPanelBoundaryProps, TabPanelBoundaryState> {
  override state: TabPanelBoundaryState = { componentStack: null, error: null, generation: 0 };

  static getDerivedStateFromError(error: Error): Partial<TabPanelBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error(
      'Tab panel crashed',
      { componentStack: info.componentStack, label: this.props.label },
      error
    );
    this.setState({ componentStack: info.componentStack ?? null });
  }

  override componentDidUpdate(previous: TabPanelBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.reload();
    }
  }

  private readonly reload = (): void => {
    this.setState((current) => ({
      componentStack: null,
      error: null,
      generation: current.generation + 1,
    }));
  };

  override render(): ReactNode {
    const { componentStack, error, generation } = this.state;
    if (error === null) {
      return <Fragment key={generation}>{this.props.children}</Fragment>;
    }
    return (
      <TabPanelFallback
        componentStack={componentStack}
        error={error}
        label={this.props.label}
        layout={this.props.layout ?? 'panel'}
        onReload={this.reload}
      />
    );
  }
}

function TabPanelFallback({
  componentStack,
  error,
  label,
  layout,
  onReload,
}: {
  readonly componentStack: string | null;
  readonly error: Error;
  readonly label: string;
  readonly layout: 'inline' | 'panel';
  readonly onReload: () => void;
}): ReactElement {
  // Capability gate: a missing clipboard hides the button, never a dead one.
  const canCopy = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
  const copyDetails = (): void => {
    navigator.clipboard.writeText(formatCrashDetails(label, error, componentStack)).then(
      () => toast({ description: 'Crash details copied' }),
      (copyError: unknown) => {
        logger.error('Copying tab crash details failed', { label }, copyError);
        toast({ description: 'Could not copy crash details', title: 'Copy failed', variant: 'destructive' });
      }
    );
  };

  if (layout === 'inline') {
    return (
      <div
        className="flex h-9 min-w-0 flex-1 items-center gap-2 px-2 text-muted-foreground text-xs"
        data-layout="inline"
        data-slot="tab-panel-boundary"
        role="alert"
      >
        <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 truncate">{label} unavailable</span>
        <Button onClick={onReload} size="xs" type="button" variant="ghost">
          <RotateCw aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center"
      data-layout="panel"
      data-slot="tab-panel-boundary"
      role="alert"
    >
      <AlertTriangle aria-hidden="true" className="size-5 text-destructive" />
      <p className="font-medium text-sm">{label} stopped working</p>
      <p className="max-w-sm break-words text-muted-foreground text-xs">{error.message}</p>
      <div className="flex items-center gap-2">
        <Button onClick={onReload} size="sm" type="button" variant="outline">
          <RotateCw aria-hidden="true" />
          Reload tab
        </Button>
        {canCopy ? (
          <Button onClick={copyDetails} size="sm" type="button" variant="ghost">
            <Copy aria-hidden="true" />
            Copy details
          </Button>
        ) : null}
      </div>
    </div>
  );
}
```

`logger.error(message, context, error)` is the signature `error-boundary.tsx` uses. If `createLogger` in this package types `context` differently, follow `packages/ui/src/error-boundary.tsx`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/tab-strip/__tests__/tab-panel-boundary.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/tab-strip
git commit -m "feat(BST-1837): TabPanelBoundary contains tab-panel render crashes"
```

---

### Task 4: Overflow hook with native wheel mapping

**Files:**
- Create: `packages/ui/src/tab-strip/use-tab-strip-overflow.ts`
- Test: `packages/ui/src/tab-strip/__tests__/use-tab-strip-overflow.test.tsx`

**Interfaces:**
- Produces:
  - `useTabStripOverflow(scrollRef, contentKey: string): TabStripOverflow`
  - `readTabStripOverflow(el)`
  - `tabStripOverflowMaskStyle(overflow): CSSProperties | undefined`
  - `TabStripOverflow = { start: boolean; end: boolean }`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/ui/src/tab-strip/__tests__/use-tab-strip-overflow.test.tsx
import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import {
  readTabStripOverflow,
  tabStripOverflowMaskStyle,
  useTabStripOverflow,
} from '../use-tab-strip-overflow';

function setGeometry(element: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth });
}

function Probe({ contentKey }: { readonly contentKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const overflow = useTabStripOverflow(ref, contentKey);
  return (
    <div
      data-end={String(overflow.end)}
      data-start={String(overflow.start)}
      data-testid="scroller"
      ref={ref}
    />
  );
}

describe('readTabStripOverflow', () => {
  it('reports each overflowing edge with a 1px tolerance', () => {
    const element = document.createElement('div');
    setGeometry(element, 500, 200);
    element.scrollLeft = 0;
    expect(readTabStripOverflow(element)).toEqual({ end: true, start: false });
    element.scrollLeft = 150;
    expect(readTabStripOverflow(element)).toEqual({ end: true, start: true });
    element.scrollLeft = 300;
    expect(readTabStripOverflow(element)).toEqual({ end: false, start: true });
  });
});

describe('tabStripOverflowMaskStyle', () => {
  it('fades only the overflowing edges and nothing when nothing overflows', () => {
    expect(tabStripOverflowMaskStyle({ end: false, start: false })).toBeUndefined();
    expect(tabStripOverflowMaskStyle({ end: true, start: false })?.maskImage).toBe(
      'linear-gradient(to right, #000 0, #000 calc(100% - 24px), transparent 100%)'
    );
    expect(tabStripOverflowMaskStyle({ end: false, start: true })?.maskImage).toBe(
      'linear-gradient(to right, transparent 0, #000 24px, #000 100%)'
    );
  });
});

describe('useTabStripOverflow', () => {
  it('re-measures on scroll', () => {
    const view = render(<Probe contentKey="a" />);
    const scroller = screen.getByTestId('scroller');
    setGeometry(scroller, 500, 200);
    view.rerender(<Probe contentKey="b" />);
    expect(scroller).toHaveAttribute('data-end', 'true');
    act(() => {
      scroller.scrollLeft = 300;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(scroller).toHaveAttribute('data-start', 'true');
    expect(scroller).toHaveAttribute('data-end', 'false');
  });

  it('maps vertical wheel input to horizontal scroll and consumes it only when it moves', () => {
    render(<Probe contentKey="a" />);
    const scroller = screen.getByTestId('scroller');
    setGeometry(scroller, 500, 200);
    scroller.scrollLeft = 0;
    const down = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    act(() => {
      scroller.dispatchEvent(down);
    });
    expect(scroller.scrollLeft).toBe(120);
    expect(down.defaultPrevented).toBe(true);

    scroller.scrollLeft = 300;
    const pastEnd = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 50 });
    act(() => {
      scroller.dispatchEvent(pastEnd);
    });
    expect(scroller.scrollLeft).toBe(300);
    expect(pastEnd.defaultPrevented).toBe(false);
  });

  it('leaves wheel input alone when nothing overflows', () => {
    render(<Probe contentKey="a" />);
    const scroller = screen.getByTestId('scroller');
    setGeometry(scroller, 200, 200);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    act(() => {
      scroller.dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/tab-strip/__tests__/use-tab-strip-overflow.test.tsx`
Expected: FAIL, because the import cannot be resolved.

- [ ] **Step 3: Implement `packages/ui/src/tab-strip/use-tab-strip-overflow.ts`**

```ts
import { type CSSProperties, type RefObject, useCallback, useEffect, useState } from 'react';
import { TAB_STRIP_FADE_WIDTH_PX } from './tab-strip-tokens';

export interface TabStripOverflow {
  readonly end: boolean;
  readonly start: boolean;
}

const NO_OVERFLOW: TabStripOverflow = { end: false, start: false };
/** `WheelEvent.DOM_DELTA_LINE`; Firefox reports line deltas for mouse wheels. */
const DOM_DELTA_LINE = 1;
const LINE_HEIGHT_PX = 16;

export function readTabStripOverflow(element: HTMLElement): TabStripOverflow {
  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  return { end: element.scrollLeft < maxScrollLeft - 1, start: element.scrollLeft > 1 };
}

/** Inline mask so the fades work in every browser without scroll-driven animations. */
export function tabStripOverflowMaskStyle(overflow: TabStripOverflow): CSSProperties | undefined {
  if (!(overflow.start || overflow.end)) {
    return undefined;
  }
  const fade = `${TAB_STRIP_FADE_WIDTH_PX}px`;
  const start = overflow.start ? `transparent 0, #000 ${fade}` : '#000 0';
  const end = overflow.end ? `#000 calc(100% - ${fade}), transparent 100%` : '#000 100%';
  const image = `linear-gradient(to right, ${start}, ${end})`;
  return { maskImage: image, WebkitMaskImage: image };
}

/**
 * Overflow flags plus wheel→horizontal mapping for the strip scroller. The
 * wheel listener is NATIVE and non-passive: React registers `onWheel` as a
 * passive root listener, so `preventDefault` inside it is ignored.
 */
export function useTabStripOverflow(
  scrollRef: RefObject<HTMLElement | null>,
  contentKey: string
): TabStripOverflow {
  const [overflow, setOverflow] = useState<TabStripOverflow>(NO_OVERFLOW);

  const measure = useCallback((): void => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const next = readTabStripOverflow(element);
    setOverflow((current) =>
      current.start === next.start && current.end === next.end ? current : next
    );
  }, [scrollRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: contentKey is the re-measure trigger when tabs are added or removed
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    // Every supported browser and Electron has ResizeObserver; the guard only
    // covers unit-test DOM shims that omit it.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.firstElementChild) {
      observer?.observe(element.firstElementChild);
    }
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [contentKey, measure, scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const handleWheel = (event: WheelEvent): void => {
      const maxScrollLeft = element.scrollWidth - element.clientWidth;
      if (maxScrollLeft <= 0) {
        return;
      }
      const raw = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const delta = event.deltaMode === DOM_DELTA_LINE ? raw * LINE_HEIGHT_PX : raw;
      if (delta === 0) {
        return;
      }
      const next = Math.min(maxScrollLeft, Math.max(0, element.scrollLeft + delta));
      if (next === element.scrollLeft) {
        return;
      }
      event.preventDefault();
      element.scrollLeft = next;
      measure();
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [measure, scrollRef]);

  return overflow;
}
```

If Biome reports the `biome-ignore` comment as unused (the rule may not fire because `contentKey` is listed), delete that comment line.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/tab-strip/__tests__/use-tab-strip-overflow.test.tsx`
Expected: PASS (5 tests). If happy-dom ignores writes to `scrollLeft`, define it in `setGeometry` as a writable data property: `Object.defineProperty(element, 'scrollLeft', { configurable: true, writable: true, value: 0 })`. Leave the implementation unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/tab-strip
git commit -m "feat(BST-1837): tab-strip overflow flags, edge fades and native wheel mapping"
```

---

### Task 5: Reorder hooks (pragmatic-dnd moves into `ui`) and `TabStripTab`

**Files:**
- Modify: `packages/ui/package.json`. Add to `dependencies`: `"@atlaskit/pragmatic-drag-and-drop": "^3.1.0"`, `"@atlaskit/pragmatic-drag-and-drop-auto-scroll": "^3.2.0"`, `"@atlaskit/pragmatic-drag-and-drop-hitbox": "^2.2.0"`. Then run `pnpm install`.
- Create: `packages/ui/src/tab-strip/tab-strip-reorder.ts`, `packages/ui/src/tab-strip/tab-strip-tab.tsx`
- Test: `packages/ui/src/tab-strip/__tests__/tab-strip-tab.test.tsx`

**Interfaces:**
- Produces:
  - `useTabReorderInstanceId(enabled: boolean): string | null`
  - `useTabReorderItem({ handleRef, id, instanceId, shellRef }): { closestEdge: TabEdge | null; isDragging: boolean }`
  - `useTabStripReorderMonitor({ instanceId, onReorder, orderedIds, scrollRef }): void`
  - `TabStripTab` (memo) with the props shown below
  - `areTabStripItemsEqual(a, b)`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/ui/src/tab-strip/__tests__/tab-strip-tab.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { File } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { areTabStripItemsEqual, TabStripTab, type TabStripTabProps } from '../tab-strip-tab';
import type { TabStripItem } from '../types';

const baseItem: TabStripItem = {
  closable: true,
  icon: File,
  id: 'gamma',
  label: 'gamma.md',
  panelDomId: 'panel-gamma',
  tabDomId: 'tab-gamma',
};

function renderTab(overrides: Partial<TabStripTabProps> = {}) {
  const props: TabStripTabProps = {
    group: 'scroll',
    hasContextMenu: false,
    isActive: false,
    isTabStop: false,
    item: baseItem,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onContextMenu: vi.fn(),
    reorderInstanceId: null,
    ...overrides,
  };
  const view = render(
    <div role="tablist">
      <TabStripTab {...props} />
    </div>
  );
  return { ...view, props };
}

describe('TabStripTab', () => {
  it('renders an APG tab wired to its panel', () => {
    renderTab({ isActive: true, isTabStop: true });
    const tab = screen.getByRole('tab', { name: 'gamma.md' });
    expect(tab).toHaveAttribute('id', 'tab-gamma');
    expect(tab).toHaveAttribute('aria-controls', 'panel-gamma');
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toHaveAttribute('tabindex', '0');
    expect(tab).toHaveAttribute('aria-keyshortcuts', 'Delete');
  });

  it('keeps the close control out of the accessibility tree and the tab order', () => {
    const { container, props } = renderTab();
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
    const close = container.querySelector<HTMLButtonElement>('[data-slot="tab-close"]');
    expect(close).toHaveAttribute('aria-hidden', 'true');
    expect(close).toHaveAttribute('tabindex', '-1');
    fireEvent.click(close as HTMLButtonElement);
    expect(props.onClose).toHaveBeenCalledWith('gamma');
    expect(props.onActivate).not.toHaveBeenCalled();
  });

  it('activates on click and closes on middle-click', () => {
    const { container, props } = renderTab();
    fireEvent.click(screen.getByRole('tab'));
    expect(props.onActivate).toHaveBeenCalledWith('gamma');
    const shell = container.querySelector('[data-slot="tab-shell"]') as HTMLElement;
    fireEvent(shell, new MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true }));
    expect(props.onClose).toHaveBeenCalledWith('gamma');
  });

  it('offers no close affordance when the item or the strip cannot close', () => {
    const nonClosable = renderTab({ item: { ...baseItem, closable: false } });
    expect(nonClosable.container.querySelector('[data-slot="tab-close"]')).toBeNull();
    expect(screen.getByRole('tab')).not.toHaveAttribute('aria-keyshortcuts');
    nonClosable.unmount();
    const noStripClose = renderTab({ onClose: null });
    expect(noStripClose.container.querySelector('[data-slot="tab-close"]')).toBeNull();
  });

  it('puts status text in the accessible name and swaps the icon for the status icon', () => {
    const { container } = renderTab({ item: { ...baseItem, status: 'deleted' } });
    expect(screen.getByRole('tab', { name: 'gamma.md, deleted' })).toBeInTheDocument();
    expect(container.querySelector('[data-tab-status="deleted"]')).not.toBeNull();
  });

  it('lets an identity mark own its badge while the status still reaches the name', () => {
    const { container } = renderTab({
      item: { ...baseItem, mark: <span data-testid="mark" />, status: 'running' },
    });
    expect(screen.getByTestId('mark')).toBeInTheDocument();
    expect(container.querySelector('[data-tab-status]')).toBeNull();
    expect(screen.getByRole('tab', { name: 'gamma.md, running' })).toBeInTheDocument();
  });

  it('applies the neutral raised surface when selected and identity tints when provided', () => {
    const neutral = renderTab({ isActive: true });
    const shell = neutral.container.querySelector('[data-slot="tab-shell"]');
    expect(shell).toHaveClass('bg-background', 'shadow-xs', 'ring-1');
    neutral.unmount();
    const tinted = renderTab({
      isActive: true,
      item: { ...baseItem, appearance: { idleClassName: 'bg-tint-idle', selectedClassName: 'bg-tint-on' } },
    });
    const tintedShell = tinted.container.querySelector('[data-slot="tab-shell"]');
    expect(tintedShell).toHaveClass('bg-tint-on');
    expect(tintedShell).not.toHaveClass('bg-background');
  });

  it('advertises its context menu only when the strip has one', () => {
    renderTab({ hasContextMenu: true });
    expect(screen.getByRole('tab')).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('spreads consumer data attributes onto the tab button', () => {
    renderTab({ item: { ...baseItem, dataAttributes: { 'data-app-id': 'changes' } } });
    expect(screen.getByRole('tab')).toHaveAttribute('data-app-id', 'changes');
  });
});

describe('areTabStripItemsEqual', () => {
  it('treats value-equal items as equal and any field change as a change', () => {
    expect(areTabStripItemsEqual(baseItem, { ...baseItem })).toBe(true);
    expect(areTabStripItemsEqual(baseItem, { ...baseItem, label: 'other' })).toBe(false);
    expect(areTabStripItemsEqual(baseItem, { ...baseItem, status: 'loading' })).toBe(false);
    expect(
      areTabStripItemsEqual(
        { ...baseItem, dataAttributes: { 'data-x': '1' } },
        { ...baseItem, dataAttributes: { 'data-x': '1' } }
      )
    ).toBe(true);
    expect(
      areTabStripItemsEqual(
        { ...baseItem, appearance: { idleClassName: 'a', selectedClassName: 'b' } },
        { ...baseItem, appearance: { idleClassName: 'a', selectedClassName: 'c' } }
      )
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/tab-strip/__tests__/tab-strip-tab.test.tsx`
Expected: FAIL, because the import cannot be resolved.

- [ ] **Step 3: Add the dependencies.** Add the three `@atlaskit/*` entries above to the `dependencies` block of `packages/ui/package.json`, keeping keys in alphabetical order. Then run from the repo root:

Run: `pnpm install --prefer-offline`, then `pnpm exec node -v` to let any parallel reinstall settle.
Expected: the lockfile gains `packages/ui` importer entries resolving to the SAME versions app-shell resolves (3.1.0 / 3.2.0 / 2.2.0).

- [ ] **Step 4: Implement `packages/ui/src/tab-strip/tab-strip-reorder.ts`**

```ts
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import {
  attachClosestEdge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { useEventCallback } from '@brainstrike/hooks';
import { createLogger } from '@brainstrike/logging';
import { type RefObject, useEffect, useId, useState } from 'react';
import { resolveTabDropOrder, type TabEdge } from './tab-strip-order';

const logger = createLogger('TabStripReorder');
const TAB_REORDER_KEY = Symbol('tab-strip-reorder');

interface TabReorderData {
  readonly id: string;
  readonly instanceId: string;
}

type DragRecord = Record<string | symbol, unknown>;

function makeReorderData(instanceId: string, id: string): DragRecord {
  const data: TabReorderData = { id, instanceId };
  return { [TAB_REORDER_KEY]: data };
}

function readReorderData(data: DragRecord): TabReorderData | null {
  const value = data[TAB_REORDER_KEY];
  if (!(value && typeof value === 'object')) {
    return null;
  }
  if (!('id' in value && typeof value.id === 'string')) {
    return null;
  }
  if (!('instanceId' in value && typeof value.instanceId === 'string')) {
    return null;
  }
  return { id: value.id, instanceId: value.instanceId };
}

function toEdge(value: ReturnType<typeof extractClosestEdge>): TabEdge | null {
  return value === 'left' || value === 'right' ? value : null;
}

/** Strip-scoped drag identity: a drag from one strip is never a drop for another. */
export function useTabReorderInstanceId(enabled: boolean): string | null {
  const instanceId = useId();
  return enabled ? instanceId : null;
}

export function useTabReorderItem({
  handleRef,
  id,
  instanceId,
  shellRef,
}: {
  readonly handleRef: RefObject<HTMLElement | null>;
  readonly id: string;
  readonly instanceId: string | null;
  readonly shellRef: RefObject<HTMLElement | null>;
}): { readonly closestEdge: TabEdge | null; readonly isDragging: boolean } {
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<TabEdge | null>(null);

  useEffect(() => {
    const element = shellRef.current;
    const dragHandle = handleRef.current;
    if (!(instanceId && element && dragHandle)) {
      return;
    }
    return combine(
      draggable({
        dragHandle,
        element,
        getInitialData: () => makeReorderData(instanceId, id),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        canDrop: ({ source }) => readReorderData(source.data)?.instanceId === instanceId,
        element,
        getData: ({ element: target, input }) =>
          attachClosestEdge(makeReorderData(instanceId, id), {
            allowedEdges: ['left', 'right'],
            element: target,
            input,
          }),
        onDrag: ({ self, source }) => {
          setClosestEdge(
            readReorderData(source.data)?.id === id ? null : toEdge(extractClosestEdge(self.data))
          );
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      })
    );
  }, [handleRef, id, instanceId, shellRef]);

  return { closestEdge, isDragging };
}

export function useTabStripReorderMonitor({
  instanceId,
  onReorder,
  orderedIds,
  scrollRef,
}: {
  readonly instanceId: string | null;
  readonly onReorder: ((orderedIds: readonly string[]) => void) | undefined;
  readonly orderedIds: readonly string[];
  readonly scrollRef: RefObject<HTMLElement | null>;
}): void {
  const handleDrop = useEventCallback((sourceId: string, targetId: string, edge: TabEdge): void => {
    const resolution = resolveTabDropOrder({ edge, orderedIds, sourceId, targetId });
    if (resolution.kind === 'stale') {
      logger.warn('Ignored a tab drop whose tab is no longer open', {
        missingId: resolution.missingId,
      });
      return;
    }
    if (resolution.kind === 'reorder') {
      onReorder?.(resolution.orderedIds);
    }
  });

  useEffect(() => {
    if (!instanceId) {
      return;
    }
    return monitorForElements({
      canMonitor: ({ source }) => readReorderData(source.data)?.instanceId === instanceId,
      onDrop: ({ location, source }) => {
        const sourceData = readReorderData(source.data);
        const target = location.current.dropTargets[0];
        if (!(sourceData && target)) {
          return;
        }
        const targetData = readReorderData(target.data);
        const edge = toEdge(extractClosestEdge(target.data));
        if (!(targetData && edge)) {
          return;
        }
        handleDrop(sourceData.id, targetData.id, edge);
      },
    });
  }, [handleDrop, instanceId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!(instanceId && element)) {
      return;
    }
    return autoScrollForElements({
      canScroll: ({ source }) => readReorderData(source.data)?.instanceId === instanceId,
      element,
      getAllowedAxis: () => 'horizontal',
    });
  }, [instanceId, scrollRef]);
}
```

Before relying on these names, confirm that `createLogger(...).warn` exists (`grep -n "warn" packages/logging/src/*.ts`) and that `AllowedAxis` accepts `'horizontal'` (the installed `@atlaskit/pragmatic-drag-and-drop-auto-scroll` `internal-types.d.ts`: `AllowedAxis = Axis | 'all'`). If `Axis` is spelled differently there, use its literal.

- [ ] **Step 5: Implement `packages/ui/src/tab-strip/tab-strip-tab.tsx`**

```tsx
import { X } from 'lucide-react';
import { memo, type MouseEvent, type ReactElement, type ReactNode, useRef } from 'react';
import { cn } from '../lib/utils';
import { resolveTabStatusLabel, TabStatusIcon } from './tab-status';
import { useTabReorderItem } from './tab-strip-reorder';
import {
  TAB_CLOSE_ACTIVE_VISIBILITY_CLASS_NAME,
  TAB_CLOSE_CLASS_NAME,
  TAB_CLOSE_IDLE_VISIBILITY_CLASS_NAME,
  TAB_DELETED_LABEL_CLASS_NAME,
  TAB_DRAGGING_CLASS_NAME,
  TAB_DROP_INDICATOR_CLASS_NAME,
  TAB_ICON_CLASS_NAME,
  TAB_IDLE_CLASS_NAME,
  TAB_IDLE_TINTED_CLASS_NAME,
  TAB_LABEL_CLASS_NAME,
  TAB_PINNED_LABEL_CLASS_NAME,
  TAB_SELECTED_CLASS_NAME,
  TAB_SELECTED_TINTED_CLASS_NAME,
  TAB_SHELL_CLASS_NAME,
  TAB_SHELL_PINNED_WIDTH_CLASS_NAME,
  TAB_SHELL_SCROLL_WIDTH_CLASS_NAME,
  TAB_TRIGGER_CLASS_NAME,
  TAB_TRIGGER_NO_CLOSE_CLASS_NAME,
  TAB_TRIGGER_REORDERABLE_CLASS_NAME,
} from './tab-strip-tokens';
import type { TabStripItem } from './types';

export type TabStripGroup = 'pinned' | 'scroll';

export interface TabStripTabProps {
  readonly group: TabStripGroup;
  readonly hasContextMenu: boolean;
  readonly isActive: boolean;
  readonly isTabStop: boolean;
  readonly item: TabStripItem;
  readonly onActivate: (id: string) => void;
  /** Null when the strip has no close capability; `item.closable` gates per tab. */
  readonly onClose: ((id: string) => void) | null;
  readonly onContextMenu: (id: string) => void;
  /** Strip-scoped drag identity; null when this tab is not reorderable. */
  readonly reorderInstanceId: string | null;
}

function TabLeading({ item }: { readonly item: TabStripItem }): ReactNode {
  if (item.mark) {
    return (
      <span className="relative flex shrink-0" data-slot="tab-mark">
        {item.mark}
      </span>
    );
  }
  if (item.status) {
    return <TabStatusIcon status={item.status} />;
  }
  if (item.icon) {
    const Icon = item.icon;
    return <Icon className={TAB_ICON_CLASS_NAME} />;
  }
  return null;
}

function resolveSurfaceClassName(item: TabStripItem, isActive: boolean): string {
  if (item.appearance) {
    return isActive
      ? cn(TAB_SELECTED_TINTED_CLASS_NAME, item.appearance.selectedClassName)
      : cn(TAB_IDLE_TINTED_CLASS_NAME, item.appearance.idleClassName);
  }
  return isActive ? TAB_SELECTED_CLASS_NAME : TAB_IDLE_CLASS_NAME;
}

function TabStripTabImpl({
  group,
  hasContextMenu,
  isActive,
  isTabStop,
  item,
  onActivate,
  onClose,
  onContextMenu,
  reorderInstanceId,
}: TabStripTabProps): ReactElement {
  const shellRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { closestEdge, isDragging } = useTabReorderItem({
    handleRef: triggerRef,
    id: item.id,
    instanceId: reorderInstanceId,
    shellRef,
  });
  const closeTab = item.closable ? onClose : null;
  const statusLabel = item.status ? resolveTabStatusLabel(item.status, item.statusLabel) : null;

  const handleAuxClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 1 || !closeTab) {
      return;
    }
    event.preventDefault();
    closeTab(item.id);
  };
  const handleMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    // A middle press starts platform autoscroll on Windows/Linux; auxclick closes instead.
    if (event.button === 1) {
      event.preventDefault();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: presentational tab shell; the role=tab button is the control, the shell only claims pointer gestures landing on its padding
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: see above
    <div
      className={cn(
        TAB_SHELL_CLASS_NAME,
        group === 'scroll' ? TAB_SHELL_SCROLL_WIDTH_CLASS_NAME : TAB_SHELL_PINNED_WIDTH_CLASS_NAME,
        resolveSurfaceClassName(item, isActive),
        isDragging && TAB_DRAGGING_CLASS_NAME
      )}
      data-dragging={isDragging ? 'true' : undefined}
      data-group={group}
      data-reorderable={reorderInstanceId ? 'true' : undefined}
      data-slot="tab-shell"
      data-state={isActive ? 'active' : 'inactive'}
      onAuxClick={handleAuxClick}
      onContextMenu={() => onContextMenu(item.id)}
      onMouseDown={handleMouseDown}
      ref={shellRef}
      role="presentation"
      style={item.appearance?.style}
    >
      {closestEdge ? (
        <span
          aria-hidden="true"
          className={cn(TAB_DROP_INDICATOR_CLASS_NAME, closestEdge === 'left' ? 'left-0' : 'right-0')}
          data-edge={closestEdge}
          data-slot="tab-drop-indicator"
        />
      ) : null}
      <button
        {...item.dataAttributes}
        aria-controls={item.panelDomId}
        aria-haspopup={hasContextMenu ? 'menu' : undefined}
        aria-keyshortcuts={closeTab ? 'Delete' : undefined}
        aria-label={statusLabel ? `${item.label}, ${statusLabel}` : undefined}
        aria-selected={isActive}
        className={cn(
          TAB_TRIGGER_CLASS_NAME,
          !closeTab && TAB_TRIGGER_NO_CLOSE_CLASS_NAME,
          reorderInstanceId && TAB_TRIGGER_REORDERABLE_CLASS_NAME
        )}
        data-strip-tab-id={item.id}
        data-testid={item.testId}
        id={item.tabDomId}
        onClick={() => onActivate(item.id)}
        ref={triggerRef}
        role="tab"
        tabIndex={isTabStop ? 0 : -1}
        title={item.tooltip ?? item.label}
        type="button"
      >
        <TabLeading item={item} />
        <span
          className={cn(
            TAB_LABEL_CLASS_NAME,
            group === 'pinned' && TAB_PINNED_LABEL_CLASS_NAME,
            item.status === 'deleted' && TAB_DELETED_LABEL_CLASS_NAME
          )}
        >
          {item.label}
        </span>
      </button>
      {closeTab ? (
        <button
          aria-hidden="true"
          aria-label={`Close ${item.label}`}
          className={cn(
            TAB_CLOSE_CLASS_NAME,
            isActive ? TAB_CLOSE_ACTIVE_VISIBILITY_CLASS_NAME : TAB_CLOSE_IDLE_VISIBILITY_CLASS_NAME
          )}
          data-slot="tab-close"
          data-testid={item.closeTestId}
          onClick={(event) => {
            event.stopPropagation();
            closeTab(item.id);
          }}
          onMouseDown={(event) => event.preventDefault()}
          tabIndex={-1}
          title={`Close ${item.label}`}
          type="button"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function areRecordsEqual(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!(left && right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length && leftKeys.every((key) => left[key] === right[key])
  );
}

/** Value equality over every rendered field, so consumers need not keep item objects stable. */
export function areTabStripItemsEqual(left: TabStripItem, right: TabStripItem): boolean {
  if (left === right) {
    return true;
  }
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.tabDomId === right.tabDomId &&
    left.panelDomId === right.panelDomId &&
    left.closable === right.closable &&
    left.icon === right.icon &&
    left.mark === right.mark &&
    left.status === right.status &&
    left.statusLabel === right.statusLabel &&
    left.tooltip === right.tooltip &&
    left.testId === right.testId &&
    left.closeTestId === right.closeTestId &&
    left.appearance?.idleClassName === right.appearance?.idleClassName &&
    left.appearance?.selectedClassName === right.appearance?.selectedClassName &&
    left.appearance?.style === right.appearance?.style &&
    areRecordsEqual(left.dataAttributes, right.dataAttributes)
  );
}

function areTabPropsEqual(previous: TabStripTabProps, next: TabStripTabProps): boolean {
  return (
    previous.group === next.group &&
    previous.hasContextMenu === next.hasContextMenu &&
    previous.isActive === next.isActive &&
    previous.isTabStop === next.isTabStop &&
    previous.onActivate === next.onActivate &&
    previous.onClose === next.onClose &&
    previous.onContextMenu === next.onContextMenu &&
    previous.reorderInstanceId === next.reorderInstanceId &&
    areTabStripItemsEqual(previous.item, next.item)
  );
}

export const TabStripTab = memo(TabStripTabImpl, areTabPropsEqual);
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/tab-strip/__tests__/tab-strip-tab.test.tsx`
Expected: PASS (10 tests).

Run: `pnpm test:scripts`. This includes `pragmatic-dnd-single-core`.
Expected: PASS, with one physical copy of pragmatic-dnd core.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/package.json pnpm-lock.yaml packages/ui/src/tab-strip
git commit -m "feat(BST-1837): memoized TabStripTab with mouse-only close and strip-scoped reorder"
```

---

### Task 6: Keyboard model, All-tabs menu and `TabStrip` composition

**Files:**
- Create: `packages/ui/src/tab-strip/tab-strip-keyboard.ts`, `tab-strip-all-tabs-menu.tsx`, `tab-strip.tsx`, `index.ts`
- Modify: `packages/ui/src/index.ts`. Add `export * from './tab-strip';` on the line after `export * from './tabs';`.
- Test: `packages/ui/src/tab-strip/__tests__/tab-strip.test.tsx`

**Interfaces:**
- Consumes Tasks 1–5.
- Produces `TabStrip(props: TabStripProps)`. Public surface in `tab-strip/index.ts`: `TabStrip`, `TabPanelBoundary`, `TabPanelBoundaryProps`, `TAB_STRIP_ICON_BUTTON_CLASS_NAME`, and the types `TabAppearance`, `TabStatus`, `TabStripContextMenu`, `TabStripItem`, `TabStripProps`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/ui/src/tab-strip/__tests__/tab-strip.test.tsx
import {
  type ActionOutcome,
  createTabStripActions,
  createTestActionRegistry,
  defineContextAction,
} from '@brainstrike/context-actions';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentType, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionRegistryProvider } from '../../context-menu';
import { TabStrip } from '../tab-strip';
import type { TabStripContextMenu, TabStripItem } from '../types';

const renderCounts = new Map<string, number>();
const iconCache = new Map<string, ComponentType<{ className?: string }>>();

/** Per-tab icon whose render count reveals which TabStripTab re-rendered. */
function countingIcon(id: string): ComponentType<{ className?: string }> {
  const cached = iconCache.get(id);
  if (cached) {
    return cached;
  }
  function CountingIcon({ className }: { className?: string }): ReactElement {
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    return <svg className={className} data-icon={id} />;
  }
  iconCache.set(id, CountingIcon);
  return CountingIcon;
}

function makeItem(id: string, overrides: Partial<TabStripItem> = {}): TabStripItem {
  return {
    closable: true,
    icon: countingIcon(id),
    id,
    label: `Tab ${id}`,
    panelDomId: `panel-${id}`,
    tabDomId: `tab-${id}`,
    ...overrides,
  };
}

interface HarnessProps {
  readonly initial: readonly string[];
  readonly onActivateSpy?: (id: string) => void;
  readonly onCloseAll?: () => void;
  readonly pinned?: readonly string[];
  readonly reorderable?: boolean;
  readonly withMenu?: boolean;
}

function Harness({
  initial,
  onActivateSpy,
  onCloseAll,
  pinned = [],
  reorderable = true,
  withMenu = false,
}: HarnessProps): ReactElement {
  const [order, setOrder] = useState<readonly string[]>(initial);
  const [activeId, setActiveId] = useState<string | null>(initial[0] ?? null);
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
  }, [order]);
  const items = useMemo(() => order.map((id) => makeItem(id)), [order]);
  const pinnedItems = useMemo(() => pinned.map((id) => makeItem(id, { closable: false })), [pinned]);
  const close = (id: string): void => setOrder((current) => current.filter((candidate) => candidate !== id));
  const contextMenu = useMemo<TabStripContextMenu | undefined>(() => {
    if (!withMenu) {
      return undefined;
    }
    return {
      getStripTarget: () => ({ kind: 'tab-strip', stripId: 'test' }),
      getTabTarget: (id) => ({ id, kind: 'assistant-thread-tab', resourceId: 'r', title: `Tab ${id}` }),
      localActions: [
        ...createTabStripActions({
          close: (id) => setOrder((current) => current.filter((candidate) => candidate !== id)),
          getId: (target) => target.id,
          getLabel: (target) => target.title,
          getOrderedIds: () => orderRef.current,
          idPrefix: 'test-tab',
          kind: 'assistant-thread-tab',
          noun: 'tab',
        }),
        defineContextAction({
          appliesTo: ['tab-strip'] as const,
          group: 'primary',
          id: 'test-strip.new',
          label: 'New Tab',
          run: (): Promise<ActionOutcome> => Promise.resolve({ ok: true }),
        }),
      ],
    };
  }, [withMenu]);
  return (
    <TabStrip
      activeId={activeId}
      aria-label="Test tabs"
      contextMenu={contextMenu}
      items={items}
      onActivate={(id) => {
        onActivateSpy?.(id);
        setActiveId(id);
      }}
      onClose={close}
      onCloseAll={onCloseAll}
      onReorder={reorderable ? setOrder : undefined}
      pinnedItems={pinnedItems}
      trailing={<button type="button">New</button>}
    />
  );
}

function renderStrip(props: HarnessProps) {
  const { registry } = createTestActionRegistry();
  return render(
    <ActionRegistryProvider registry={registry}>
      <Harness {...props} />
    </ActionRegistryProvider>
  );
}

const tab = (name: string): HTMLElement => screen.getByRole('tab', { name });
const tabNames = (): string[] =>
  within(screen.getByRole('tablist')).getAllByRole('tab').map((element) => element.textContent ?? '');

afterEach(() => {
  renderCounts.clear();
  vi.restoreAllMocks();
});

describe('TabStrip structure', () => {
  it('exposes one named horizontal tablist that owns only tabs, pinned first', () => {
    renderStrip({ initial: ['a', 'b'], pinned: ['p'] });
    const tablist = screen.getByRole('tablist', { name: 'Test tabs' });
    expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');
    expect(tabNames()).toEqual(['Tab p', 'Tab a', 'Tab b']);
    expect(within(tablist).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'New' }).closest('[role="tablist"]')).toBeNull();
  });

  it('makes only the active tab a tab stop', () => {
    renderStrip({ initial: ['a', 'b', 'c'] });
    expect(tab('Tab a')).toHaveAttribute('tabindex', '0');
    expect(tab('Tab b')).toHaveAttribute('tabindex', '-1');
    expect(tab('Tab c')).toHaveAttribute('tabindex', '-1');
  });
});

describe('TabStrip keyboard (APG, manual activation)', () => {
  it('moves focus with arrows and activates only on Enter or Space', async () => {
    const user = userEvent.setup();
    const onActivateSpy = vi.fn();
    renderStrip({ initial: ['a', 'b', 'c'], onActivateSpy });
    tab('Tab a').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab('Tab b')).toHaveFocus();
    expect(onActivateSpy).not.toHaveBeenCalled();
    expect(tab('Tab a')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(onActivateSpy).toHaveBeenLastCalledWith('b');
    await user.keyboard('{ArrowRight}');
    await user.keyboard(' ');
    expect(onActivateSpy).toHaveBeenLastCalledWith('c');
  });

  it('wraps and jumps with Home/End across the pinned and scroll groups', async () => {
    const user = userEvent.setup();
    renderStrip({ initial: ['a', 'b'], pinned: ['p'] });
    tab('Tab p').focus();
    await user.keyboard('{ArrowLeft}');
    expect(tab('Tab b')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(tab('Tab p')).toHaveFocus();
    await user.keyboard('{End}');
    expect(tab('Tab b')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab('Tab p')).toHaveFocus();
  });

  it('leaves modified arrows to global chords', () => {
    renderStrip({ initial: ['a', 'b'] });
    tab('Tab a').focus();
    const notPrevented = fireEvent.keyDown(tab('Tab a'), { ctrlKey: true, key: 'ArrowRight' });
    expect(notPrevented).toBe(true);
    expect(tab('Tab a')).toHaveFocus();
  });

  it('closes the focused tab with Delete and focuses the next tab', async () => {
    renderStrip({ initial: ['a', 'b', 'c'] });
    tab('Tab b').focus();
    fireEvent.keyDown(tab('Tab b'), { key: 'Delete' });
    expect(tabNames()).toEqual(['Tab a', 'Tab c']);
    await waitFor(() => expect(tab('Tab c')).toHaveFocus());
  });

  it('focuses the previous tab when the last tab closes', async () => {
    renderStrip({ initial: ['a', 'b'] });
    tab('Tab b').focus();
    fireEvent.keyDown(tab('Tab b'), { key: 'Delete' });
    await waitFor(() => expect(tab('Tab a')).toHaveFocus());
  });

  it('focuses the strip trailing control when the only tab closes', async () => {
    renderStrip({ initial: ['a'] });
    tab('Tab a').focus();
    fireEvent.keyDown(tab('Tab a'), { key: 'Delete' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'New' })).toHaveFocus());
  });

  it('never closes a non-closable tab', () => {
    renderStrip({ initial: ['a'], pinned: ['p'] });
    tab('Tab p').focus();
    fireEvent.keyDown(tab('Tab p'), { key: 'Delete' });
    expect(tabNames()).toEqual(['Tab p', 'Tab a']);
  });

  it('reorders with Alt+Shift+Arrow, keeps focus on the moved tab and announces it', async () => {
    renderStrip({ initial: ['a', 'b', 'c'] });
    tab('Tab a').focus();
    fireEvent.keyDown(tab('Tab a'), { altKey: true, key: 'ArrowRight', shiftKey: true });
    expect(tabNames()).toEqual(['Tab b', 'Tab a', 'Tab c']);
    await waitFor(() => expect(tab('Tab a')).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('Tab a moved to position 2 of 3');
  });

  it('never reorders pinned tabs or strips without onReorder', () => {
    renderStrip({ initial: ['a', 'b'], pinned: ['p'] });
    fireEvent.keyDown(tab('Tab p'), { altKey: true, key: 'ArrowRight', shiftKey: true });
    expect(tabNames()).toEqual(['Tab p', 'Tab a', 'Tab b']);
  });

  it('does not reorder when the strip has no onReorder', () => {
    renderStrip({ initial: ['a', 'b'], reorderable: false });
    fireEvent.keyDown(tab('Tab a'), { altKey: true, key: 'ArrowRight', shiftKey: true });
    expect(tabNames()).toEqual(['Tab a', 'Tab b']);
  });
});

describe('TabStrip context menu', () => {
  it('opens the tab menu on right-click and runs the action against that tab', async () => {
    const user = userEvent.setup();
    renderStrip({ initial: ['a', 'b', 'c'], withMenu: true });
    fireEvent.contextMenu(tab('Tab b'));
    await user.click(await screen.findByRole('menuitem', { name: 'Close' }));
    await waitFor(() => expect(tabNames()).toEqual(['Tab a', 'Tab c']));
  });

  it('opens the strip menu from the empty background', async () => {
    renderStrip({ initial: ['a'], withMenu: true });
    fireEvent.contextMenu(screen.getByRole('tablist'));
    expect(await screen.findByRole('menuitem', { name: 'New Tab' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Close' })).toBeNull();
  });

  it('opens the focused tab menu with Shift+F10 and returns focus to that tab', async () => {
    const user = userEvent.setup();
    renderStrip({ initial: ['a', 'b'], withMenu: true });
    tab('Tab b').focus();
    fireEvent.keyDown(tab('Tab b'), { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menuitem', { name: 'Close' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(tab('Tab b')).toHaveFocus());
  });

  it('advertises a popup menu on tabs only when the strip has one', () => {
    const view = renderStrip({ initial: ['a'] });
    expect(tab('Tab a')).not.toHaveAttribute('aria-haspopup');
    view.unmount();
    renderStrip({ initial: ['a'], withMenu: true });
    expect(tab('Tab a')).toHaveAttribute('aria-haspopup', 'menu');
  });
});

describe('TabStrip All-tabs menu', () => {
  it('lists every tab and activates the chosen one', async () => {
    const user = userEvent.setup();
    renderStrip({ initial: ['a', 'b'], pinned: ['p'] });
    await user.click(screen.getByRole('button', { name: 'All tabs' }));
    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent)).toEqual(['Tab p', 'Tab a', 'Tab b']);
    await user.click(screen.getByRole('menuitemradio', { name: 'Tab b' }));
    await waitFor(() => expect(tab('Tab b')).toHaveAttribute('aria-selected', 'true'));
  });

  it('offers Close All only when the strip supports it', async () => {
    const user = userEvent.setup();
    const onCloseAll = vi.fn();
    renderStrip({ initial: ['a'], onCloseAll });
    await user.click(screen.getByRole('button', { name: 'All tabs' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Close All' }));
    expect(onCloseAll).toHaveBeenCalledTimes(1);
  });
});

describe('TabStrip render isolation', () => {
  it('re-renders only the previously and newly active tabs on selection', async () => {
    const user = userEvent.setup();
    renderStrip({ initial: ['a', 'b', 'c'] });
    const before = new Map(renderCounts);
    await user.click(tab('Tab c'));
    await waitFor(() => expect(tab('Tab c')).toHaveAttribute('aria-selected', 'true'));
    const delta = (id: string): number => (renderCounts.get(id) ?? 0) - (before.get(id) ?? 0);
    expect(delta('b')).toBe(0);
    expect(delta('a')).toBeGreaterThan(0);
    expect(delta('c')).toBeGreaterThan(0);
  });
});

describe('TabStrip containment', () => {
  it('replaces a crashing strip with an inline retry row', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Boom(): ReactElement {
      throw new Error('mark exploded');
    }
    render(
      <TabStrip
        activeId="x"
        aria-label="Broken"
        items={[makeItem('x', { mark: <Boom /> })]}
        onActivate={() => undefined}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Tabs unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/tab-strip/__tests__/tab-strip.test.tsx`
Expected: FAIL, because the import cannot be resolved.

- [ ] **Step 3: Implement `packages/ui/src/tab-strip/tab-strip-keyboard.ts`**

```ts
import { moveTabId } from '@brainstrike/context-actions';
import type { KeyboardEvent } from 'react';
import { resolveFocusAfterClose, resolveRovingTargetIndex } from './tab-strip-order';

export interface TabStripKeyboardContext {
  /** Pinned then scroll ids: ONE roving sequence. */
  readonly allIds: readonly string[];
  readonly announce: (message: string) => void;
  readonly close: ((id: string) => void) | null;
  readonly focusFallback: () => void;
  readonly focusTab: (id: string) => void;
  readonly focusTabAfterCommit: (id: string) => void;
  readonly hasContextMenu: boolean;
  readonly isClosable: (id: string) => boolean;
  readonly labelOf: (id: string) => string;
  readonly openContextMenu: (id: string) => void;
  readonly reorder: ((orderedIds: readonly string[]) => void) | null;
  /** Ids the reorder chord may move (the scroll group); pinned tabs never move. */
  readonly reorderableIds: readonly string[];
}

function readTabId(event: KeyboardEvent<HTMLElement>): string | null {
  if (!(event.target instanceof HTMLElement)) {
    return null;
  }
  const tab = event.target.closest<HTMLElement>('[role="tab"][data-strip-tab-id]');
  return tab?.dataset['stripTabId'] ?? null;
}

function isMenuChord(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.key === 'ContextMenu') {
    return true;
  }
  return event.key === 'F10' && event.shiftKey && !(event.altKey || event.ctrlKey || event.metaKey);
}

function readReorderDirection(event: KeyboardEvent<HTMLElement>): 'left' | 'right' | null {
  if (!(event.altKey && event.shiftKey) || event.ctrlKey || event.metaKey) {
    return null;
  }
  if (event.key === 'ArrowLeft') {
    return 'left';
  }
  return event.key === 'ArrowRight' ? 'right' : null;
}

/** WAI-ARIA APG tabs keyboard model with manual activation (BST-1836 §6.2). */
export function handleTabStripKeyDown(
  event: KeyboardEvent<HTMLElement>,
  context: TabStripKeyboardContext
): void {
  const id = readTabId(event);
  if (id === null) {
    return;
  }
  if (isMenuChord(event)) {
    if (!context.hasContextMenu) {
      return;
    }
    event.preventDefault();
    context.openContextMenu(id);
    return;
  }
  const direction = readReorderDirection(event);
  if (direction) {
    if (!(context.reorder && context.reorderableIds.includes(id))) {
      return;
    }
    event.preventDefault();
    const next = moveTabId(context.reorderableIds, id, direction);
    if (!next) {
      return;
    }
    context.reorder(next);
    context.announce(`${context.labelOf(id)} moved to position ${next.indexOf(id) + 1} of ${next.length}`);
    context.focusTabAfterCommit(id);
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }
  if (event.key === 'Delete') {
    if (!(context.close && context.isClosable(id))) {
      return;
    }
    event.preventDefault();
    const successor = resolveFocusAfterClose(context.allIds, id);
    context.close(id);
    if (successor === null) {
      context.focusFallback();
    } else {
      context.focusTabAfterCommit(successor);
    }
    return;
  }
  const targetIndex = resolveRovingTargetIndex(
    event.key,
    context.allIds.indexOf(id),
    context.allIds.length
  );
  const targetId = targetIndex === null ? undefined : context.allIds[targetIndex];
  if (targetId === undefined) {
    return;
  }
  event.preventDefault();
  context.focusTab(targetId);
}
```

- [ ] **Step 4: Implement `packages/ui/src/tab-strip/tab-strip-all-tabs-menu.tsx`**

```tsx
import { ChevronDown } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '../button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { resolveTabStatusLabel, TabStatusIcon } from './tab-status';
import { TAB_ICON_CLASS_NAME, TAB_STRIP_ICON_BUTTON_CLASS_NAME } from './tab-strip-tokens';
import type { TabStripItem } from './types';

function AllTabsLeading({ item }: { readonly item: TabStripItem }): ReactElement | null {
  if (item.status) {
    return <TabStatusIcon status={item.status} />;
  }
  if (item.icon) {
    const Icon = item.icon;
    return <Icon className={TAB_ICON_CLASS_NAME} />;
  }
  return null;
}

/**
 * The overflow affordance (BST-1836 D2): every tab, pinned first, with
 * type-ahead from Radix, plus strip-level bulk actions.
 */
export function TabStripAllTabsMenu({
  activeId,
  items,
  onActivate,
  onCloseAll,
}: {
  readonly activeId: string | null;
  readonly items: readonly TabStripItem[];
  readonly onActivate: (id: string) => void;
  readonly onCloseAll?: (() => void) | undefined;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="All tabs"
          className={TAB_STRIP_ICON_BUTTON_CLASS_NAME}
          data-testid="tab-strip-all-tabs"
          size="icon-xs"
          title="All tabs"
          type="button"
          variant="ghost"
        >
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto" sideOffset={4}>
        <DropdownMenuRadioGroup onValueChange={onActivate} value={activeId ?? ''}>
          {items.map((item) => (
            <DropdownMenuRadioItem className="gap-2" key={item.id} value={item.id}>
              <AllTabsLeading item={item} />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.status ? (
                <span className="sr-only">{`, ${resolveTabStatusLabel(item.status, item.statusLabel)}`}</span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {onCloseAll ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onCloseAll}>Close All</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

`textContent` in the All-tabs test includes the sr-only status text, but only when a status exists. The harness has none, so the expected labels hold.

- [ ] **Step 5: Implement `packages/ui/src/tab-strip/tab-strip.tsx`**

```tsx
import { useEventCallback } from '@brainstrike/hooks';
import { type FocusEvent, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { ActionContextMenu, useContextMenuTarget } from '../context-menu';
import { cn } from '../lib/utils';
import { TabPanelBoundary } from './tab-panel-boundary';
import { TabStripAllTabsMenu } from './tab-strip-all-tabs-menu';
import { handleTabStripKeyDown, type TabStripKeyboardContext } from './tab-strip-keyboard';
import { useTabReorderInstanceId, useTabStripReorderMonitor } from './tab-strip-reorder';
import { type TabStripGroup, TabStripTab } from './tab-strip-tab';
import {
  TAB_STRIP_EMBEDDED_CLASS_NAME,
  TAB_STRIP_GROUP_SEPARATOR_CLASS_NAME,
  TAB_STRIP_ROOT_CLASS_NAME,
  TAB_STRIP_SCROLLER_CLASS_NAME,
  TAB_STRIP_STANDALONE_CLASS_NAME,
} from './tab-strip-tokens';
import type { TabStripItem, TabStripProps } from './types';
import { tabStripOverflowMaskStyle, useTabStripOverflow } from './use-tab-strip-overflow';

const EMPTY_ITEMS: readonly TabStripItem[] = [];

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)')?.matches === true
  );
}

function findTab(root: HTMLElement | null, id: string): HTMLElement | null {
  if (!root) {
    return null;
  }
  for (const element of root.querySelectorAll<HTMLElement>('[role="tab"][data-strip-tab-id]')) {
    if (element.dataset['stripTabId'] === id) {
      return element;
    }
  }
  return null;
}

function revealTab(tab: HTMLElement | null, smooth: boolean): void {
  const shell = tab?.closest<HTMLElement>('[data-slot="tab-shell"]');
  // scrollIntoView is absent from unit-test DOM shims only.
  if (!shell || typeof shell.scrollIntoView !== 'function') {
    return;
  }
  shell.scrollIntoView({
    behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto',
    block: 'nearest',
    inline: 'nearest',
  });
}

function focusFirstTrailingControl(trailing: HTMLElement | null): void {
  trailing?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
}

/**
 * The one tab strip (BST-1836). Presentational: data in, intents out. A render
 * crash anywhere inside degrades to an inline "Tabs unavailable — Retry" row.
 */
export function TabStrip(props: TabStripProps): ReactElement {
  return (
    <TabPanelBoundary label="Tabs" layout="inline">
      <TabStripContent {...props} />
    </TabPanelBoundary>
  );
}

function TabStripContent({
  activeId,
  allTabsMenu = true,
  'aria-label': ariaLabel,
  chrome = 'standalone',
  contextMenu,
  items,
  leading,
  onActivate,
  onClose,
  onCloseAll,
  onReorder,
  pinnedItems = EMPTY_ITEMS,
  scrollTestId,
  testId,
  trailing,
}: TabStripProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const menuOriginRef = useRef<string | null>(null);
  const claimedThisEventRef = useRef(false);
  const controller = useContextMenuTarget();
  const { setTarget } = controller;
  const [announcement, setAnnouncement] = useState('');

  const allItems = useMemo(() => [...pinnedItems, ...items], [items, pinnedItems]);
  const allIds = useMemo(() => allItems.map((item) => item.id), [allItems]);
  const scrollIds = useMemo(() => items.map((item) => item.id), [items]);
  const tabStopId = activeId !== null && allIds.includes(activeId) ? activeId : (allIds[0] ?? null);

  const overflow = useTabStripOverflow(scrollRef, scrollIds.join('\n'));
  const reorderInstanceId = useTabReorderInstanceId(onReorder !== undefined);
  useTabStripReorderMonitor({ instanceId: reorderInstanceId, onReorder, orderedIds: scrollIds, scrollRef });

  const handleActivate = useEventCallback((id: string): void => onActivate(id));
  const handleCloseStable = useEventCallback((id: string): void => onClose?.(id));
  const handleClose = onClose ? handleCloseStable : null;
  const handleTabContextMenu = useEventCallback((id: string): void => {
    claimedThisEventRef.current = true;
    menuOriginRef.current = id;
    setTarget(contextMenu?.getTabTarget(id) ?? null);
  });
  const handleStripContextMenuCapture = (): void => {
    claimedThisEventRef.current = false;
    setTarget(null);
  };
  const handleStripContextMenu = (): void => {
    if (claimedThisEventRef.current || !contextMenu?.getStripTarget) {
      return;
    }
    menuOriginRef.current = null;
    setTarget(contextMenu.getStripTarget());
  };

  const focusTab = useEventCallback((id: string): void => {
    const element = findTab(rootRef.current, id);
    element?.focus();
    revealTab(element, false);
  });
  const focusTabAfterCommit = useEventCallback((id: string): void => {
    window.requestAnimationFrame(() => focusTab(id));
  });
  const focusFallback = useEventCallback((): void => {
    window.requestAnimationFrame(() => focusFirstTrailingControl(trailingRef.current));
  });
  const openContextMenu = useEventCallback((id: string): void => {
    const element = findTab(rootRef.current, id);
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    // Keyboard-invoked menus anchor at the tab, never at a (0,0) pointer.
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: rect.left,
        clientY: rect.bottom,
      })
    );
  });
  const restoreFocusAfterMenu = useEventCallback((): void => {
    const root = rootRef.current;
    const origin = menuOriginRef.current;
    const candidate =
      (origin === null ? null : findTab(root, origin)) ??
      (activeId === null ? null : findTab(root, activeId)) ??
      (tabStopId === null ? null : findTab(root, tabStopId));
    if (candidate) {
      candidate.focus();
      return;
    }
    focusFirstTrailingControl(trailingRef.current);
  });
  const announce = useEventCallback((message: string): void => {
    // A live region only announces changes; alternate a trailing NBSP for repeats.
    setAnnouncement((current) => (current === message ? `${message} ` : message));
  });
  const labelOf = useEventCallback(
    (id: string): string => allItems.find((item) => item.id === id)?.label ?? id
  );
  const isClosable = useEventCallback(
    (id: string): boolean => allItems.find((item) => item.id === id)?.closable === true
  );

  useEffect(() => {
    if (activeId !== null) {
      revealTab(findTab(rootRef.current, activeId), true);
    }
  }, [activeId]);

  const keyboard: TabStripKeyboardContext = {
    allIds,
    announce,
    close: handleClose,
    focusFallback,
    focusTab,
    focusTabAfterCommit,
    hasContextMenu: contextMenu !== undefined,
    isClosable,
    labelOf,
    openContextMenu,
    reorder: onReorder ?? null,
    reorderableIds: scrollIds,
  };

  const handleTablistFocus = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLElement && event.target.matches('[role="tab"]')) {
      revealTab(event.target, false);
    }
  };

  const renderTab = (item: TabStripItem, group: TabStripGroup): ReactElement => (
    <TabStripTab
      group={group}
      hasContextMenu={contextMenu !== undefined}
      isActive={item.id === activeId}
      isTabStop={item.id === tabStopId}
      item={item}
      key={item.id}
      onActivate={handleActivate}
      onClose={handleClose}
      onContextMenu={handleTabContextMenu}
      reorderInstanceId={group === 'scroll' ? reorderInstanceId : null}
    />
  );

  const strip = (
    // biome-ignore lint/a11y/noStaticElementInteractions: layout container; it only claims the strip-background context-menu target
    <div
      className={cn(
        TAB_STRIP_ROOT_CLASS_NAME,
        chrome === 'standalone' ? TAB_STRIP_STANDALONE_CLASS_NAME : TAB_STRIP_EMBEDDED_CLASS_NAME
      )}
      data-slot="tab-strip"
      data-testid={testId}
      onContextMenu={handleStripContextMenu}
      onContextMenuCapture={handleStripContextMenuCapture}
      ref={rootRef}
    >
      {leading}
      <div
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        className="flex h-full min-w-0 flex-1 items-center"
        onFocus={handleTablistFocus}
        onKeyDown={(event) => handleTabStripKeyDown(event, keyboard)}
        role="tablist"
      >
        {pinnedItems.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1" data-group="pinned" role="presentation">
            {pinnedItems.map((item) => renderTab(item, 'pinned'))}
          </div>
        ) : null}
        {pinnedItems.length > 0 && items.length > 0 ? (
          <div aria-hidden="true" className={TAB_STRIP_GROUP_SEPARATOR_CLASS_NAME} />
        ) : null}
        <div
          className={TAB_STRIP_SCROLLER_CLASS_NAME}
          data-group="scroll"
          data-overflow-end={overflow.end ? 'true' : undefined}
          data-overflow-start={overflow.start ? 'true' : undefined}
          data-testid={scrollTestId}
          ref={scrollRef}
          role="presentation"
          style={tabStripOverflowMaskStyle(overflow)}
        >
          <div className="flex w-max items-center gap-1" role="presentation">
            {items.map((item) => renderTab(item, 'scroll'))}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1" data-slot="tab-strip-trailing" ref={trailingRef}>
        {trailing}
        {allTabsMenu && allItems.length > 0 ? (
          <TabStripAllTabsMenu
            activeId={activeId}
            items={allItems}
            onActivate={handleActivate}
            onCloseAll={onCloseAll}
          />
        ) : null}
      </div>
      <div aria-live="polite" className="sr-only" role="status">
        {announcement}
      </div>
    </div>
  );

  if (!contextMenu) {
    return strip;
  }
  return (
    <ActionContextMenu
      controller={controller}
      localActions={contextMenu.localActions}
      onCloseAutoFocus={restoreFocusAfterMenu}
    >
      {strip}
    </ActionContextMenu>
  );
}
```

- [ ] **Step 6: Create `packages/ui/src/tab-strip/index.ts` and export it from the package root**

```ts
export { TabPanelBoundary, type TabPanelBoundaryProps } from './tab-panel-boundary';
export { TabStrip } from './tab-strip';
export { TAB_STRIP_ICON_BUTTON_CLASS_NAME } from './tab-strip-tokens';
export type {
  TabAppearance,
  TabStatus,
  TabStripContextMenu,
  TabStripItem,
  TabStripProps,
} from './types';
```

In `packages/ui/src/index.ts`, add `export * from './tab-strip';` immediately after the existing `export * from './tabs';` line.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project unit src/tab-strip`
Expected: PASS for every tab-strip suite. The `tab-strip.test.tsx` suite has 20 tests.

Radix context menus open on a `contextmenu` event in happy-dom; `action-context-menu.test.tsx` proves it. If the Shift+F10 test fails because happy-dom's `MouseEvent` drops `clientX`, keep the implementation. Assert only that the menu opened, which is the behaviour. Real anchoring is covered in Task 7.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/tab-strip packages/ui/src/index.ts
git commit -m "feat(BST-1837): TabStrip composition with APG keyboard, menus and All-tabs overflow"
```

---

### Task 7: Real-browser proof with real Tailwind: geometry, axe, keyboard menu, native drag

**Files:**
- Modify: `packages/ui/package.json`. Add devDependencies `"@tailwindcss/vite": "catalog:"` and `"axe-core": "^4.13.0"`, then run `pnpm install --prefer-offline`.
- Modify: `packages/ui/vitest.config.mts`. Add `import tailwindcss from '@tailwindcss/vite';`, then add `plugins: [tailwindcss()],` to the root `defineConfig({...})` object, next to `optimizeDeps`. This mirrors `packages/assistant-ui/vitest.config.mts`.
- Create: `packages/ui/src/tab-strip/__tests__/tab-strip.browser.css`, `packages/ui/src/tab-strip/__tests__/tab-strip.browser.test.tsx`

**Interfaces:** consumes `TabStrip`.

- [ ] **Step 1: Create the browser stylesheet**

```css
/* packages/ui/src/tab-strip/__tests__/tab-strip.browser.css */
/* Real Tailwind for the browser lane: the app's tokens plus this package's classes. */
@import "tailwindcss";
@import "../../globals.css";
@source "../";
```

- [ ] **Step 2: Write the browser test**

```tsx
// packages/ui/src/tab-strip/__tests__/tab-strip.browser.test.tsx
import './tab-strip.browser.css';
import { createTabStripActions, createTestActionRegistry } from '@brainstrike/context-actions';
import { render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ActionRegistryProvider } from '../../context-menu';
import { TabStrip } from '../tab-strip';
import type { TabStripItem } from '../types';

function items(ids: readonly string[]): TabStripItem[] {
  return ids.map((id) => ({
    closable: true,
    id,
    label: `Document ${id}`,
    panelDomId: `panel-${id}`,
    tabDomId: `tab-${id}`,
  }));
}

function Harness({ width = 800 }: { readonly width?: number }): ReactElement {
  const [order, setOrder] = useState<readonly string[]>(['a', 'b', 'c']);
  const [activeId, setActiveId] = useState<string | null>('a');
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
  }, [order]);
  const localActions = useMemo(
    () =>
      createTabStripActions({
        close: (id) => setOrder((current) => current.filter((candidate) => candidate !== id)),
        getId: (target) => target.id,
        getLabel: (target) => target.title,
        getOrderedIds: () => orderRef.current,
        idPrefix: 'browser-tab',
        kind: 'assistant-thread-tab',
        noun: 'tab',
      }),
    []
  );
  return (
    <div style={{ width }}>
      <TabStrip
        activeId={activeId}
        aria-label="Documents"
        contextMenu={{
          getTabTarget: (id) => ({ id, kind: 'assistant-thread-tab', resourceId: 'r', title: `Document ${id}` }),
          localActions,
        }}
        items={items(order)}
        onActivate={setActiveId}
        onClose={(id) => setOrder((current) => current.filter((candidate) => candidate !== id))}
        onReorder={setOrder}
        testId="strip"
      />
      <p data-testid="order">{order.join(',')}</p>
    </div>
  );
}

function mount(width?: number) {
  const { registry } = createTestActionRegistry();
  return render(
    <ActionRegistryProvider registry={registry}>
      <Harness {...(width === undefined ? {} : { width })} />
    </ActionRegistryProvider>
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

test('paints the spec §5 geometry with real Tailwind', () => {
  mount();
  const strip = screen.getByTestId('strip');
  const shell = screen.getByRole('tab', { name: 'Document a' }).closest('[data-slot="tab-shell"]') as HTMLElement;
  const trigger = screen.getByRole('tab', { name: 'Document a' });
  expect(strip.getBoundingClientRect().height).toBe(36);
  expect(shell.getBoundingClientRect().height).toBe(28);
  expect(getComputedStyle(shell).borderTopLeftRadius).toBe('6px');
  expect(getComputedStyle(trigger).fontSize).toBe('12px');
  expect(getComputedStyle(trigger).fontWeight).toBe('500');
  const close = shell.querySelector('[data-slot="tab-close"]') as HTMLElement;
  expect(close.getBoundingClientRect().width).toBe(20);
  const [first, second] = [...strip.querySelectorAll<HTMLElement>('[data-slot="tab-shell"]')];
  if (!(first && second)) {
    throw new Error('expected at least two tab shells');
  }
  expect(second.getBoundingClientRect().left - first.getBoundingClientRect().right).toBe(4);
});

test('passes axe ARIA structure rules (defect 1 regression guard, D9)', async () => {
  mount();
  const result = await axe.run(screen.getByTestId('strip'), {
    runOnly: { type: 'rule', values: ['aria-required-children', 'nested-interactive', 'aria-hidden-focus'] },
  });
  expect(result.violations).toEqual([]);
});

test('opens the tab menu from the keyboard, anchored at the tab', async () => {
  mount();
  const tab = screen.getByRole('tab', { name: 'Document b' });
  tab.focus();
  await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  const menu = await screen.findByRole('menu');
  const tabRect = tab.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  expect(Math.abs(menuRect.left - tabRect.left)).toBeLessThan(16);
  expect(menuRect.top).toBeGreaterThanOrEqual(tabRect.bottom - 1);
  expect(screen.getAllByRole('menu')).toHaveLength(1);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(tab).toHaveFocus());
});

test('reorders by native drag and drop onto the left edge of a tab', async () => {
  mount();
  const source = screen.getByRole('tab', { name: 'Document c' });
  const target = screen.getByRole('tab', { name: 'Document a' });
  await userEvent.dragAndDrop(source, target, { targetPosition: { x: 4, y: 10 } });
  await waitFor(() => expect(screen.getByTestId('order')).toHaveTextContent('c,a,b'));
});

test('maps wheel input to horizontal scroll when tabs overflow', async () => {
  mount(220);
  const scroller = screen.getByTestId('strip').querySelector('[data-group="scroll"]') as HTMLElement;
  await waitFor(() => expect(scroller.dataset['overflowEnd']).toBe('true'));
  scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
  expect(scroller.scrollLeft).toBeGreaterThan(0);
  await waitFor(() => expect(scroller.dataset['overflowStart']).toBe('true'));
});
```

- [ ] **Step 3: Run the tests, see the red, and fix only real defects**

Run: `pnpm --filter @brainstrike/ui exec vitest run --project browser src/tab-strip/__tests__/tab-strip.browser.test.tsx`
Expected: PASS (5 tests).

If the geometry test fails, a painted value disagrees with spec §5. Fix the token, never the assertion. The only exception: if the strip height measures 37 because of the 1px `border-b`, check whether Tailwind's preflight `box-sizing: border-box` is loaded. It is, through `@import "tailwindcss"`.

If `userEvent.dragAndDrop` cannot drive native HTML5 drag-and-drop through the provider, do not stub it. Replace the test body with Playwright's `page` locator drag via `commands` (see `packages/assistant-ui/vitest.config.mts` for how commands are registered) and report it.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/package.json pnpm-lock.yaml packages/ui/vitest.config.mts packages/ui/src/tab-strip/__tests__
git commit -m "test(BST-1837): real-browser geometry, axe, keyboard-menu and drag proofs for TabStrip"
```

---

### Task 8: Contract docs, guards and the full battery

**Files:**
- Modify: `docs/agents/ui-conventions.md`. Insert a new `## TAB STRIPS` section immediately BEFORE the line `## CONTEXT ACTION SYSTEM`, followed by a `---` separator.
- Create: `docs/archive/agent-contract-history/ui-conventions/tab-strips.md`.

- [ ] **Step 1: Add the contract section** (rule-shaped, per `docs/agents/README.md`)

```markdown
## TAB STRIPS

Every document strip (assistant threads, the workspace, the browser pane) renders
`TabStrip` from `packages/ui/src/tab-strip`; fixed view switchers use `Tabs`. Do not
hand-roll a tablist.

- The primitives are presentational. Consumers pass `items`/`pinnedItems` plus
  intents (`onActivate`, `onClose`, `onReorder`) and a `contextMenu` descriptor.
  The strip owns roving focus, overflow, drag-and-drop and menu claiming, and never
  reads a store or decides what closing means.
- Geometry comes from `tab-strip-tokens.ts`: a 36px row, 28px pill tabs with a 6px
  radius, a 4px gap, 12px/500 labels whose weight never changes with state, and a
  20px close slot whose space is always reserved. The neutral selected state is the
  segmented control's raised surface; identity tabs pass `appearance` tints.
- Keyboard is APG with MANUAL activation: arrows/Home/End move focus, and
  Enter/Space activate. Delete closes the tab and focuses the next tab, else the
  previous one, else the first trailing control. ⌥⇧←/→ reorders the scroll group
  and announces the move. Shift+F10 and the ContextMenu key open the tab menu
  anchored at the tab. Middle-click closes.
- The close ✕ is a mouse-only sibling (`aria-hidden`, `tabIndex=-1`): the tablist
  owns only tabs, which axe `aria-required-children` checks.
- Menus: tab menus come from `createTabStripActions` (`@brainstrike/context-actions`)
  plus the global actions for that target kind; the empty strip background claims a
  `tab-strip` target. Focus returns to the origin tab after a menu closes.
- Overflow has no chevrons: wheel-to-horizontal through a NATIVE non-passive
  listener (React's `onWheel` is passive), inline edge fades, `scroll-px-8` reveal,
  and the always-present All-tabs menu.
- Wrap each tab panel in `TabPanelBoundary`; the strip wraps itself. A render crash
  stays in its panel. Keep-alive and `<Activity>` choices are per surface: see
  spec §7.1, and never hide a panel whose effects own still-running work with
  `<Activity>`.

Settled: BST-1836 decisions D1–D9 (2026-09-27). Evidence: `ui-conventions/tab-strips.md`.
Guard: `packages/ui/src/tab-strip/__tests__/tab-strip.test.tsx`,
`tab-strip.browser.test.tsx` (painted geometry, axe, keyboard menu, native drag),
`packages/context-actions/src/__tests__/tab-strip-actions.test.ts`.

---
```

- [ ] **Step 2: Create the evidence file**

```markdown
# Tab strips — evidence

Record behind the TAB STRIPS contract in `../ui-conventions.md`.

- **2026-09-27 audit (origin/main 450c4280e).** Four strips were measured live with Playwright on a `vite preview` build. Tab heights were 20/24/27/28/33/40px and radii 0/4/6px; font weights differed between strips, and the Git tabs changed weight on selection. axe-core 4.13 `aria-required-children` failed on the assistant and workspace tablists (close buttons were owned by the tablist); Radix Library tabs passed.
- **Automatic activation reloaded workspaces.** Arrow roving in the assistant strip called `openThreadTab`, and `ThreadWorkspaceCoordinator` keys its hydration on `activeThreadId`, so each arrow press reloaded a saved workspace. This is why activation is manual everywhere (D3).
- **React registers `onWheel` passively**, so the old `preventDefault` in the assistant strip's `onWheel` never took effect. The strip now uses a native non-passive listener.
- **`<Activity>` is not a free keep-alive.** A hidden `<Activity>` unmounts effects. `assistant-ui-panel-wrapper.tsx` subscribes to tool updates in an effect, so root thread panels stay `hidden`-mounted. Child conversations deliberately use `<Activity>` (#3292).
- **`useSyncExternalStore` updates always render blocking** (react.dev caveat), so a zustand-driven tab switch gains nothing from `startTransition` or `<ViewTransition>`. There is no sliding indicator.
- **Sources:** `docs/superpowers/research/2026-09-27-tab-controller-vendor-research.md`. Spec: `docs/superpowers/specs/2026-09-27-unified-tab-controllers-design.md`.
```

- [ ] **Step 3: Run the full battery**

```bash
pnpm --filter @brainstrike/context-actions exec vitest run
pnpm --filter @brainstrike/context-actions exec tsc -b .
pnpm --filter @brainstrike/ui test
pnpm --filter @brainstrike/ui test:browser
pnpm --filter @brainstrike/ui exec tsc -b .
pnpm test:scripts
pnpm dlx ultracite check packages/ui/src/tab-strip packages/context-actions/src docs/agents
pnpm run react-doctor
```

Expected: every command exits 0. For React Doctor, only newly introduced error-severity issues block, per `docs/agents/ci-quality.md`.

The type-check commands are illustrative. If `tsc -b .` isn't the package's check, use the package's own `type-check` script (see its `package.json`).

- [ ] **Step 4: Check the consumers still build.** The app-shell DnD shell is untouched in this PR, and both copies must coexist until BST-1838 removes the old one.

Run: `pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/assistant-thread-tabs-dnd.test.ts src/__tests__/pragmatic-dnd-entry-points.test.ts src/__tests__/assistant-thread-tabs-workspace.test.tsx`
Expected: PASS, with no behaviour change.

- [ ] **Step 5: Commit**

```bash
git add docs/agents/ui-conventions.md docs/archive/agent-contract-history/ui-conventions/tab-strips.md
git commit -m "docs(BST-1837): TAB STRIPS contract and evidence"
```

---

## Self-review notes

- **Spec coverage:**
  - §4 → Tasks 2 and 6
  - §5 → Task 2 (tokens) and Task 7 (painted proof)
  - §5.1 → Task 5
  - §5.2 → Tasks 4 and 6
  - §6.1–6.4 → Tasks 5 and 6, plus Task 1 for the actions and the `tab-strip` target
  - §7.3 → Task 3 plus the strip self-wrap in Task 6
  - §7.4 → the Task 6 render-count test
  - D9 → Task 7 (axe)
  - The consumer migrations (§8) are BST-1838/1839/1840, deliberately not here.
- **Types:**
  - `TabStripTabProps.onClose` is `((id) => void) | null`, and the strip passes `handleClose`, which is null when `onClose` is absent.
  - `reorderInstanceId` is `string | null` throughout.
  - `TabEdge` is defined in `tab-strip-order.ts` and imported by `tab-strip-reorder.ts`.
