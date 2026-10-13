import { describe, expect, it } from 'vitest';
import { resolveGrantedRootHandle } from '../node-workspace/workspace-recent-roots.js';

const storage = {
  getItem: async () => null,
  removeItem: async () => undefined,
  setItem: async () => undefined,
};

describe('workspace grant refusal boundary', () => {
  it('distinguishes never granted from a managed folder without authority', async () => {
    await expect(resolveGrantedRootHandle(storage, '/private/folder')).rejects.toMatchObject({
      failure: {
        category: 'authorization',
        code: 'workspace.never-granted',
        kind: 'refusal',
        remedy: 'Choose this folder with Add folder to grant access.',
      },
    });
    await expect(
      resolveGrantedRootHandle(storage, '/private/managed', async () => 'managed-but-unauthorized')
    ).rejects.toMatchObject({
      failure: {
        category: 'authorization',
        code: 'workspace.managed-not-authorized',
        kind: 'refusal',
      },
    });
  });

  it('keeps a failed authorizer distinct from a denied grant and retains its original cause', async () => {
    const cause = new Error('/private/authorizer/database');
    await expect(
      resolveGrantedRootHandle(storage, '/private/folder', async () => {
        throw cause;
      })
    ).rejects.toMatchObject({
      cause,
      failure: {
        category: 'availability',
        code: 'workspace.authorization-unavailable',
        kind: 'fault',
        remedy: 'Retry connecting the folder.',
      },
    });
  });
});
