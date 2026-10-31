import { createContext, type ReactElement, type ReactNode, useContext } from 'react';
import type { CommandSessionBridge } from './terminal-panel/command-session-bridge';
import type { TerminalBridge } from './terminal-panel/terminal-bridge';

export type {
  CommandSessionBridge,
  CommandSessionIdentityParams,
  CommandSessionInfo,
  CommandSessionReadPage,
  CommandSessionResult,
} from './terminal-panel/command-session-bridge';
export type {
  TerminalBridge,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
} from './terminal-panel/terminal-bridge';

/**
 * The workspace terminal cluster — interactive pty terminals and the
 * command-session inventory — as the renderer reaches it. The desktop builds
 * each from its agent-host connection (ADR-0029); a host without one provides
 * `null` and every surface built on it is omitted, never stubbed.
 */
export interface WorkspaceTerminalServices {
  readonly commandSessions: CommandSessionBridge | null;
  readonly terminal: TerminalBridge | null;
}

/** No terminal cluster at all: web, and any tree rendered without a provider. */
export const NO_WORKSPACE_TERMINAL_SERVICES: WorkspaceTerminalServices = {
  commandSessions: null,
  terminal: null,
};

const WorkspaceTerminalServicesContext = createContext<WorkspaceTerminalServices>(
  NO_WORKSPACE_TERMINAL_SERVICES
);

export interface WorkspaceTerminalServicesProviderProps {
  readonly children: ReactNode;
  readonly services: WorkspaceTerminalServices;
}

/** Mount once per visible host; pass a stable `services` object. */
export function WorkspaceTerminalServicesProvider({
  children,
  services,
}: WorkspaceTerminalServicesProviderProps): ReactElement {
  return (
    <WorkspaceTerminalServicesContext.Provider value={services}>
      {children}
    </WorkspaceTerminalServicesContext.Provider>
  );
}

export function useTerminalBridge(): TerminalBridge | null {
  return useContext(WorkspaceTerminalServicesContext).terminal;
}

export function useCommandSessionBridge(): CommandSessionBridge | null {
  return useContext(WorkspaceTerminalServicesContext).commandSessions;
}
