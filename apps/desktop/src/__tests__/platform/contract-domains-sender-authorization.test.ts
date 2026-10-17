import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerClipboardIpcHandlers } from '../../ipc-clipboard';
import { registerContextFilesIpcHandlers } from '../../ipc-context-files';
import { mcpAppsContract, mcpPathSelectionContract } from '../../ipc-domains/mcp.contract';
import { registerSkillsIpcHandlers } from '../../ipc-skills';
import { registerUserCommandsIpcHandlers } from '../../ipc-user-commands';
import { registerUserPersonasIpcHandlers } from '../../ipc-user-personas';
import { createDesktopIpcRegistry, registerDomain } from '../../platform/desktop-ipc-registry';
import type { Contract, Handlers } from '../../platform/ipc-contract';
import { clearWindowRoleByWebContentsId } from '../../window-role';
import {
  createAllowlistedSenderFrame,
  createTrustedInvokeEvent,
  trackTestWindowRole,
} from '../helpers/desktop-ipc-sender-test-helpers';
import { mockIpcMain, resetElectronMainTestHarness } from '../helpers/electron-main-test-harness';

/**
 * BST-1648: every contract-registered leaf domain is sender-authorized BY
 * CONSTRUCTION (`registerDomain` has no unauthenticated path). The channel
 * list is read back from `ipcMain.handle` so a channel added later cannot
 * slip past a stale allowlist.
 */
interface ContractDomainCase {
  readonly channels: readonly string[];
  readonly domain: string;
  readonly register: (sentinel: unknown) => () => void;
}

const HIDDEN_SENDER_ID = 8_900_001;
const UNTRACKED_SENDER_ID = 8_900_002;
const SPOOFED_SENDER_ID = 8_900_003;
const VISIBLE_SENDER_ID = 8_900_004;
const SENTINEL = { marker: 'handled' };

const DOMAIN_CASES: readonly ContractDomainCase[] = [
  {
    channels: ['clipboard:write-text'],
    domain: 'clipboard',
    register: () => registerClipboardIpcHandlers({ writeText: vi.fn() }),
  },
  {
    channels: ['context-files:scan'],
    domain: 'contextFiles',
    register: (sentinel) =>
      registerContextFilesIpcHandlers(
        { workspaceRoots: async () => ({ roots: [] }) },
        vi.fn(async () => sentinel as never)
      ),
  },
  {
    channels: ['skills:scan'],
    domain: 'skills',
    register: (sentinel) =>
      registerSkillsIpcHandlers(
        { workspaceRoots: async () => ({ roots: [] }) },
        vi.fn(async () => sentinel as never)
      ),
  },
  {
    channels: ['user-commands:list'],
    domain: 'userCommands',
    register: (sentinel) =>
      registerUserCommandsIpcHandlers(
        { workspaceRoots: async () => ({ roots: [] }) },
        vi.fn(async () => sentinel as never)
      ),
  },
  {
    channels: ['user-personas:list'],
    domain: 'userPersonas',
    register: (sentinel) =>
      registerUserPersonasIpcHandlers(
        { workspaceRoots: async () => ({ roots: [] }) },
        {
          read: async () => {
            throw new Error('Catalog must not run before sender authorization');
          },
        },
        vi.fn(async () => sentinel as never)
      ),
  },
];

function registeredChannels(): string[] {
  return mockIpcMain.handle.mock.calls.map(([channel]) => String(channel));
}

