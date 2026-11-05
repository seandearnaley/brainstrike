import type {
  AssistantPersonasListResult,
  WorkspaceContextFileStatus,
} from '@brainstrike/assistant-contract';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';

/**
 * ADR-0029 stage 2a: Settings' persona list (with the host's preflight checks)
 * and each trusted root's workspace instructions file, scanned by the agent
 * host as its runs scan them.
 */
export interface DesktopHostWorkspaceSettings {
  listPersonas(): Promise<AssistantPersonasListResult>;
  scanContextFiles(): Promise<WorkspaceContextFileStatus[]>;
}

/** Over one host connection: the host owns the scans; this window only asks. */
function createDesktopHostWorkspaceSettings(
  connection: DesktopHostConnection
): DesktopHostWorkspaceSettings {
  return {
    listPersonas: async () => await (await connection.current()).request('workspace/personas', {}),
    scanContextFiles: async () =>
      (await (await connection.current()).request('workspace/context-files', {})).files,
  };
}

let windowSettings: DesktopHostWorkspaceSettings | undefined;

/** `null` where this window has no agent-host capability (web). */
export function resolveDesktopHostWorkspaceSettings(): DesktopHostWorkspaceSettings | null {
  if (!window.agentHost) {
    return null;
  }
  windowSettings ??= createDesktopHostWorkspaceSettings(windowHostConnection());
  return windowSettings;
}
