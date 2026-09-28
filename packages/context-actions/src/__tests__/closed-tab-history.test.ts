import { describe, expect, it, vi } from 'vitest';
import {
  CLOSED_TAB_HISTORY_LIMIT,
  type ClosedTab,
  createClosedTabHistory,
  NO_CLOSED_TAB_OUTCOME,
  placeTabAtIndex,
  type ReopenAttempt,
  recordRemovedTabs,
  reopenLastClosed,
} from '../closed-tab-history.js';

describe('createClosedTabHistory', () => {
  it('pops the most recently closed tab first', () => {
    const history = createClosedTabHistory<string>();
    history.record([{ index: 0, tab: 'a' }]);
    history.record([{ index: 3, tab: 'b' }]);

    expect(history.pop()).toEqual({ index: 3, tab: 'b' });
    expect(history.pop()).toEqual({ index: 0, tab: 'a' });
    expect(history.pop()).toBeUndefined();
  });

  it('pops a bulk close lowest index first, so consecutive reopens restore the old order', () => {
    const history = createClosedTabHistory<string>();
    // Close to the Right of index 1 in [a b c d e].
    history.record([
      { index: 2, tab: 'c' },
      { index: 3, tab: 'd' },
      { index: 4, tab: 'e' },
    ]);

    let order: readonly string[] = ['a', 'b'];
    for (let closed = history.pop(); closed; closed = history.pop()) {
      order = placeTabAtIndex([...order, closed.tab], closed.tab, closed.index);
    }
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it(`keeps only the newest ${CLOSED_TAB_HISTORY_LIMIT} entries, evicting the oldest`, () => {
    const history = createClosedTabHistory<number>();
    for (let tab = 0; tab < CLOSED_TAB_HISTORY_LIMIT + 5; tab += 1) {
      history.record([{ index: 0, tab }]);
    }

    expect(history.size()).toBe(CLOSED_TAB_HISTORY_LIMIT);
    const popped: number[] = [];
    for (let closed = history.pop(); closed; closed = history.pop()) {
      popped.push(closed.tab);
    }
    expect(popped).toEqual(
      Array.from({ length: CLOSED_TAB_HISTORY_LIMIT }, (_, offset) => 24 - offset)
    );
  });

  it('bounds a single bulk close to the leftmost tabs it closed', () => {
    const history = createClosedTabHistory<string>(3);
    history.record(['a', 'b', 'c', 'd', 'e'].map((tab, index) => ({ index, tab })));

    expect(history.size()).toBe(3);
    expect([history.pop()?.tab, history.pop()?.tab, history.pop()?.tab]).toEqual(['a', 'b', 'c']);
  });

  it('clears every entry', () => {
    const history = createClosedTabHistory<string>();
    history.record([{ index: 0, tab: 'a' }]);
    history.record([{ index: 1, tab: 'b' }]);

    history.clear();

    expect(history.size()).toBe(0);
    expect(history.pop()).toBeUndefined();
  });

  it('rejects a non-positive limit', () => {
    expect(() => createClosedTabHistory(0)).toThrow(/positive integer/);
  });
});

describe('recordRemovedTabs', () => {
  it('records exactly the ids a close removed, at their old indices', () => {
    const history = createClosedTabHistory<string>();

    recordRemovedTabs(
      history,
      ['a', 'b', 'c', 'd'].map((id) => ({ id, tab: id.toUpperCase() })),
      ['a', 'c']
    );

    expect(history.pop()).toEqual({ index: 1, tab: 'B' });
    expect(history.pop()).toEqual({ index: 3, tab: 'D' });
    expect(history.pop()).toBeUndefined();
  });

  it('records nothing when the close removed nothing', () => {
    const history = createClosedTabHistory<string>();

    recordRemovedTabs(history, [{ id: 'a', tab: 'a' }], ['a']);

    expect(history.size()).toBe(0);
  });
});

describe('placeTabAtIndex', () => {
  it('moves the reopened tab to its old index when that index is still valid', () => {
    expect(placeTabAtIndex(['a', 'c', 'b'], 'b', 1)).toEqual(['a', 'b', 'c']);
    expect(placeTabAtIndex(['b', 'a'], 'b', 1)).toEqual(['a', 'b']);
  });

  it('leaves it at the end when fewer tabs remain than its old index', () => {
    expect(placeTabAtIndex(['a', 'b'], 'b', 5)).toEqual(['a', 'b']);
    expect(placeTabAtIndex(['b', 'a'], 'b', 5)).toEqual(['a', 'b']);
  });

  it('throws when the tab is not in the order', () => {
    expect(() => placeTabAtIndex(['a'], 'b', 0)).toThrow(/not open/);
  });
});

describe('reopenLastClosed', () => {
  function historyOf(...tabs: string[]) {
    const history = createClosedTabHistory<string>();
    history.record(tabs.map((tab, index) => ({ index, tab })));
    return history;
  }

  it('reports an empty history as the benign no-op, without calling the strip', async () => {
    const reopen = vi.fn<(closed: ClosedTab<string>) => ReopenAttempt>();

    await expect(reopenLastClosed(historyOf(), reopen)).resolves.toBe(NO_CLOSED_TAB_OUTCOME);
    expect(reopen).not.toHaveBeenCalled();
  });

  it('consumes the entry it reopened', async () => {
    const history = historyOf('a');

    await expect(reopenLastClosed(history, () => ({ status: 'reopened' }))).resolves.toEqual({
      ok: true,
    });
    expect(history.size()).toBe(0);
  });

  it('drops a confirmed-stale entry and reports it', async () => {
    const history = historyOf('a');

    await expect(
      reopenLastClosed(history, () => ({ error: '"a" was deleted', status: 'stale' }))
    ).resolves.toEqual({ error: '"a" was deleted', ok: false });
    expect(history.size()).toBe(0);
  });

  it('keeps an entry it cannot check yet, so the next reopen retries it', async () => {
    const history = historyOf('a', 'b');

    await expect(
      reopenLastClosed(history, () => ({
        error: 'Threads are still loading',
        status: 'unavailable',
      }))
    ).resolves.toEqual({ error: 'Threads are still loading', ok: false });
    expect(history.pop()).toEqual({ index: 0, tab: 'a' });
  });

  it('puts the entry back when the reopen throws synchronously', async () => {
    const history = historyOf('a');

    await expect(
      reopenLastClosed(history, () => {
        throw new Error('Cannot place tab "a": it is not open');
      })
    ).resolves.toEqual({ error: 'Cannot place tab "a": it is not open', ok: false });
    expect(history.pop()).toEqual({ index: 0, tab: 'a' });
  });

  it('puts the entry back when the reopen rejects', async () => {
    const history = historyOf('a');

    await expect(
      reopenLastClosed(history, () => Promise.reject(new Error('host rejected the view')))
    ).resolves.toEqual({ error: 'host rejected the view', ok: false });
    expect(history.size()).toBe(1);
  });
});
