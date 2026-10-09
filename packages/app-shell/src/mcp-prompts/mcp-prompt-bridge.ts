/**
 * Capability resolution for what the composer's MCP prompt affordance needs
 * (BST-1592): the MCP content and status capabilities.
 *
 * Desktop-only by construction: the desktop provides the agent host's content
 * and server status (BST-1930 c5b-c5d); web provides neither, so
 * `resolveMcpPromptBridge()` reports `unsupported` and the affordance is never
 * constructed. There is no `isElectron()` branch anywhere.
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
import type { McpContentCapability } from '../mcp-content-capability';
import type { McpStatusCapability } from '../mcp-status-capability';

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
 * Every member the affordance requires. All four must be present: a partial
 * bridge disables the whole surface rather than degrading it.
 */
export const MCP_PROMPT_BRIDGE_REQUIRED_METHODS = Object.keys(
  MCP_PROMPT_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof McpPromptBridge)[];

/** The members the content capability supplies; the status capability supplies the rest. */
const MCP_PROMPT_CONTENT_METHODS = [
  'complete',
  'getPrompt',
] as const satisfies readonly (keyof McpPromptBridge)[];
const MCP_PROMPT_STATUS_METHODS = [
  'getServerStatusSnapshot',
  'onServerStatusUpdated',
] as const satisfies readonly (keyof McpPromptBridge)[];

/**
 * Why the affordance is or is not available. "This runtime has no prompt bridge"
 * and "this runtime has a BROKEN prompt bridge" are different states and must
 * not share a code path: the first is web (and any host packaged without the
 * content members), a legitimately unsupported capability that stays quiet; the
 * second is a preload/packaging defect, which AGENTS.md requires to surface
 * visibly rather than degrade into something indistinguishable from web.
 */
export type McpPromptBridgeResolution =
  | { readonly bridge: McpPromptBridge; readonly status: 'ready' }
  | { readonly missing: readonly (keyof McpPromptBridge)[]; readonly status: 'malformed' }
  | { readonly status: 'unsupported' };

/**
 * Resolve the prompt bridge from the MCP content and status capabilities.
 *
 * `unsupported` when neither is provided (web/SSR). `malformed` when only one
 * is: a partial bridge can never be used, and the caller must say so out loud
 * instead of silently presenting web's empty surface.
 */
export function resolveMcpPromptBridge(
  status: McpStatusCapability | null,
  content: McpContentCapability | null
): McpPromptBridgeResolution {
  if (content && status) {
    return {
      bridge: {
        complete: (request) => content.complete(request),
        getPrompt: (request) => content.getPrompt(request),
        getServerStatusSnapshot: () => status.read(),
        onServerStatusUpdated: (callback) => status.subscribe(callback),
      },
      status: 'ready',
    };
  }
  if (!(content || status)) {
    return { status: 'unsupported' };
  }
  const missing = content ? [...MCP_PROMPT_STATUS_METHODS] : [...MCP_PROMPT_CONTENT_METHODS];
  logger.error('MCP prompt bridge is malformed; composer MCP prompts disabled', { missing });
  return { missing, status: 'malformed' };
}
