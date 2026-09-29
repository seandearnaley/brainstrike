import { describe, expect, it } from 'vitest';
import {
  resolveFocusAfterClose,
  resolveRovingTargetIndex,
  resolveTabDropOrder,
} from '../tab-strip-order';

describe('resolveTabDropOrder', () => {
  const orderedIds = ['a', 'b', 'c', 'd'];

  it('inserts before the left edge and after the right edge of the target', () => {
    expect(resolveTabDropOrder({ edge: 'left', orderedIds, sourceId: 'd', targetId: 'b' })).toEqual(
      {
        kind: 'reorder',
        orderedIds: ['a', 'd', 'b', 'c'],
      }
    );
    expect(
      resolveTabDropOrder({ edge: 'right', orderedIds, sourceId: 'a', targetId: 'c' })
    ).toEqual({
      kind: 'reorder',
      orderedIds: ['b', 'c', 'a', 'd'],
    });
  });

  it('returns none for a self-drop or an order-preserving drop', () => {
    expect(resolveTabDropOrder({ edge: 'left', orderedIds, sourceId: 'b', targetId: 'b' })).toEqual(
      {
        kind: 'none',
      }
    );
    expect(
      resolveTabDropOrder({ edge: 'right', orderedIds, sourceId: 'b', targetId: 'a' })
    ).toEqual({
      kind: 'none',
    });
  });

  it('reports a drag that outlived its tab as stale instead of guessing', () => {
    expect(resolveTabDropOrder({ edge: 'left', orderedIds, sourceId: 'z', targetId: 'b' })).toEqual(
      {
        kind: 'stale',
        missingId: 'z',
      }
    );
    expect(resolveTabDropOrder({ edge: 'left', orderedIds, sourceId: 'a', targetId: 'y' })).toEqual(
      {
        kind: 'stale',
        missingId: 'y',
      }
    );
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
