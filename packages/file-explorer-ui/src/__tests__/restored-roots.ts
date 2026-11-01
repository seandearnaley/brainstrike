import type { DirectoryHandle, RootDescriptor } from '@brainstrike/types';

/** What a desktop adapter's `restoreRoots` answers for one granted open folder, or none. */
export function grantedRoots(handle: DirectoryHandle | null): RootDescriptor[] {
  if (!handle) {
    return [];
  }
  return [
    {
      displayName: handle.name,
      handle,
      kind: 'path',
      permissionState: 'granted',
      persisted: true,
      rootId: handle.rootId ?? `${handle.name}-id`,
    },
  ];
}
