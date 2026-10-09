import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHostCredentials } from '@brainstrike/host-capabilities/credentials';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, it, type Mock, vi } from 'vitest';
import {
  createAllowlistedSenderFrame,
  reconfigureTestRendererTargetAfterModuleReset,
} from '../helpers/desktop-ipc-sender-frame-test-allowlist';

vi.mock('electron', () => ({
  app: { getPath: () => '/unused-in-this-test' },
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
}));

vi.mock('../../window-role', () => ({
  getWindowRoleByWebContentsId: () => 'visible-ui',
}));

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const profiles: string[] = [];

afterEach(async () => {
  process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
  for (const profile of profiles.splice(0)) {
    await rm(profile, { force: true, recursive: true });
  }
});

it("a key saved through Settings in test mode is the one the host's credential store reads", async () => {
  vi.resetModules();
  await reconfigureTestRendererTargetAfterModuleReset();
  process.env['NODE_ENV'] = 'test';
  const profile = await mkdtemp(path.join(tmpdir(), 'bs-test-mode-credentials-'));
  profiles.push(profile);
  const { desktopCredentialStoreSelection } = await import('../../secrets');
  // The isolated profile file both Settings and the host open in test mode.
  const settings = createHostCredentials({
    selection: desktopCredentialStoreSelection(profile, true),
  });
  const { registerSecretsIpcHandlers } = await import('../../ipc-secrets');
  const { ipcMain } = await import('electron');
  registerSecretsIpcHandlers(settings.secrets(), {
    envFileFailures: [],
    readEnvBootstrapReport: () => {
      throw new Error('Not read by a key save');
    },
  });
  const handle = ipcMain.handle as unknown as Mock<
    (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void
  >;
  const save = handle.mock.calls.find(([channel]) => channel === 'secrets:save')?.[1];
  const event = {
    sender: { id: 7101 },
    senderFrame: createAllowlistedSenderFrame(),
  } as unknown as IpcMainInvokeEvent;

  await expect(save?.(event, 'openrouter', 'sk-or-test-mode-key')).resolves.toBe(true);

  const host = createHostCredentials({ selection: desktopCredentialStoreSelection(profile, true) });
  await expect(host.secrets().getKey('openrouter')).resolves.toBe('sk-or-test-mode-key');
  await host.close();
  await settings.close();
});
