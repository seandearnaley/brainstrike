/**
 * Capability resolution for the desktop `window.mcp` elicitation members
 * (BST-1584). Lives beside the host so the component module exports only the
 * component (react-refresh) and so tests can pin the required-member set.
 */
import type {
  McpElicitationPresentationWire,
  McpElicitationRetiredWire,
  McpElicitationSettlement,
} from '@brainstrike/assistant-contract';

export interface McpElicitationBridge {
  readonly onElicitationRequested: (
    callback: (presentation: McpElicitationPresentationWire) => void
  ) => () => void;
  readonly onElicitationRetired: (
    callback: (retired: McpElicitationRetiredWire) => void
  ) => () => void;
  readonly settleElicitation: (settlement: McpElicitationSettlement) => Promise<void>;
}

const BRIDGE_METHODS = [
  'onElicitationRequested',
  'onElicitationRetired',
  'settleElicitation',
] as const satisfies readonly (keyof McpElicitationBridge)[];

/** Resolve the elicitation members of `window.mcp`, or `null` when any is absent. */
export function resolveMcpElicitationBridge(): McpElicitationBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = (window as Window & { mcp?: Partial<McpElicitationBridge> }).mcp;
  if (!candidate) {
    return null;
  }
  return BRIDGE_METHODS.every((method) => typeof candidate[method] === 'function')
    ? (candidate as McpElicitationBridge)
    : null;
}
