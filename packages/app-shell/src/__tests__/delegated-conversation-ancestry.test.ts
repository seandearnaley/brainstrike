import type { DelegatedConversationNode, DelegatedConversationRepository } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { loadDelegatedConversationAncestry } from '../delegated-conversation-ancestry';

const root: DelegatedConversationNode = {
  color: null,
  configuration: null,
  createdAt: new Date('2026-09-10'),
  displayName: null,
  ownerResourceId: 'owner',
  parentThreadId: null,
  resourceId: 'owner',
  rootThreadId: 'root',
  threadId: 'root',
  workspaceRootId: null,
};
const child = (threadId: string, parentThreadId: string): DelegatedConversationNode => ({
  ...root,
  color: 'emerald',
  configuration: {},
  displayName: threadId,
  parentThreadId,
  resourceId: `native:${threadId}`,
  threadId,
});
const cedar = child('Cedar', 'root');
const wren = child('Wren', 'Cedar');
const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
const repositoryFor = (nodes: readonly DelegatedConversationNode[]) => ({
  get: vi.fn<DelegatedConversationRepository['get']>(
    async (_scope, id) => nodes.find((node) => node.threadId === id) ?? null
  ),
});

describe('durable conversation ancestry', () => {
  it('returns only the exact root-to-child path, with native identities and no sibling lookup', async () => {
    const repository = repositoryFor([root, cedar, child('Flint', 'root')]);
    const result = await loadDelegatedConversationAncestry(repository, wren);
    expect(result).toEqual({ children: [cedar, wren], root });
    expect(repository.get.mock.calls).toEqual([
      [scope, 'Cedar'],
      [scope, 'root'],
    ]);
  });
  it('rejects a missing ancestor instead of displaying an incomplete trail', async () => {
    await expect(loadDelegatedConversationAncestry(repositoryFor([root]), wren)).rejects.toThrow(
      /ancestry/i
    );
  });
  it('rejects a cycle rather than looping or truncating the trail', async () => {
    await expect(
      loadDelegatedConversationAncestry(
        repositoryFor([wren, { ...cedar, parentThreadId: 'Wren' }]),
        wren
      )
    ).rejects.toThrow(/cycle/i);
  });
  it.each([
    { ...cedar, ownerResourceId: 'other-owner' },
    { ...cedar, rootThreadId: 'other-root' },
    { ...cedar, threadId: 'different-child' },
    { ...cedar, displayName: null },
    { ...cedar, color: null },
  ])('rejects an ancestor outside the selected native path', async (foreign) => {
    const get = vi.fn<DelegatedConversationRepository['get']>(async () => foreign);
    await expect(loadDelegatedConversationAncestry({ get }, wren)).rejects.toThrow(/ancestry/i);
  });
  it('requires a real root boundary with the owning resource and no parent', async () => {
    await expect(
      loadDelegatedConversationAncestry(
        repositoryFor([{ ...root, resourceId: 'native:Cedar' }]),
        cedar
      )
    ).rejects.toThrow(/ancestry/i);
  });
});
