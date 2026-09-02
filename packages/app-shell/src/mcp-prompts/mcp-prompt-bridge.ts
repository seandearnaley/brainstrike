/**
 * Capability resolution for the `window.mcp` members the composer's MCP prompt
 * affordance needs (BST-1592).
 *
 * Desktop-only by construction: the visible-UI preload exposes the
 * `mcp:content:*` bridge plus the revisioned host status channels; web has no
 * preload, so `resolveMcpPromptBridge()` returns `null` and the affordance is
 * never constructed. There is no `isElectron()` branch anywhere.
 *
 * Lives beside the hook/host so the component modules export only components
 * (react-refresh) and so the required-member set can be pinned by tests.
 */
import type {
  ConfiguredMcpServerId,
  McpHostOperationResult,
  McpHostSnapshot,
  McpHostWatchEvent,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('McpPromptBridge');

/**
 * One connected server generation a content request is authorized against.
 * Mirrors the assistant-service content application port's authority
 * structurally; app-shell depends only on assistant-contract.
 */
export interface McpPromptAuthority {
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly generation: number;
}
/** The `prompts/get` payload the renderer sends (main forces the operation type). */
export interface McpPromptGetRequest {
  readonly arguments?: Readonly<Record<string, string>> | undefined;
  readonly authority: McpPromptAuthority;
  readonly name: string;
}
/** The `completion/complete` payload the renderer sends for one prompt argument. */
export interface McpPromptCompleteRequest {
  readonly argument: { readonly name: string; readonly value: string };
  readonly authority: McpPromptAuthority;
  readonly context?: { readonly arguments: Readonly<Record<string, string>> } | undefined;
  readonly ref: { readonly name: string; readonly type: 'ref/prompt' };
}
export type McpPromptGetResult = Extract<McpHostOperationResult, { type: 'prompts/get' }>;
export type McpPromptCompleteResult = Extract<
  McpHostOperationResult,
  { type: 'completion/complete' }
>;

export interface McpPromptBridge {
  readonly complete: (request: McpPromptCompleteRequest) => Promise<McpPromptCompleteResult>;
  readonly getPrompt: (request: McpPromptGetRequest) => Promise<McpPromptGetResult>;
  readonly getServerStatusSnapshot: () => Promise<McpHostSnapshot>;
  readonly onServerStatusUpdated: (
    callback: (event: McpHostWatchEvent) => void
  ) => (() => void) | undefined;
}

// Compile-time exact-set proof: excess or missing keys fail the build, so the
// runtime pin can never drift from the interface.
const MCP_PROMPT_BRIDGE_REQUIRED_METHOD_SET = {
  complete: true,
  getPrompt: true,
  getServerStatusSnapshot: true,
  onServerStatusUpdated: true,
} as const satisfies Record<keyof McpPromptBridge, true>;

/**
 * Every `window.mcp` member the affordance requires. All four must be present:
 * a partial bridge disables the whole surface rather than degrading it.
 */
export const MCP_PROMPT_BRIDGE_REQUIRED_METHODS = Object.keys(
  MCP_PROMPT_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof McpPromptBridge)[];

/**
 * Resolve the prompt members of `window.mcp`, or `null` when the bridge is
 * absent (web) or malformed (a present-but-broken bridge logs an error and
 * stays absent — no silent degradation).
 */
export function resolveMcpPromptBridge(): McpPromptBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = (window as Window & { mcp?: Partial<McpPromptBridge> }).mcp;
  if (!candidate) {
    return null;
  }
  const missing = MCP_PROMPT_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof candidate[method] !== 'function'
  );
  if (missing.length === MCP_PROMPT_BRIDGE_REQUIRED_METHODS.length) {
    // No content bridge at all (a host that exposes only the config members).
    return null;
  }
  if (missing.length > 0) {
    logger.error('window.mcp prompt bridge is malformed; composer MCP prompts disabled', {
      missing,
    });
    return null;
  }
  return candidate as McpPromptBridge;
}
