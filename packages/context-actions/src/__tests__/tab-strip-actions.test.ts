import { describe, expect, it, vi } from 'vitest';
import { createActionRegistry } from '../registry.js';
import {
  adjacentTabId,
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
    closeAll: vi.fn((_id: string) => {
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

describe('adjacentTabId', () => {
  it('steps by position and wraps at both ends (D7: positional, not MRU)', () => {
    expect(adjacentTabId(['a', 'b', 'c'], 'a', 'next')).toBe('b');
    expect(adjacentTabId(['a', 'b', 'c'], 'c', 'next')).toBe('a');
    expect(adjacentTabId(['a', 'b', 'c'], 'a', 'previous')).toBe('c');
    expect(adjacentTabId(['a', 'b', 'c'], 'b', 'previous')).toBe('a');
  });

  it('has nowhere to go with one tab, no active tab, or an active id outside the order', () => {
    expect(adjacentTabId(['a'], 'a', 'next')).toBeNull();
    expect(adjacentTabId(['a', 'b'], null, 'next')).toBeNull();
    expect(adjacentTabId(['a', 'b'], 'z', 'previous')).toBeNull();
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

  it('passes the invoking tab to closeAll so a strip can scope it to that tab group', async () => {
    const { action, getOrder, operations } = setup(['a', 'b']);
    await expect(action('close-all').run(threadTab('b'), {})).resolves.toEqual({ ok: true });
    expect(operations.closeAll).toHaveBeenCalledWith('b');
    expect(getOrder()).toEqual([]);
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

  it('awaits async operations and reports a rejection as a failed outcome', async () => {
    const { action } = setup(['a', 'b'], {
      close: () => Promise.reject(new Error('main refused the close')),
      closeAll: () => Promise.resolve(),
    });
    await expect(action('close').run(threadTab('a'), {})).resolves.toEqual({
      error: 'main refused the close',
      ok: false,
    });
    await expect(action('close-all').run(threadTab('a'), {})).resolves.toEqual({ ok: true });
  });

  it('accepts operations that return a value (e.g. a store close returning the next id)', async () => {
    const { action } = setup(['a', 'b'], {
      close: (id: string): string | null => (id === 'a' ? 'b' : null),
    });
    await expect(action('close').run(threadTab('a'), {})).resolves.toEqual({ ok: true });
  });

  it('runs a synchronous operation before run() returns, so callers see the mutation at once', () => {
    const { action, getOrder } = setup(['a', 'b']);
    void action('close').run(threadTab('a'), {});
    expect(getOrder()).toEqual(['b']);
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