function registeredHandler(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const call = mockIpcMain.handle.mock.calls.find(([registered]) => registered === channel);
  if (!call) {
    throw new Error(`Channel not registered: ${channel}`);
  }
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

describe('contract-registered leaf domains are visible-UI-only by construction (BST-1648)', () => {
  beforeEach(() => {
    resetElectronMainTestHarness();
    trackTestWindowRole(HIDDEN_SENDER_ID, 'embedding-host');
    trackTestWindowRole(SPOOFED_SENDER_ID, 'visible-ui');
  });

  afterEach(() => {
    for (const id of [HIDDEN_SENDER_ID, SPOOFED_SENDER_ID, VISIBLE_SENDER_ID]) {
      clearWindowRoleByWebContentsId(id);
    }
  });

  describe.each(DOMAIN_CASES)('$domain', ({ channels, register }) => {
    it('registers exactly the expected invoke channels', () => {
      const dispose = register(SENTINEL);
      expect(registeredChannels().sort()).toEqual([...channels].sort());
      dispose();
    });

    it.each(channels)(
      '%s accepts the visible UI and replies with the result envelope',
      async (channel) => {
        const dispose = register(SENTINEL);
        const event = createTrustedInvokeEvent('visible-ui', VISIBLE_SENDER_ID);

        await expect(registeredHandler(channel)(event, 'text')).resolves.toMatchObject({
          ok: true,
        });
        dispose();
      }
    );

    it.each(channels)('%s rejects a hidden embedding-host sender', async (channel) => {
      const dispose = register(SENTINEL);
      const event = {
        sender: { id: HIDDEN_SENDER_ID },
        senderFrame: createAllowlistedSenderFrame('embedding-host'),
      } as unknown as IpcMainInvokeEvent;

      await expect(registeredHandler(channel)(event, 'text')).rejects.toThrow(
        `Desktop IPC ${channel} requires sender role visible-ui.`
      );
      dispose();
    });

    it.each(channels)('%s rejects an untracked sender', async (channel) => {
      const dispose = register(SENTINEL);
      const event = {
        sender: { id: UNTRACKED_SENDER_ID },
        senderFrame: createAllowlistedSenderFrame('visible-ui'),
      } as unknown as IpcMainInvokeEvent;

      await expect(registeredHandler(channel)(event, 'text')).rejects.toThrow(
        `Desktop IPC ${channel} requires sender role visible-ui.`
      );
      dispose();
    });

    it.each(channels)(
      '%s rejects a visible-UI sender whose frame left the allowlist',
      async (channel) => {
        const dispose = register(SENTINEL);
        const event = {
          sender: { id: SPOOFED_SENDER_ID },
          senderFrame: { url: 'https://evil.example/' },
        } as unknown as IpcMainInvokeEvent;

        await expect(registeredHandler(channel)(event, 'text')).rejects.toThrow(
          `Desktop IPC ${channel} rejected an unrecognized sender frame URL.`
        );
        dispose();
      }
    );
  });
});

describe('contract-registered MCP invokes are visible-UI-only by construction (BST-996)', () => {
  const contracts = [mcpPathSelectionContract, mcpAppsContract];

  beforeEach(() => {
    resetElectronMainTestHarness();
    trackTestWindowRole(HIDDEN_SENDER_ID, 'embedding-host');
  });

  afterEach(() => {
    clearWindowRoleByWebContentsId(HIDDEN_SENDER_ID);
  });

  it.each(contracts)('rejects hidden senders before parsing every invoke', async (contract) => {
    const registry = createDesktopIpcRegistry({ ipcMain: mockIpcMain as never });
    const handlers = Object.fromEntries(
      Object.entries(contract)
        .filter(([, spec]) => spec.kind === 'invoke')
        .map(([key]) => [key, vi.fn(() => SENTINEL)])
    ) as Handlers<Contract>;
    registerDomain(registry, 'mcp', contract, handlers);
    const event = {
      sender: { id: HIDDEN_SENDER_ID },
      senderFrame: createAllowlistedSenderFrame('embedding-host'),
    } as unknown as IpcMainInvokeEvent;

    for (const spec of Object.values(contract)) {
      if (spec.kind === 'invoke') {
        await expect(registeredHandler(spec.channel)(event, 'malformed')).rejects.toThrow(
          `Desktop IPC ${spec.channel} requires sender role visible-ui.`
        );
      }
    }
  });
});
