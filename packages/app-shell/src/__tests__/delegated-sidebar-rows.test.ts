import { describe, expect, it } from 'vitest';
import {
  type DelegatedSidebarAddress,
  projectDelegatedSidebarRows,
} from '../delegated-sidebar-rows';
import type { ChildNode } from '../delegated-workspace-node';
import { delegatedWorkspaceTabId } from '../delegated-workspace-tab';
import type { ThreadPanelVisibleRow } from '../thread-panel-visible-rows';

const root: ThreadPanelVisibleRow = {
  groupId: null,
  id: 'root',
  kind: 'thread',
  parentId: null,
  thread: {
    createdAt: new Date(),
    id: 'root',
    resourceId: 'owner',
    title: 'Main',
    updatedAt: new Date(),
  },
};
const parent: DelegatedSidebarAddress = {
  depth: 0,
  groupId: null,
  id: 'root',
  ownerResourceId: 'owner',
  parentThreadId: null,
  rootThreadId: 'root',
  threadId: 'root',
};
const child = (name: string, parentThreadId = 'root'): ChildNode => ({
  color: 'emerald',
  configuration: {},
  createdAt: new Date(),
  displayName: name,
  ownerResourceId: 'owner',
  parentThreadId,
  resourceId: `native:${name}`,
  rootThreadId: 'root',
  threadId: name,
  workspaceRootId: null,
});
const expanded = new Map([['root', parent]]);
describe('delegated rows in the ordinary thread tree', () => {
  it('preserves native ancestry without putting children in the root thread row kind', () => {
    const cedar = child('Cedar');
    const wren = child('Wren', 'Cedar');
    const id = delegatedWorkspaceTabId(cedar);
    const rows = projectDelegatedSidebarRows(
      [root],
      new Map([...expanded, [id, { ...cedar, depth: 1, groupId: null, id }]]),
      new Map([
        ['root', { children: [cedar, child('Flint')] }],
        [id, { children: [wren] }],
      ]),
      new Map()
    );
    expect(rows.map((row) => row.kind)).toEqual(['thread', 'delegated', 'delegated', 'delegated']);
    expect(rows[2]).toMatchObject({ depth: 2, node: { displayName: 'Wren' }, parentId: id });
    expect(rows.filter((row) => row.kind === 'thread')).toEqual([root]);
    expect(rows[2]).toMatchObject({ parentColor: 'emerald' });
  });
  it('carries the root identity color to its direct children', () => {
    const coloredRoot = {
      ...root,
      thread: { ...root.thread, metadata: { color: 'rose' as const } },
    } as ThreadPanelVisibleRow;
    const rows = projectDelegatedSidebarRows(
      [coloredRoot],
      expanded,
      new Map([['root', { children: [child('Cedar')] }]]),
      new Map()
    );
    expect(rows[1]).toMatchObject({ parentColor: 'rose' });
  });
  it('bounds initial child rows to fifty and exposes an explicit continuation', () => {
    const entries = new Map([
      ['root', { children: Array.from({ length: 73 }, (_, i) => child(`Child ${i}`)) }],
    ]);
    const rows = projectDelegatedSidebarRows([root], expanded, entries, new Map());
    expect(rows.filter((row) => row.kind === 'delegated')).toHaveLength(50);
    expect(rows.at(-1)).toMatchObject({
      kind: 'delegated-state',
      label: 'Show 23 more child conversations',
      moreFor: 'root',
    });
    expect(
      projectDelegatedSidebarRows([root], expanded, entries, new Map([['root', 100]]))
    ).toHaveLength(74);
  });
  it('keeps children with their parent under root filtering and collapse', () => {
    const entries = new Map([['root', { children: [child('Cedar')] }]]);
    expect(projectDelegatedSidebarRows([], expanded, entries, new Map())).toEqual([]);
    expect(projectDelegatedSidebarRows([root], new Map(), entries, new Map())).toEqual([root]);
  });
  it('renders explicit loading and failure states instead of an empty tree', () => {
    expect(projectDelegatedSidebarRows([root], expanded, new Map(), new Map())[1]).toMatchObject({
      label: 'Loading child conversations…',
    });
    expect(
      projectDelegatedSidebarRows(
        [root],
        expanded,
        new Map([['root', { error: new Error('Graph unavailable') }]]),
        new Map()
      )[1]
    ).toMatchObject({ isError: true, label: 'Graph unavailable' });
  });
});
