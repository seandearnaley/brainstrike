import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserIpcHandlers } from '../../browser-ipc-handlers';
import type { ChangesIpcHandlers } from '../../changes-ipc-handlers';
import type { CommandSessionIpcHandlers } from '../../command-session-ipc-handlers';
import type { GitIpcHandlers } from '../../git-ipc-handlers';
import { registerBrowserIpcHandlers } from '../../ipc-browser';
import { registerChangesIpcHandlers } from '../../ipc-changes';
import { registerGitIpcHandlers } from '../../ipc-git';
import { registerShellIpcHandlers } from '../../ipc-shell';
import type { ShellIpcHandlers } from '../../ipc-shell-handlers';
import { registerTerminalIpc } from '../../ipc-terminal';
import { registerTerminalIpcHandlers, type TerminalIpcHandlers } from '../../terminal-ipc-handlers';
import { clearWindowRoleByWebContentsId } from '../../window-role';
import {
  createAllowlistedSenderFrame,
  createTrustedInvokeEvent,
  trackTestWindowRole,
} from '../helpers/desktop-ipc-sender-test-helpers';
import { mockIpcMain, resetElectronMainTestHarness } from '../helpers/electron-main-test-harness';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../db-main', () => ({ getDatabase: vi.fn() }));

/**
 * BST-1641: every channel these registrars own must be sender-authorized
 * (`registerAuthorizedInvoke`, visible-UI only). The channel list is read
 * back from the harness's `ipcMain.handle` calls rather than typed by hand,
 * so a channel added later with the unauthenticated verb fails the
 * hidden-sender rejection below instead of slipping past a stale allowlist.
 */
interface PrivilegedDomainCase {
  /** Channels a sibling registrar registers in the same call (asserted present, exercised under their own case). */
  readonly alsoRegisters?: readonly string[];
  readonly channels: readonly string[];
  readonly domain: string;
  readonly register: (stub: () => unknown) => () => void;
}

const HIDDEN_SENDER_ID = 8_800_001;
const UNTRACKED_SENDER_ID = 8_800_002;
const SPOOFED_SENDER_ID = 8_800_003;
const VISIBLE_SENDER_ID = 8_800_004;

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

function gitInvokeArgs(channel: string): readonly unknown[] {
  switch (channel) {
    case 'git:aheadBehind':
    case 'git:pull':
    case 'git:repository':
    case 'git:status':
      return ['root-1'];
    case 'git:commit':
      return ['root-1', { summary: 'summary' }];
    case 'git:commitFiles':
      return ['root-1', { commit: 'abc123' }];
    case 'git:createBranch':
    case 'git:switchBranch':
      return ['root-1', { branch: 'feature' }];
    case 'git:diff':
      return ['root-1', { mode: 'working' }];
    case 'git:fetch':
      return ['root-1', { remote: 'origin' }];
    case 'git:history':
      return ['root-1', { limit: 20, offset: 0 }];
    case 'git:push':
    case 'git:stage':
    case 'git:unstage':
      return ['root-1', {}];
    case 'git:structuredFileDiff':
      return ['root-1', { mode: 'working', path: 'src/index.ts' }];
    default:
      throw new Error(`Missing Git authorization fixture for ${channel}`);
  }
}

