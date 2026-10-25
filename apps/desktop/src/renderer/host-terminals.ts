import type { HostClient } from '@brainstrike/agent-host/browser';
import type { TerminalEvent } from '@brainstrike/agent-host/protocol';
import {
  NO_WORKSPACE_TERMINAL_SERVICES,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type WorkspaceTerminalServices,
} from '@brainstrike/app-shell/workspace-terminal-services';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';

/**
 * A terminal whose host ended has no exit status of its own: its shell ended
 * with the host (ADR-0029), so the panel shows it exited and offers a restart.
 */
const LOST_HOST_EXIT_CODE = -1;

let windowServices: WorkspaceTerminalServices | undefined;

/**
 * ADR-0029 stage 3: the Terminal panel's terminals and command sessions live
 * in the agent host. A window without the agent-host capability (hidden hosts)
 * has none of them.
 */
export function resolveDesktopWorkspaceTerminalServices(): WorkspaceTerminalServices {
  if (!window.agentHost) {
    return NO_WORKSPACE_TERMINAL_SERVICES;
  }
  windowServices ??= createDesktopWorkspaceTerminalServices(windowHostConnection());
  return windowServices;
}

/** This window's terminals, on the frame's host connection. */
export function createDesktopWorkspaceTerminalServices(
  connection: DesktopHostConnection
): WorkspaceTerminalServices {
  const dataListeners = new Set<(event: TerminalDataEvent) => void>();
  const exitListeners = new Set<(event: TerminalExitEvent) => void>();
  const exit = (event: TerminalExitEvent): void => {
    for (const listener of [...exitListeners]) {
      listener(event);
    }
  };
  // The terminals this window created on each host, until each exits.
  const live = new Map<HostClient, Set<string>>();
  const attach = (host: HostClient): Set<string> => {
    const terminals = new Set<string>();
    live.set(host, terminals);
    host.onTerminal((event: TerminalEvent) => {
      if (event.type === 'data') {
        for (const listener of [...dataListeners]) {
          listener({ data: event.data, terminalId: event.terminalId });
        }
        return;
      }
      terminals.delete(event.terminalId);
      exit({ exitCode: event.exitCode, signal: event.signal, terminalId: event.terminalId });
    });
    const lost = (): void => {
      live.delete(host);
      for (const terminalId of terminals) {
        exit({ exitCode: LOST_HOST_EXIT_CODE, signal: null, terminalId });
      }
      terminals.clear();
    };
    void host.closed.then(lost, lost);
    return terminals;
  };
  const client = async (): Promise<{ host: HostClient; terminals: Set<string> }> => {
    const host = await connection.current();
    return { host, terminals: live.get(host) ?? attach(host) };
  };
  return {
    commandSessions: {
      list: async (params) => (await client()).host.request('command-sessions/list', params),
      read: async (params) => (await client()).host.request('command-sessions/read', params),
      remove: async (params) => (await client()).host.request('command-sessions/remove', params),
      stop: async (params) => (await client()).host.request('command-sessions/stop', params),
      write: async (params) => (await client()).host.request('command-sessions/write', params),
    },
    terminal: {
      create: async (params) => {
        const { host, terminals } = await client();
        const created = await host.request('terminal/create', params);
        if (created.ok) {
          terminals.add(created.value.terminalId);
        }
        return created;
      },
      destroy: async (params) => (await client()).host.request('terminal/destroy', params),
      onData: (listener) => {
        dataListeners.add(listener);
        return () => {
          dataListeners.delete(listener);
        };
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        return () => {
          exitListeners.delete(listener);
        };
      },
      resize: async (params) => (await client()).host.request('terminal/resize', params),
      write: async (params) => (await client()).host.request('terminal/write', params),
    },
  };
}
