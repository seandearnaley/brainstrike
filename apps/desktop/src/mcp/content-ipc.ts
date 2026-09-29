import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import {
  McpContentApplicationError,
  type McpContentApplicationRequest,
} from '@brainstrike/assistant-service/mcp-content-application-port';
import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';
import {
  type McpContentIpcFailure,
  type McpContentIpcResponse,
  mcpContentContract,
} from '../ipc-domains/mcp.contract';
import { type DesktopIpcRegistry, registerDomain } from '../platform/desktop-ipc-registry';
import type { Handlers } from '../platform/ipc-contract';
import { getDesktopMcpContentPort } from './content-port';
import type { DesktopMcpHostRuntime } from './host-runtime';

/**
 * `mcp:content:*` (BST-1585): user-initiated Settings content browsing over the
 * assistant-service content application port. Each channel forces its own verb
 * in main; the renderer supplies only the verb payload plus authority and never
 * chooses the operation type.
 */
interface McpContentLifecycleGate {
  /** The MCP lifecycle barrier as it stands when the request is admitted. */
  barrier(): Promise<void>;
  /** Whether MCP admission is open (false during shutdown / factory reset). */
  isOpen(): boolean;
}

const logger = createLogger('DesktopMcpContentIpc');

/**
 * What the renderer receives. `ipcMain.handle` does not structured-clone a
 * thrown Error: Electron replies with a formatted string that includes the
 * main-process stack, so failures travel as data and the preload turns them
 * back into a clean Error carrying only this fixed taxonomy.
 */
const MCP_CONTENT_GENERIC_FAILURE: McpContentIpcFailure = {
  category: 'host',
  code: 'mcp_content_request_failed',
  message: 'MCP content request failed',
};
const MCP_CONTENT_LIFECYCLE_CLOSED: McpContentIpcFailure = {
  category: 'not-connected',
  code: 'mcp_content_lifecycle_closed',
  message: 'MCP lifecycle is closed for cleanup',
};
const McpContentAuthorityRequestSchema = z.strictObject({
  configuredServerId: z.string(),
  generation: z.number().int().nonnegative(),
});
const McpContentReadResourceRequestSchema = z.strictObject({
  authority: McpContentAuthorityRequestSchema,
  uri: z.string(),
});
const McpContentGetPromptRequestSchema = z.strictObject({
  arguments: z.record(z.string(), z.string()).optional(),
  authority: McpContentAuthorityRequestSchema,
  name: z.string(),
});
const McpContentCompleteRequestSchema = z.strictObject({
  argument: z.strictObject({ name: z.string(), value: z.string() }),
  authority: McpContentAuthorityRequestSchema,
  context: z.strictObject({ arguments: z.record(z.string(), z.string()) }).optional(),
  ref: z.discriminatedUnion('type', [
    z.strictObject({ name: z.string(), type: z.literal('ref/prompt') }),
    z.strictObject({ type: z.literal('ref/resource'), uri: z.string() }),
  ]),
});
type McpContentRequestAuthority = z.output<typeof McpContentAuthorityRequestSchema>;

function parseMcpContentAuthority(
  authority: McpContentRequestAuthority
): McpContentApplicationRequest['authority'] {
  return {
    configuredServerId: parseConfiguredMcpServerId(authority.configuredServerId),
    generation: authority.generation,
  };
}

/**
 * Only the application port's fixed public taxonomy crosses IPC. `hostError`
 * carries server-originated text and stays in main (the port already reported
 * it to its sink); anything outside the taxonomy is logged here and replaced
 * with one generic failure.
 */
export function toMcpContentIpcFailure(cause: unknown): McpContentIpcFailure {
  if (cause instanceof McpContentApplicationError) {
    return { category: cause.category, code: cause.code, message: cause.message };
  }
  logger.error(MCP_CONTENT_GENERIC_FAILURE.message, { error: cause });
  return MCP_CONTENT_GENERIC_FAILURE;
}

/**
 * Lifecycle-barrier-gated like `mcp:status:get`, but never queued on the
 * non-reentrant config-operation queue: reads must not block or be blocked by
 * config replacement, which the port's own authority watch retires.
 */
async function runMcpContentRequest(
  runtime: Pick<DesktopMcpHostRuntime, 'host'>,
  lifecycle: McpContentLifecycleGate,
  buildRequest: () => McpContentApplicationRequest
): Promise<McpContentIpcResponse> {
  if (!lifecycle.isOpen()) {
    return { error: MCP_CONTENT_LIFECYCLE_CLOSED, ok: false };
  }
  await lifecycle.barrier();
  let request: McpContentApplicationRequest;
  try {
    request = buildRequest();
  } catch {
    return {
      error: toMcpContentIpcFailure(new McpContentApplicationError('invalidRequest')),
      ok: false,
    };
  }
  try {
    // Cloned here on purpose: a non-cloneable value surfaces as this fixed
    // failure instead of an opaque IPC serialization error.
    const result = structuredClone(await getDesktopMcpContentPort(runtime).execute(request));
    return { ok: true, result };
  } catch (cause) {
    return { error: toMcpContentIpcFailure(cause), ok: false };
  }
}

/**
 * Resource and prompt bodies are user data, so the three channels carry the
 * same fail-closed `visible-ui` sender policy as secrets: hidden inference
 * hosts and untracked senders are rejected before any payload is parsed.
 */
export function registerMcpContentIpc(
  registry: Pick<DesktopIpcRegistry, 'registerAuthorizedInvoke'>,
  runtime: Pick<DesktopMcpHostRuntime, 'host'>,
  lifecycle: McpContentLifecycleGate
): void {
  const handlers: Handlers<typeof mcpContentContract> = {
    complete: async (request) =>
      await runMcpContentRequest(runtime, lifecycle, () => {
        const parsed = McpContentCompleteRequestSchema.parse(request);
        return {
          argument: parsed.argument,
          authority: parseMcpContentAuthority(parsed.authority),
          ...(parsed.context && { context: parsed.context }),
          ref: parsed.ref,
          type: 'completion/complete',
        };
      }),
    getPrompt: async (request) =>
      await runMcpContentRequest(runtime, lifecycle, () => {
        const parsed = McpContentGetPromptRequestSchema.parse(request);
        return {
          ...(parsed.arguments && { arguments: parsed.arguments }),
          authority: parseMcpContentAuthority(parsed.authority),
          name: parsed.name,
          type: 'prompts/get',
        };
      }),
    readResource: async (request) =>
      await runMcpContentRequest(runtime, lifecycle, () => {
        const parsed = McpContentReadResourceRequestSchema.parse(request);
        return {
          authority: parseMcpContentAuthority(parsed.authority),
          type: 'resources/read',
          uri: parsed.uri,
        };
      }),
  };
  registerDomain(registry, 'mcp', mcpContentContract, handlers);
}
