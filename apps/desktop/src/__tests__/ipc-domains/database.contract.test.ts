import { describe, expect, it } from 'vitest';
import { databasePathContract } from '../../ipc-domains/database.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

describe('database path IPC contract', () => {
  it('keeps the profile data path a raw, visible-UI-only capability', () => {
    expect(Object.keys(databasePathContract)).toEqual(['getUserDataPath']);
    expect(databasePathContract.getUserDataPath).toMatchObject({
      channel: DESKTOP_IPC_CHANNELS.db.getUserDataPath,
      envelope: 'raw',
      roles: ['visible-ui'],
    });
  });

  it('rejects arguments before the handler runs', () => {
    expect(databasePathContract.getUserDataPath.parseArgs([])).toEqual([]);
    expect(() => databasePathContract.getUserDataPath.parseArgs(['extra'])).toThrow(
      'database getUserDataPath requires exactly 0 arguments'
    );
  });
});
