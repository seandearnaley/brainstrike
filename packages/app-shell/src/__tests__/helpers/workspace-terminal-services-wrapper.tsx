import type { ReactElement, ReactNode } from 'react';
import { vi } from 'vitest';
import type { TerminalBridge } from '../../terminal-panel/terminal-bridge';
import {
  NO_WORKSPACE_TERMINAL_SERVICES,
  type WorkspaceTerminalServices,
  WorkspaceTerminalServicesProvider,
} from '../../workspace-terminal-services';

const SERVICES: WorkspaceTerminalServices = {
  ...NO_WORKSPACE_TERMINAL_SERVICES,
  terminal: {
    create: vi.fn(),
    destroy: vi.fn(),
    onData: vi.fn(() => () => undefined),
    onExit: vi.fn(() => () => undefined),
    resize: vi.fn(),
    write: vi.fn(),
  } satisfies TerminalBridge,
};

/**
 * A `render`/`renderHook` wrapper that provides a terminal bridge whose methods
 * are spies, as the desktop host does. A tree rendered without it has no
 * terminal bridge, as on web.
 */
export function TerminalHost({ children }: { readonly children?: ReactNode }): ReactElement {
  return (
    <WorkspaceTerminalServicesProvider services={SERVICES}>
      {children}
    </WorkspaceTerminalServicesProvider>
  );
}
