import { expect, test, vi } from 'vitest';
import { registerViewFilterPresetsIpc } from '../ipc-view-filter-presets';
import {
  createAllowlistedSenderFrame,
  invokeDesktopIpc,
  invokeDesktopIpcFrom,
} from './helpers/desktop-ipc-sender-test-helpers';

const { ipcMain } = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => ({ ipcMain }));

const METHOD = 'view-filter-presets:request';
function invoke(input: unknown) {
  return invokeDesktopIpc(ipcMain, METHOD, input);
}
function invokeFromUntrackedSender(input: unknown) {
  return invokeDesktopIpcFrom(
    ipcMain,
    { sender: { id: 970_405 }, senderFrame: createAllowlistedSenderFrame() },
    METHOD,
    input
  );
}
test('app-window preset writes reach the injected owner once and untracked/malformed writes never do', async () => {
  const viewFilterPresets = vi.fn(async () => ({ deleted: true, presets: [] }));
  const close = registerViewFilterPresetsIpc({ viewFilterPresets });
  await expect(invoke({ id: 'preset', operation: 'delete' })).resolves.toMatchObject({
    ok: true,
  });
  expect(viewFilterPresets).toHaveBeenCalledWith({ id: 'preset', operation: 'delete' });
  await expect(invokeFromUntrackedSender({ id: 'preset', operation: 'delete' })).rejects.toThrow(
    `Desktop IPC ${METHOD} requires an app window sender.`
  );
  await expect(
    invoke({ id: 'preset', input: { isDefault: true }, operation: 'update' })
  ).rejects.toThrow('invalid arguments');
  await expect(
    invoke({
      input: { excludes: [], icon: 'unknown', includes: [], name: 'test' },
      operation: 'create',
    })
  ).rejects.toThrow('invalid arguments');
  expect(viewFilterPresets).toHaveBeenCalledOnce();
  close();
  await expect(invoke({ id: 'preset', operation: 'delete' })).rejects.toThrow(
    `No desktop IPC handler for ${METHOD}.`
  );
});
