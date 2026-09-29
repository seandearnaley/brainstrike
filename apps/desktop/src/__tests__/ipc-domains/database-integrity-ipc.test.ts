import type { DatabaseCorruptionSignal } from '@brainstrike/types';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopDatabaseIntegrity } from '../../database-integrity-state';
import { registerDatabaseIntegrityIpcHandlers } from '../../ipc-domains/database-integrity-ipc';
import { assignWindowRole, clearWindowRoleByWebContentsId } from '../../window-role';
import { createAllowlistedSenderFrame } from '../helpers/desktop-ipc-sender-test-helpers';
import {
  getRegisteredIpcMainHandler,
  mockIpcMain,
  resetElectronMainTestHarness,
} from '../helpers/electron-main-test-harness';

const STATE_CHANNEL = 'db:integrity:state';
const CHANGED_CHANNEL = 'db:integrity:changed';
const SIGNAL: DatabaseCorruptionSignal = { message: 'zero page', sqlstate: 'XX002' };

const createIntegrity = () =>
  createDesktopDatabaseIntegrity({
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  });

let nextWebContentsId = 7_700_000;
const trackedIds: number[] = [];

/** A tracked window whose `webContents.send` is observable. */
function trackWindow(
  role: Parameters<typeof assignWindowRole>[1],
  options: { readonly destroyed?: boolean; readonly sendThrows?: boolean } = {}
) {
  nextWebContentsId += 1;
  const id = nextWebContentsId;
  const send = vi.fn(() => {
    if (options.sendThrows) {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed');
    }
  });
  const webContents = { id, isDestroyed: () => options.destroyed ?? false, send };
  assignWindowRole({ isDestroyed: () => false, once: vi.fn(), webContents } as never, role);
  trackedIds.push(id);
  return { id, send };
}

describe('registerDatabaseIntegrityIpcHandlers', () => {
  beforeEach(() => {
    resetElectronMainTestHarness();
  });

  afterEach(() => {
    for (const id of trackedIds.splice(0)) {
      clearWindowRoleByWebContentsId(id);
    }
  });

  it('registers only the state read and answers with the current snapshot envelope', async () => {
    const integrity = createIntegrity();
    const dispose = registerDatabaseIntegrityIpcHandlers({ integrity });
    expect(mockIpcMain.handle.mock.calls.map(([channel]) => channel)).toEqual([STATE_CHANNEL]);
    const handler = getRegisteredIpcMainHandler(STATE_CHANNEL);
    const event = {
      sender: { id: trackWindow('visible-ui').id },
      senderFrame: createAllowlistedSenderFrame('visible-ui'),
    } as unknown as IpcMainInvokeEvent;

    await expect(handler(event)).resolves.toEqual({
      ok: true,
      value: { revision: 0, state: { kind: 'healthy' } },
    });
    integrity.contain('db:query', SIGNAL);
    await expect(handler(event)).resolves.toEqual({ ok: true, value: integrity.getSnapshot() });
    dispose();
  });

  it('publishes each change to visible-ui and embedding-host windows only', () => {
    const integrity = createIntegrity();
    const receivers = [
      trackWindow('visible-ui'),
      trackWindow('visible-ui'),
      trackWindow('embedding-host'),
    ];
    const others = [trackWindow('chunking-host'), trackWindow('llm-host')];
    const dispose = registerDatabaseIntegrityIpcHandlers({ integrity });

    const contained = integrity.contain('db:query', SIGNAL);
    const healthy = integrity.markDatabaseReplaced('developer-reset');

    for (const window of receivers) {
      expect(window.send.mock.calls).toEqual([
        [CHANGED_CHANNEL, contained],
        [CHANGED_CHANNEL, healthy],
      ]);
    }
    for (const window of others) {
      expect(window.send).not.toHaveBeenCalled();
    }
    dispose();
  });

  it('skips a destroyed webContents and survives a send that throws', () => {
    const integrity = createIntegrity();
    const destroyed = trackWindow('visible-ui', { destroyed: true });
    const broken = trackWindow('visible-ui', { sendThrows: true });
    const live = trackWindow('embedding-host');
    const dispose = registerDatabaseIntegrityIpcHandlers({ integrity });

    const contained = integrity.contain('db:query', SIGNAL);

    expect(destroyed.send).not.toHaveBeenCalled();
    expect(broken.send).toHaveBeenCalledTimes(1);
    expect(live.send).toHaveBeenCalledExactlyOnceWith(CHANGED_CHANNEL, contained);
    dispose();
  });

  it('unsubscribes and unregisters the handler when disposed', () => {
    const integrity = createIntegrity();
    const visible = trackWindow('visible-ui');
    const dispose = registerDatabaseIntegrityIpcHandlers({ integrity });

    dispose();
    integrity.contain('db:query', SIGNAL);

    expect(visible.send).not.toHaveBeenCalled();
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(STATE_CHANNEL);
  });
});
