import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHostCredentials } from '@brainstrike/host-capabilities/credentials';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createAllowlistedSenderFrame,
  reconfigureTestRendererTargetAfterModuleReset,
} from '../helpers/desktop-ipc-sender-frame-test-allowlist';
import { invokeDesktopIpcFrom } from '../helpers/desktop-ipc-sender-test-helpers';

vi.mock('electron', () => ({
  app: { getPath: () => '/unused-in-this-test' },
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
}));

vi.mock('../../app-windows', () => ({
  isAppWindowSender: () => true,
}));

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';
const profiles: string[] = [];

afterEach(async () => {
  process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
  for (const profile of profiles.splice(0)) {
    await rm(profile, { force: true, recursive: true });
  }
});

it.each([
  ['production', 'production'],
  ['isolated test', 'test'],
])(
  'factory reset wipes the profile credential store in %s mode (file backend)',
  async (_mode, nodeEnv) => {
    vi.resetModules();
    await reconfigureTestRendererTargetAfterModuleReset();
    process.env['NODE_ENV'] = nodeEnv;
    const profile = await mkdtemp(path.join(tmpdir(), 'bs-reset-credentials-'));
    profiles.push(profile);
    const { desktopCredentialStoreSelection } = await import('../../secrets');
    // The file backend stands in for the keyring; the OS keychain is never touched.
    const credentials = createHostCredentials({
      selection: desktopCredentialStoreSelection(profile, true),
    });
    const secrets = credentials.secrets();
    await secrets.saveKey('openai', 'sk-survives-reset');
    await secrets.setCredential('openrouter', { key: 'sk-or-typed', type: 'api_key' });
    expect(await secrets.listProviders()).toEqual(['openai', 'openrouter']);

    const { registerSecretsIpcHandlers } = await import('../../ipc-secrets');
    const { ipcMain } = await import('electron');
    registerSecretsIpcHandlers(secrets, {
      envFileFailures: [],
      readEnvBootstrapReport: () => {
        throw new Error('Not read by factory reset');
      },
    });
    const event = {
      sender: { id: 7101 },
      senderFrame: createAllowlistedSenderFrame(),
    } as unknown as IpcMainInvokeEvent;

    await expect(
      invokeDesktopIpcFrom(ipcMain, event, 'secrets:clearAll', SECRETS_CLEAR_CONFIRMATION_TOKEN)
    ).resolves.toEqual({
      success: true,
    });
    expect(await secrets.listProviders()).toEqual([]);
    await credentials.close();
  }
);
