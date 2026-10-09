/**
 * Capability resolution for what the composer's MCP prompt affordance needs
 * (BST-1592): the `window.mcp` content members and the MCP status capability.
 *
 * Desktop-only by construction: the visible-UI preload exposes the
 * `mcp:content:*` bridge and the desktop provides the agent host's server
 * status (BST-1930 c5b); web has neither, so `resolveMcpPromptBridge()` reports
 * `unsupported` and the affordance is never constructed. There is no
 * `isElectron()` branch anywhere.
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

/** The content members `window.mcp` carries; the status members come from the host. */
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
 * Resolve the prompt bridge from the `window.mcp` content members and the MCP
 * status capability.
 *
 * `unsupported` when there is no content bridge at all (web/SSR, or a preload
 * that exposes `window.mcp` with none of the content members) and no status.
 * `malformed` when some but not all members are present — a partial bridge can
 * never be used, and the caller must say so out loud instead of silently
 * presenting web's empty surface.
 */
export function resolveMcpPromptBridge(
  status: McpStatusCapability | null
): McpPromptBridgeResolution {
  const candidate =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { mcp?: Partial<McpPromptBridge> }).mcp;
  const complete = candidate?.complete;
  const getPrompt = candidate?.getPrompt;
  if (typeof complete === 'function' && typeof getPrompt === 'function' && status) {
    return {
      bridge: {
        complete,
        getPrompt,
        getServerStatusSnapshot: () => status.read(),
        onServerStatusUpdated: (callback) => status.subscribe(callback),
      },
      status: 'ready',
    };
  }
  const missing: (keyof McpPromptBridge)[] = MCP_PROMPT_CONTENT_METHODS.filter(
    (method) => typeof candidate?.[method] !== 'function'
  );
  if (!status) {
    missing.push(...MCP_PROMPT_STATUS_METHODS);
  }
  if (missing.length === MCP_PROMPT_BRIDGE_REQUIRED_METHODS.length) {
    return { status: 'unsupported' };
  }
  logger.error('MCP prompt bridge is malformed; composer MCP prompts disabled', { missing });
  return { missing, status: 'malformed' };
}
