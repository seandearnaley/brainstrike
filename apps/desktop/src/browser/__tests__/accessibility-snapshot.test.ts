import { describe, expect, it } from 'vitest';
import { type AxSnapshotNode, formatAccessibilitySnapshot } from '../accessibility-snapshot';

/**
 * Minimal CDP `Accessibility.getFullAXTree` fixtures. Each node is keyed by
 * `nodeId`; `childIds` builds the tree. `backendDOMNodeId` is what a later
 * click-by-ref resolves against, so the formatter must surface it in `refs`.
 */
function node(partial: Partial<AxSnapshotNode> & { nodeId: string }): AxSnapshotNode {
  return { childIds: [], ignored: false, ...partial };
}

describe('formatAccessibilitySnapshot', () => {
  it('emits an indented role/name tree and assigns refs only to interactive nodes', () => {
    const nodes: AxSnapshotNode[] = [
      node({
        childIds: ['2'],
        name: { value: 'Demo' },
        nodeId: '1',
        role: { value: 'RootWebArea' },
      }),
      node({
        childIds: ['3', '4'],
        name: { value: 'Login' },
        nodeId: '2',
        role: { value: 'form' },
      }),
      node({
        backendDOMNodeId: 101,
        name: { value: 'Email' },
        nodeId: '3',
        role: { value: 'textbox' },
      }),
      node({
        backendDOMNodeId: 102,
        name: { value: 'Submit' },
        nodeId: '4',
        role: { value: 'button' },
      }),
    ];

    const result = formatAccessibilitySnapshot(nodes, { filter: 'all', maxChars: 10_000 });

    expect(result.text).toBe(
      [
        'RootWebArea "Demo"',
        '  form "Login"',
        '    textbox "Email" [ref=e1]',
        '    button "Submit" [ref=e2]',
      ].join('\n')
    );
    // Refs map back to the CDP backend DOM node ids for click/type-by-ref.
    expect(result.refs).toEqual({ e1: 101, e2: 102 });
    expect(result.truncated).toBe(false);
  });

  it('skips ignored nodes and, in interactive filter, drops non-interactive leaves', () => {
    const nodes: AxSnapshotNode[] = [
      node({ childIds: ['2', '3', '4'], nodeId: '1', role: { value: 'RootWebArea' } }),
      node({ name: { value: 'just prose' }, nodeId: '2', role: { value: 'text' } }),
      node({ ignored: true, name: { value: 'Hidden' }, nodeId: '3', role: { value: 'button' } }),
      node({
        backendDOMNodeId: 55,
        name: { value: 'Home' },
        nodeId: '4',
        role: { value: 'link' },
      }),
    ];

    const result = formatAccessibilitySnapshot(nodes, { filter: 'interactive', maxChars: 10_000 });

    // Only the interactive, non-ignored link survives (plus its structural root).
    expect(result.text).toBe(['RootWebArea', '  link "Home" [ref=e1]'].join('\n'));
    expect(result.refs).toEqual({ e1: 55 });
  });

  it('truncates at maxChars and flags it', () => {
    const nodes: AxSnapshotNode[] = [
      node({ childIds: ['2', '3'], nodeId: '1', role: { value: 'RootWebArea' } }),
      node({
        backendDOMNodeId: 1,
        name: { value: 'A'.repeat(50) },
        nodeId: '2',
        role: { value: 'button' },
      }),
      node({
        backendDOMNodeId: 2,
        name: { value: 'B'.repeat(50) },
        nodeId: '3',
        role: { value: 'button' },
      }),
    ];

    const result = formatAccessibilitySnapshot(nodes, { filter: 'all', maxChars: 40 });

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(40);
  });
});