const DOMAIN_CASES: readonly PrivilegedDomainCase[] = [
  {
    channels: ['terminal:create', 'terminal:write', 'terminal:resize', 'terminal:destroy'],
    domain: 'terminal',
    register: (stub) => registerTerminalIpcHandlers(stub() as TerminalIpcHandlers),
  },
  {
    alsoRegisters: ['terminal:create', 'terminal:write', 'terminal:resize', 'terminal:destroy'],
    channels: [
      'command-sessions:list',
      'command-sessions:read',
      'command-sessions:write',
      'command-sessions:stop',
      'command-sessions:remove',
    ],
    domain: 'commandSessions',
    register: (stub) =>
      registerTerminalIpc(stub() as TerminalIpcHandlers, stub() as CommandSessionIpcHandlers),
  },
  {
    channels: ['shell:show-item-in-folder', 'shell:open-path', 'shell:open-external'],
    domain: 'shell',
    register: (stub) => registerShellIpcHandlers(stub() as ShellIpcHandlers),
  },
  {
    channels: [
      'git:status',
      'git:diff',
      'git:structuredFileDiff',
      'git:stage',
      'git:unstage',
      'git:commit',
      'git:commitFiles',
      'git:aheadBehind',
      'git:fetch',
      'git:history',
      'git:push',
      'git:pull',
      'git:repository',
      'git:createBranch',
      'git:switchBranch',
    ],
    domain: 'git',
    register: (stub) => registerGitIpcHandlers(stub() as GitIpcHandlers),
  },
  {
    channels: [
      'changes:resolveView',
      'changes:fileDiff',
      'changes:inventory',
      'changes:rewindPreview',
      'changes:applyRewind',
      'changes:redoRewind',
      'changes:finalizeRewinds',
    ],
    domain: 'changes',
    register: (stub) => registerChangesIpcHandlers(stub() as ChangesIpcHandlers),
  },
  {
    channels: [
      'browser:createTab',
      'browser:closeTab',
      'browser:selectTab',
      'browser:navigate',
      'browser:goBack',
      'browser:goForward',
      'browser:reload',
      'browser:setBounds',
      'browser:setOccluded',
      'browser:listTabs',
    ],
    domain: 'browser',
    register: (stub) => registerBrowserIpcHandlers(stub() as BrowserIpcHandlers),
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

describe('privileged desktop IPC domains are visible-UI-only (BST-1641)', () => {
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

  describe.each(DOMAIN_CASES)('$domain', ({ alsoRegisters = [], channels, register }) => {
    it('registers exactly the expected invoke channels', () => {
      const { stub } = createRecordingStub();
      const dispose = register(() => stub);
      expect(registeredChannels().sort()).toEqual([...channels, ...alsoRegisters].sort());
      dispose();
    });

    it.each(channels)('%s accepts the visible UI with an allowlisted frame', async (channel) => {
      const { calls, stub } = createRecordingStub();
      const dispose = register(() => stub);
      const event = createTrustedInvokeEvent('visible-ui', VISIBLE_SENDER_ID);

      const args = channel.startsWith('git:') ? gitInvokeArgs(channel) : [{ rootId: 'r1' }];
      await expect(registeredHandler(channel)(event, ...args)).resolves.toEqual({
        ok: true,
      });
      expect(calls).toHaveBeenCalledTimes(1);
      dispose();
    });

    it.each(channels)('%s rejects a hidden embedding-host sender', async (channel) => {
      const { calls, stub } = createRecordingStub();
      const dispose = register(() => stub);
      const event = {
        sender: { id: HIDDEN_SENDER_ID },
        senderFrame: createAllowlistedSenderFrame('embedding-host'),
      } as unknown as IpcMainInvokeEvent;

      await expect(registeredHandler(channel)(event, { rootId: 'r1' })).rejects.toThrow(
        `Desktop IPC ${channel} requires sender role visible-ui.`
      );
      expect(calls).not.toHaveBeenCalled();
      dispose();
    });

    it.each(channels)('%s rejects an untracked sender', async (channel) => {
      const { calls, stub } = createRecordingStub();
      const dispose = register(() => stub);
      const event = {
        sender: { id: UNTRACKED_SENDER_ID },
        senderFrame: createAllowlistedSenderFrame('visible-ui'),
      } as unknown as IpcMainInvokeEvent;

      await expect(registeredHandler(channel)(event, { rootId: 'r1' })).rejects.toThrow(
        `Desktop IPC ${channel} requires sender role visible-ui.`
      );
      expect(calls).not.toHaveBeenCalled();
      dispose();
    });

    it.each(channels)(
      '%s rejects a visible-UI sender whose frame navigated off the allowlist',
      async (channel) => {
        const { calls, stub } = createRecordingStub();
        const dispose = register(() => stub);
        const event = {
          sender: { id: SPOOFED_SENDER_ID },
          senderFrame: { url: 'https://evil.example/' },
        } as unknown as IpcMainInvokeEvent;

        await expect(registeredHandler(channel)(event, { rootId: 'r1' })).rejects.toThrow(
          `Desktop IPC ${channel} rejected an unrecognized sender frame URL.`
        );
        expect(calls).not.toHaveBeenCalled();
        dispose();
      }
    );
  });
});
