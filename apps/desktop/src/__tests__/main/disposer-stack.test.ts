import { describe, expect, it, vi } from 'vitest';
import { createDisposerStack } from '../../main/disposer-stack';

describe('createDisposerStack', () => {
  it('unwinds in LIFO order and empties the stack', () => {
    const stack = createDisposerStack();
    const order: string[] = [];
    stack.add('first', () => order.push('first'));
    stack.add('second', () => order.push('second'));
    stack.add('third', () => order.push('third'));

    expect(stack.labels()).toEqual(['first', 'second', 'third']);
    expect(stack.disposeAll()).toEqual([]);
    expect(order).toEqual(['third', 'second', 'first']);
    expect(stack.labels()).toEqual([]);
    expect(stack.disposeAll()).toEqual([]);
  });

  it('isolates a throwing disposer, still runs the rest, and reports the failure by label', () => {
    const stack = createDisposerStack();
    const after = vi.fn();
    const before = vi.fn();
    const boom = new Error('pty reap failed');
    stack.add('after', after);
    stack.add('throws', () => {
      throw boom;
    });
    stack.add('before', before);

    expect(stack.disposeAll()).toEqual([{ error: boom, label: 'throws' }]);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(stack.labels()).toEqual([]);
  });

  it('lets a handle dispose its own entry once, out of order, without touching the others', () => {
    const stack = createDisposerStack();
    const browser = vi.fn();
    const mcp = vi.fn();
    stack.add('mcp', mcp);
    const handle = stack.add('browser', browser);

    handle.dispose();
    handle.dispose();

    expect(browser).toHaveBeenCalledTimes(1);
    expect(mcp).not.toHaveBeenCalled();
    expect(stack.labels()).toEqual(['mcp']);
    // A disposed handle is inert for disposeAll too.
    expect(stack.disposeAll()).toEqual([]);
    expect(browser).toHaveBeenCalledTimes(1);
    expect(mcp).toHaveBeenCalledTimes(1);
  });

  it('rejects a second live entry under the same label but allows reuse after dispose', () => {
    const stack = createDisposerStack();
    const handle = stack.add('browser', vi.fn());
    expect(() => stack.add('browser', vi.fn())).toThrow(
      'Disposer "browser" is already registered.'
    );
    handle.dispose();
    expect(() => stack.add('browser', vi.fn())).not.toThrow();
    expect(() => stack.add('  ', vi.fn())).toThrow('Disposer label must be a non-empty string.');
  });
});
