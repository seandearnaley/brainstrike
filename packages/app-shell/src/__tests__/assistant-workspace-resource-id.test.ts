import { describe, expect, it } from 'vitest';
import { resolveAssistantWorkspaceResourceId } from '../assistant-workspace-resource-id';

describe('resolveAssistantWorkspaceResourceId', () => {
  it('keeps single-root thread identity path-based', () => {
    expect(
      resolveAssistantWorkspaceResourceId({
        activeRootIds: ['root-a'],
        rootDirectoryPath: '/repo/a',
      })
    ).toBe('/repo/a');
  });

  it('requires live root paths before exposing a multi-root resource id', () => {
    expect(
      resolveAssistantWorkspaceResourceId({
        activeRootIds: ['root-a', 'root-b'],
        rootDirectoryPath: '/repo/a',
        rootDirectoryPaths: [],
      })
    ).toBeNull();
  });

  it('uses stable sorted root paths for multi-root thread identity', () => {
    expect(
      resolveAssistantWorkspaceResourceId({
        activeRootIds: ['root-b', 'root-a'],
        rootDirectoryPath: '/repo/b',
        rootDirectoryPaths: ['/repo/b', '/repo/a'],
      })
    ).toBe('assistant-workspace:roots:%2Frepo%2Fa|%2Frepo%2Fb');
  });
});
