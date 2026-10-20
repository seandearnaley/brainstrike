import { expect, test, vi } from 'vitest';
import { prepareMainCatalogClose } from '../../main/main-catalog-close';

test('producer preparation precedes the catalog fence and reports every failed owner', async () => {
  const events: string[] = [];
  const release = Promise.withResolvers<void>();
  const rootFailure = new Error('Root preparation failed');
  const worktreeFailure = new Error('Worktree preparation failed');
  const catalogFailure = new Error('Catalog preparation failed');
  const catalog = {
    prepareClose: vi.fn(async () => {
      events.push('catalog');
      throw catalogFailure;
    }),
  };
  const closing = prepareMainCatalogClose(
    {
      prepareClose: async () => {
        events.push('roots');
        await release.promise;
        throw rootFailure;
      },
    },
    {
      prepareClose: async () => {
        events.push('worktrees');
        throw worktreeFailure;
      },
    },
    catalog
  );
  const failed = expect(closing).rejects.toMatchObject({
    errors: [rootFailure, worktreeFailure, catalogFailure],
  });
  expect(events).toEqual(['roots']);
  expect(catalog.prepareClose).not.toHaveBeenCalled();
  release.resolve();
  await failed;
  expect(events).toEqual(['roots', 'worktrees', 'catalog']);
});
