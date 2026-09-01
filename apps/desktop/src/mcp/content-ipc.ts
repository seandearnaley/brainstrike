import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import {
  McpContentApplicationError,
  type McpContentApplicationRequest,
  type McpContentApplicationResult,
} from '@brainstrike/assistant-service/mcp-content-application-port';
import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import type { DesktopIpcRegistry } from '../platform/desktop-ipc-registry';
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
const MCP_CONTENT_GENERIC_FAILURE = 'MCP content request failed';
const McpContentAuthorityRequestSchema = z.strictObject({
  configuredServerId: z.string(),
  generation: z.number(),
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
 * Only the application port's fixed public taxonomy crosses IPC. Raw causes
 * stay in main: the port already reported internal failures to its sink, and
 * anything outside that taxonomy is logged here and replaced with one generic
 * message.
 */
function toRendererMcpContentError(cause: unknown): Error {
  if (cause instanceof McpContentApplicationError) {
    const detail = cause.hostError ? `: ${cause.hostError.message}` : '';
    return Object.assign(
      new Error(`${cause.message}${detail} (${cause.category} · ${cause.code})`),
      { category: cause.category, code: cause.code }
    );
  }
  logger.error(MCP_CONTENT_GENERIC_FAILURE, { error: cause });
  return new Error(MCP_CONTENT_GENERIC_FAILURE);
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
): Promise<McpContentApplicationResult> {
  if (!lifecycle.isOpen()) {
    throw new Error('MCP lifecycle is closed for cleanup');
  }
  await lifecycle.barrier();
  let request: McpContentApplicationRequest;
  try {
    request = buildRequest();
  } catch {
    throw toRendererMcpContentError(new McpContentApplicationError('invalidRequest'));
  }
  try {
    return structuredClone(await getDesktopMcpContentPort(runtime).execute(request));
  } catch (cause) {
    throw toRendererMcpContentError(cause);
  }
}

export function registerMcpContentIpc(
  registry: Pick<DesktopIpcRegistry, 'registerInvoke'>,
  runtime: Pick<DesktopMcpHostRuntime, 'host'>,
  lifecycle: McpContentLifecycleGate
): void {
  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.contentReadResource,
    async (_event, request: unknown) =>
      await runMcpContentRequest(runtime, lifecycle, () => {
        const parsed = McpContentReadResourceRequestSchema.parse(request);
        return {
          authority: parseMcpContentAuthority(parsed.authority),
          type: 'resources/read',
          uri: parsed.uri,
        };
      })
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.contentGetPrompt,
    async (_event, request: unknown) =>
      await runMcpContentRequest(runtime, lifecycle, () => {
        const parsed = McpContentGetPromptRequestSchema.parse(request);
        return {
          ...(parsed.arguments && { arguments: parsed.arguments }),
          authority: parseMcpContentAuthority(parsed.authority),
          name: parsed.name,
          type: 'prompts/get',
        };
      })
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.contentComplete,
    async (_event, request: unknown) =>
      await runMcpContentRequest(runtime, lifecycle, () => {
        const parsed = McpContentCompleteRequestSchema.parse(request);
        return {
          argument: parsed.argument,
          authority: parseMcpContentAuthority(parsed.authority),
          ...(parsed.context && { context: parsed.context }),
          ref: parsed.ref,
          type: 'completion/complete',
        };
      })
  );
}
