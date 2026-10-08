import { z } from 'zod';
import type { HostClient } from './client.js';
import { HOST_METHOD_SCHEMAS, type HostParams, type HostResults } from './protocol.js';

/** The committed input a CLI command addresses: thread, run and the requested interaction. */
export interface CliMcpInputAddress {
  readonly interactionId: string;
  readonly runId: string;
  readonly threadId: string;
}

const ActionSchema = z.enum(['accept', 'decline', 'cancel']);

/** `mcp input read`: the committed status, plus its presentation while the input is live. */
export function readCliMcpInput(
  client: HostClient,
  address: CliMcpInputAddress
): Promise<HostResults['mcp/input/read']> {
  return client.request('mcp/input/read', address);
}

/**
 * `mcp input settle`: an accept stages its content, then settles, on this one
 * connection (Core binds a staged answer to the client that staged it). A
 * decline or cancel carries no content.
 */
export async function settleCliMcpInput(
  client: HostClient,
  address: CliMcpInputAddress,
  options: {
    readonly action: string | undefined;
    readonly commandId: string;
    readonly content: string | undefined;
  }
): Promise<HostResults['mcp/input/settle']> {
  const action = ActionSchema.parse(options.action);
  if (action !== 'accept' && options.content !== undefined) {
    throw new Error('--content applies only to --action accept');
  }
  if (action === 'accept') {
    const stage: HostParams<'mcp/input/stage'> = HOST_METHOD_SCHEMAS['mcp/input/stage'].parse({
      ...address,
      ...(options.content === undefined ? {} : { content: JSON.parse(options.content) }),
    });
    await client.request('mcp/input/stage', stage);
  }
  return client.request('mcp/input/settle', { ...address, action, commandId: options.commandId });
}
