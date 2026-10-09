import type {
  McpElicitationPresentationWire,
  McpElicitationRetiredWire,
  McpElicitationSettlement,
  McpTaskBridge,
} from '@brainstrike/assistant-contract';
import { createContext, type ReactElement, type ReactNode, useContext } from 'react';

/** Server input no run owns: presented, retired and answered through the desktop's agent host. */
export interface McpElicitationBridge {
  readonly onElicitationRequested: (
    callback: (presentation: McpElicitationPresentationWire) => void
  ) => () => void;
  readonly onElicitationRetired: (
    callback: (retired: McpElicitationRetiredWire) => void
  ) => () => void;
  readonly settleElicitation: (settlement: McpElicitationSettlement) => Promise<void>;
}

/**
 * The MCP input presenters' capabilities (BST-1584, BST-1930 c5c): server
 * input, and the task actions a task-bound input offers (cancelling the task
 * differs from cancelling the input). The desktop provides both from its agent
 * host; web provides neither, and the presenters render nothing.
 */
export interface McpElicitationCapability {
  readonly elicitation: McpElicitationBridge | null;
  readonly tasks: McpTaskBridge | null;
}

const NONE: McpElicitationCapability = Object.freeze({ elicitation: null, tasks: null });
const McpElicitationCapabilityContext = createContext<McpElicitationCapability>(NONE);

export interface McpElicitationCapabilityProviderProps {
  readonly capability: McpElicitationCapability;
  readonly children: ReactNode;
}

/** Mount once per visible host with the live capabilities. */
export function McpElicitationCapabilityProvider({
  capability,
  children,
}: McpElicitationCapabilityProviderProps): ReactElement {
  return (
    <McpElicitationCapabilityContext.Provider value={capability}>
      {children}
    </McpElicitationCapabilityContext.Provider>
  );
}

export function useMcpElicitationCapability(): McpElicitationCapability {
  return useContext(McpElicitationCapabilityContext);
}
