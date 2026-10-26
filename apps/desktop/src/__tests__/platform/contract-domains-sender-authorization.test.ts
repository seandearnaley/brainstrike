import { afterEach, describe, expect, it, vi } from 'vitest';
import { untrackAppWindow } from '../../app-windows';
import { registerClipboardIpcHandlers } from '../../ipc-clipboard';
import { registerContextFilesIpcHandlers } from '../../ipc-context-files';
import { mcpAppsContract, mcpPathSelectionContract } from '../../ipc-domains/mcp.contract';
import { registerUserPersonasIpcHandlers } from '../../ipc-user-personas';
import { createDesktopIpcRegistry, registerDomain } from '../../platform/desktop-ipc-registry';
import type { Contract, Handlers } from '../../platform/ipc-contract';
import {
  createAllowlistedSenderFrame,
  createTrustedInvokeEvent,
  invokeDesktopIpcFrom,
  trackTestAppWindow,
} from '../helpers/desktop-ipc-sender-test-helpers';
import { mockIpcMain } from '../helpers/electron-main-test-harness';

/**
 * BST-1648: every contract-registered leaf domain is sender-authorized BY
 * CONSTRUCTION: the one dispatcher authorizes each call before any handler
 * or `parseArgs` runs.
 */
interface ContractDomainCase {
  readonly domain: string;
  readonly methods: readonly string[];
  readonly register: (sentinel: unknown) => () => void;
}

const UNTRACKED_SENDER_ID = 8_900_002;
const SPOOFED_SENDER_ID = 8_900_003;
const APP_SENDER_ID = 8_900_004;
const SENTINEL = { marker: 'handled' };

const DOMAIN_CASES: readonly ContractDomainCase[] = [
  {
    domain: 'clipboard',
    methods: ['clipboard:write-text'],
    register: () => registerClipboardIpcHandlers({ writeText: vi.fn() }),
  },
  {
    domain: 'contextFiles',
    methods: ['context-files:scan'],
    register: (sentinel) =>
      registerContextFilesIpcHandlers(
        { workspaceRoots: async () => ({ roots: [] }) },
        vi.fn(async () => sentinel as never)
      ),
  },
  {
    domain: 'userPersonas',
    methods: ['user-personas:list'],
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

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  for (const id of [SPOOFED_SENDER_ID, APP_SENDER_ID]) {
    untrackAppWindow(id);
  }
});

describe('contract-registered leaf domains are app-window-only by construction (BST-1648)', () => {
  describe.each(DOMAIN_CASES)('$domain', ({ methods, register }) => {
    it.each(methods)('%s answers an app window with the result envelope', async (method) => {
      dispose = register(SENTINEL);

      await expect(
        invokeDesktopIpcFrom(mockIpcMain, createTrustedInvokeEvent(APP_SENDER_ID), method, 'text')
      ).resolves.toMatchObject({ ok: true });
    });

    it.each(methods)('%s refuses an untracked sender', async (method) => {
      dispose = register(SENTINEL);
      const event = {
        sender: { id: UNTRACKED_SENDER_ID },
        senderFrame: createAllowlistedSenderFrame(),
      };

      await expect(invokeDesktopIpcFrom(mockIpcMain, event, method, 'text')).rejects.toThrow(
        `Desktop IPC ${method} requires an app window sender.`
      );
    });

    it.each(methods)('%s refuses an app window whose frame left the allowlist', async (method) => {
      dispose = register(SENTINEL);
      trackTestAppWindow(SPOOFED_SENDER_ID);
      const event = {
        sender: { id: SPOOFED_SENDER_ID },
        senderFrame: { url: 'https://evil.example/' },
      };

      await expect(invokeDesktopIpcFrom(mockIpcMain, event, method, 'text')).rejects.toThrow(
        `Desktop IPC ${method} rejected an unrecognized sender frame URL.`
      );
    });

    it.each(methods)('%s is gone once the domain is disposed', async (method) => {
      register(SENTINEL)();

      await expect(
        invokeDesktopIpcFrom(mockIpcMain, createTrustedInvokeEvent(APP_SENDER_ID), method, 'text')
      ).rejects.toThrow(`No desktop IPC handler for ${method}.`);
    });
  });
});

describe('contract-registered MCP invokes are app-window-only by construction (BST-996)', () => {
  it.each([mcpPathSelectionContract, mcpAppsContract])(
    'refuses an untracked sender before parsing every invoke',
    async (contract) => {
      const registry = createDesktopIpcRegistry({ ipcMain: mockIpcMain as never });
      dispose = () => registry.unregisterAll();
      const handlers = Object.fromEntries(
        Object.entries(contract)
          .filter(([, spec]) => spec.kind === 'invoke')
          .map(([key]) => [key, vi.fn(() => SENTINEL)])
      ) as Handlers<Contract>;
      registerDomain(registry, 'mcp', contract, handlers);
      const event = {
        sender: { id: UNTRACKED_SENDER_ID },
        senderFrame: createAllowlistedSenderFrame(),
      };

      for (const spec of Object.values(contract)) {
        if (spec.kind === 'invoke') {
          await expect(
            invokeDesktopIpcFrom(mockIpcMain, event, spec.channel, 'malformed')
          ).rejects.toThrow(`Desktop IPC ${spec.channel} requires an app window sender.`);
        }
      }
      for (const handler of Object.values(handlers)) {
        expect(handler).not.toHaveBeenCalled();
      }
    }
  );
});
