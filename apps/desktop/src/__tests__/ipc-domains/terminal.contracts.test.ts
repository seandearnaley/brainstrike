import {
  COMMAND_SESSION_BRIDGE_REQUIRED_METHODS,
  TERMINAL_BRIDGE_REQUIRED_METHODS,
} from '@brainstrike/app-shell/terminal-panel/availability';
import { describe, expect, it } from 'vitest';
import { commandSessionsContract } from '../../ipc-domains/command-sessions.contract';
import { terminalContract } from '../../ipc-domains/terminal.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

describe('terminal IPC contracts', () => {
  it('derives the exact renderer bridge key sets', () => {
    expect(Object.keys(terminalContract).sort()).toEqual(
      [...TERMINAL_BRIDGE_REQUIRED_METHODS].sort()
    );
    expect(Object.keys(commandSessionsContract).sort()).toEqual(
      [...COMMAND_SESSION_BRIDGE_REQUIRED_METHODS].sort()
    );
  });

  it('keeps established result envelopes raw and invokes visible-UI-only', () => {
    for (const contract of [terminalContract, commandSessionsContract]) {
      for (const spec of Object.values(contract)) {
        if (spec.kind === 'push') {
          continue;
        }
        expect(spec).toMatchObject({ envelope: 'raw', roles: ['visible-ui'] });
      }
    }
  });

  it('classifies terminal output and exit as main-to-renderer pushes', () => {
    expect(terminalContract.onData).toEqual({
      channel: DESKTOP_IPC_CHANNELS.terminal.data,
      kind: 'push',
    });
    expect(terminalContract.onExit).toEqual({
      channel: DESKTOP_IPC_CHANNELS.terminal.exit,
      kind: 'push',
    });
  });

  it('maps every invoke to its manifest channel', () => {
    expect({
      create: terminalContract.create.channel,
      destroy: terminalContract.destroy.channel,
      resize: terminalContract.resize.channel,
      write: terminalContract.write.channel,
    }).toEqual({
      create: DESKTOP_IPC_CHANNELS.terminal.create,
      destroy: DESKTOP_IPC_CHANNELS.terminal.destroy,
      resize: DESKTOP_IPC_CHANNELS.terminal.resize,
      write: DESKTOP_IPC_CHANNELS.terminal.write,
    });
    expect({
      list: commandSessionsContract.list.channel,
      read: commandSessionsContract.read.channel,
      remove: commandSessionsContract.remove.channel,
      stop: commandSessionsContract.stop.channel,
      write: commandSessionsContract.write.channel,
    }).toEqual(DESKTOP_IPC_CHANNELS.commandSessions);
  });

  it('parses every terminal invoke into its handler tuple', () => {
    expect(
      terminalContract.create.parseArgs([
        { cols: 120, cwd: '/workspace/repo', rootId: 'root-1', rows: 40 },
      ])
    ).toEqual([{ cols: 120, cwd: '/workspace/repo', rootId: 'root-1', rows: 40 }]);
    expect(terminalContract.write.parseArgs([{ data: 'pwd\n', terminalId: 'pty-1' }])).toEqual([
      { data: 'pwd\n', terminalId: 'pty-1' },
    ]);
    expect(
      terminalContract.resize.parseArgs([{ cols: 100, rows: 30, terminalId: 'pty-1' }])
    ).toEqual([{ cols: 100, rows: 30, terminalId: 'pty-1' }]);
    expect(terminalContract.destroy.parseArgs([{ terminalId: 'pty-1' }])).toEqual([
      { terminalId: 'pty-1' },
    ]);
  });

  it('parses every command-session invoke and preserves an omitted cursor', () => {
    expect(commandSessionsContract.list.parseArgs([{ rootId: 'root-1' }])).toEqual([
      { rootId: 'root-1' },
    ]);
    expect(
      commandSessionsContract.read.parseArgs([{ rootId: 'root-1', sessionId: 'session-1' }])
    ).toEqual([{ rootId: 'root-1', sessionId: 'session-1' }]);
    expect(
      commandSessionsContract.read.parseArgs([
        { cursor: 0, rootId: 'root-1', sessionId: 'session-1' },
      ])
    ).toEqual([{ cursor: 0, rootId: 'root-1', sessionId: 'session-1' }]);
    expect(
      commandSessionsContract.read.parseArgs([
        { cursor: undefined, rootId: 'root-1', sessionId: 'session-1' },
      ])
    ).toEqual([{ rootId: 'root-1', sessionId: 'session-1' }]);
    expect(
      commandSessionsContract.write.parseArgs([
        { data: 'continue', rootId: 'root-1', sessionId: 'session-1' },
      ])
    ).toEqual([{ data: 'continue', rootId: 'root-1', sessionId: 'session-1' }]);
    for (const operation of ['remove', 'stop'] as const) {
      expect(
        commandSessionsContract[operation].parseArgs([{ rootId: 'root-1', sessionId: 'session-1' }])
      ).toEqual([{ rootId: 'root-1', sessionId: 'session-1' }]);
    }
  });

  it('rejects malformed direct IPC input before handler entry', () => {
    expect(() => terminalContract.create.parseArgs([{ rootId: 1 }])).toThrow(
      'terminal create rootId must be a string'
    );
    expect(() => terminalContract.create.parseArgs([{ extra: true, rootId: 'root-1' }])).toThrow(
      'terminal create received unsupported fields: extra'
    );
    expect(() => terminalContract.resize.parseArgs([{ cols: 80, terminalId: 'pty-1' }])).toThrow(
      'terminal resize rows must be a finite number'
    );
    expect(() =>
      terminalContract.destroy.parseArgs([{ extra: true, terminalId: 'pty-1' }])
    ).toThrow('terminal destroy received unsupported fields: extra');
    expect(() => commandSessionsContract.list.parseArgs([{ rootId: 1 }])).toThrow(
      'command sessions list rootId must be a string'
    );
    expect(() =>
      commandSessionsContract.read.parseArgs([
        { cursor: 'first', rootId: 'root-1', sessionId: 'session-1' },
      ])
    ).toThrow('command sessions read cursor must be a finite number when present');
    expect(() =>
      commandSessionsContract.write.parseArgs([
        { data: 4, rootId: 'root-1', sessionId: 'session-1' },
      ])
    ).toThrow('command sessions write data must be a string');
  });
});
