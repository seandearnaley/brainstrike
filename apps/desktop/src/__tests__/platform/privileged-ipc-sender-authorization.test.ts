import { afterEach, describe, expect, it, vi } from 'vitest';
import { untrackAppWindow } from '../../app-windows';
import type { BrowserIpcHandlers } from '../../browser-ipc-handlers';
import { registerBrowserIpcHandlers } from '../../ipc-browser';
import { registerShellIpcHandlers } from '../../ipc-shell';
import type { ShellIpcHandlers } from '../../ipc-shell-handlers';
import {
  createAllowlistedSenderFrame,
  createTrustedInvokeEvent,
  invokeDesktopIpcFrom,
  trackTestAppWindow,
} from '../helpers/desktop-ipc-sender-test-helpers';
import { mockIpcMain } from '../helpers/electron-main-test-harness';

/**
 * BST-1641: every method these registrars own is served only to an app window
 * whose frame is on the allowlist; the one dispatcher checks both before the
 * handler runs.
 */
interface PrivilegedDomainCase {
  readonly domain: string;
  readonly methods: readonly string[];
  readonly register: (stub: () => unknown) => () => void;
}

const UNTRACKED_SENDER_ID = 8_800_002;
const SPOOFED_SENDER_ID = 8_800_003;
const APP_SENDER_ID = 8_800_004;

/** A handler object whose every method is one shared recording mock. */
function createRecordingStub<T extends object>(): {
  readonly calls: ReturnType<typeof vi.fn>;
  readonly stub: T;
} {
  const calls = vi.fn(async () => ({ ok: true }));
  const stub = new Proxy({} as T, {
    get: () => calls,
  });
  return { calls, stub };
}

const DOMAIN_CASES: readonly PrivilegedDomainCase[] = [
  {
    domain: 'shell',
    methods: ['shell:show-item-in-folder', 'shell:open-path', 'shell:open-external'],
    register: (stub) => registerShellIpcHandlers(stub() as ShellIpcHandlers),
  },
  {
    domain: 'browser',
    methods: [
      'browser:createTab',
      'browser:closeTab',
      'browser:showTab',
      'browser:navigate',
      'browser:goBack',
      'browser:goForward',
      'browser:reload',
      'browser:setBounds',
      'browser:setOccluded',
      'browser:listTabs',
    ],
    register: (stub) => registerBrowserIpcHandlers(stub() as BrowserIpcHandlers),
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

describe('privileged desktop IPC domains are app-window-only (BST-1641)', () => {
  describe.each(DOMAIN_CASES)('$domain', ({ methods, register }) => {
    it.each(methods)('%s answers an app window with an allowlisted frame', async (method) => {
      const { calls, stub } = createRecordingStub();
      dispose = register(() => stub);
      const event = createTrustedInvokeEvent(APP_SENDER_ID);

      await expect(
        invokeDesktopIpcFrom(mockIpcMain, event, method, { rootId: 'r1' })
      ).resolves.toEqual({ ok: true });
      expect(calls).toHaveBeenCalledTimes(1);
    });

    it.each(methods)('%s refuses an untracked sender', async (method) => {
      const { calls, stub } = createRecordingStub();
      dispose = register(() => stub);
      const event = {
        sender: { id: UNTRACKED_SENDER_ID },
        senderFrame: createAllowlistedSenderFrame(),
      };

      await expect(
        invokeDesktopIpcFrom(mockIpcMain, event, method, { rootId: 'r1' })
      ).rejects.toThrow(`Desktop IPC ${method} requires an app window sender.`);
      expect(calls).not.toHaveBeenCalled();
    });

    it.each(methods)(
      '%s refuses an app window whose frame navigated off the allowlist',
      async (method) => {
        const { calls, stub } = createRecordingStub();
        dispose = register(() => stub);
        trackTestAppWindow(SPOOFED_SENDER_ID);
        const event = {
          sender: { id: SPOOFED_SENDER_ID },
          senderFrame: { url: 'https://evil.example/' },
        };

        await expect(
          invokeDesktopIpcFrom(mockIpcMain, event, method, { rootId: 'r1' })
        ).rejects.toThrow(`Desktop IPC ${method} rejected an unrecognized sender frame URL.`);
        expect(calls).not.toHaveBeenCalled();
      }
    );

    it.each(methods)('%s is gone once the domain is disposed', async (method) => {
      const { stub } = createRecordingStub();
      register(() => stub)();

      await expect(
        invokeDesktopIpcFrom(mockIpcMain, createTrustedInvokeEvent(APP_SENDER_ID), method)
      ).rejects.toThrow(`No desktop IPC handler for ${method}.`);
    });
  });
});
