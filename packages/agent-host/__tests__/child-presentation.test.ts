import { describe, expect, it } from 'vitest';
import { hostChildColors } from '../src/child-presentation.ts';

const tree = [
  { parentThreadId: 'root', threadId: 'supervisor-a' },
  { parentThreadId: 'root', threadId: 'supervisor-b' },
  { parentThreadId: 'supervisor-a', threadId: 'leaf-a1' },
  { parentThreadId: 'supervisor-a', threadId: 'leaf-a2' },
  { parentThreadId: 'supervisor-b', threadId: 'leaf-b1' },
  { parentThreadId: 'supervisor-b', threadId: 'leaf-b2' },
];

describe('host child colours', () => {
  it('a child keeps the colour it started with as later children are created', () => {
    const whole = hostChildColors('root', 'rose', tree);
    let grown = hostChildColors('root', 'rose', []);
    for (let count = 1; count <= tree.length; count += 1) {
      grown = hostChildColors('root', 'rose', tree.slice(0, count), grown);
      for (const { threadId } of tree.slice(0, count)) {
        expect(grown.colors.get(threadId)).toBe(whole.colors.get(threadId));
      }
    }
    expect(new Set(whole.colors.values()).size).toBe(tree.length + 1);
  });

  it('recolours the tree when the root colour or the earlier children change', () => {
    const previous = hostChildColors('root', 'rose', tree);
    expect(hostChildColors('root', 'blue', tree, previous).colors).toEqual(
      hostChildColors('root', 'blue', tree).colors
    );
    const withoutFirst = tree.slice(1).filter(({ parentThreadId }) => parentThreadId === 'root');
    expect(hostChildColors('root', 'rose', withoutFirst, previous).colors).toEqual(
      hostChildColors('root', 'rose', withoutFirst).colors
    );
  });
});
