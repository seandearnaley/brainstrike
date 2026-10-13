import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import type { DbHandle } from '@brainstrike/db/react';
import type { ThreadCatalogRoot } from '@brainstrike/types';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveAssistantOperatingRootBinding } from '../assistant-operating-root';
import { resolveRootIdAfterReconciliation } from '../hooks/use-workspace-bar-root-row-lookup';

// Current Main roots projection: the registry has already committed the ID
// before Add/Re-add/managed worktree mounting returns to the visible renderer.
const root: ThreadCatalogRoot = {
  displayName: 'bright-fox',
  id: '01119602-b67e-4e7e-83ad-ab54def811ef',
  path: '/fixture/managed/bright-fox',
  status: 'live',
};
const candidate = { displayName: root.displayName, path: root.path };
function install(readRoots: () => Promise<readonly ThreadCatalogRoot[]>) {
  Object.defineProperty(window, 'threadGroups', {
    configurable: true,
    value: { readRoots: async () => ({ ok: true, value: await readRoots() }) },
  });
}
afterEach(() => Reflect.deleteProperty(window, 'threadGroups'));

it('uses the committed managed-worktree identity without a database provider', async () => {
  install(async () => [root]);
  await expect(resolveRootIdAfterReconciliation(null, candidate, () => false)).resolves.toEqual({
    kind: 'resolved',
    rootId: root.id,
  });
  await expect(resolveAssistantOperatingRootBinding(null, candidate)).resolves.toEqual({
    ...candidate,
    rootId: root.id,
  });
});

it('retains the same identity after disconnect and explicit re-add', async () => {
  let status: ThreadCatalogRoot['status'] = 'disconnected';
  install(async () => [{ ...root, status }]);
  await expect(
    resolveRootIdAfterReconciliation(null, candidate, () => false)
  ).resolves.toMatchObject({ kind: 'unresolved' });
  status = 'live';
  await expect(resolveRootIdAfterReconciliation(null, candidate, () => false)).resolves.toEqual({
    kind: 'resolved',
    rootId: root.id,
  });
});

it('propagates a native read failure without retrying or querying SQL', async () => {
  const cause = new Error('recorded roots read failure');
  const readRoots = vi.fn(async () => {
    throw cause;
  });
  const query = vi.fn(async () => {
    throw new Error('PG forbidden');
  });
  install(readRoots);
  await expect(
    resolveRootIdAfterReconciliation({ query } as unknown as DbHandle, candidate, () => false)
  ).resolves.toMatchObject({ error: { cause, failure: INTERNAL_FAULT }, kind: 'unresolved' });
  expect(readRoots).toHaveBeenCalledOnce();
  expect(query).not.toHaveBeenCalled();
});

it('refuses an ambiguous canonical path rather than choosing a root', async () => {
  install(async () => [root, { ...root, id: 'another-current-root' }]);
  await expect(
    resolveRootIdAfterReconciliation(null, candidate, () => false)
  ).resolves.toMatchObject({ kind: 'unresolved' });
});

it('does not attach a resolved root after the originating thread changes', async () => {
  const read = Promise.withResolvers<readonly ThreadCatalogRoot[]>();
  let cancelled = false;
  install(() => read.promise);
  const pending = resolveRootIdAfterReconciliation(null, candidate, () => cancelled);
  cancelled = true;
  read.resolve([root]);
  await expect(pending).resolves.toEqual({ kind: 'cancelled' });
});
