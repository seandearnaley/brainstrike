import { afterEach, describe, expect, it } from 'vitest';
import { resolveAssistantOperatingRootBinding } from '../assistant-operating-root';

function installRoots(rows: readonly { id: string; path: string; status: string }[]): void {
  Object.defineProperty(window, 'threadGroups', {
    configurable: true,
    value: { readRoots: async () => ({ ok: true, value: rows }) },
  });
}

afterEach(() => Reflect.deleteProperty(window, 'threadGroups'));

describe('resolveAssistantOperatingRootBinding', () => {
  it('binds the mounted adapter root to the durable live root id for its path', async () => {
    installRoots([{ id: 'db-root-a', path: '/workspace-a', status: 'live' }]);

    await expect(
      resolveAssistantOperatingRootBinding({ displayName: 'ProjectA', path: '/workspace-a' })
    ).resolves.toEqual({
      displayName: 'ProjectA',
      path: '/workspace-a',
      rootId: 'db-root-a',
    });
  });

  it('fails visibly when the mounted root has no live durable identity', async () => {
    installRoots([]);

    await expect(
      resolveAssistantOperatingRootBinding({ displayName: 'ProjectA', path: '/workspace-a' })
    ).rejects.toThrow('ProjectA');
  });
});
