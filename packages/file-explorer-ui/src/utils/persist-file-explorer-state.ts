import type { createFileExplorerStore } from '@brainstrike/file-explorer';

export type PersistableFileExplorerStore = Pick<
  ReturnType<typeof createFileExplorerStore>,
  'getState' | 'persist' | 'persistImmediately'
>;

export async function persistFileExplorerStateImmediately(
  store: PersistableFileExplorerStore
): Promise<void> {
  await store.persistImmediately();
}
