import {
  type McpAppOrigin,
  type PermissionToolGateSnapshot,
  readMcpAppToolInvocationResult,
  refusalError,
} from '@brainstrike/assistant-contract';
import type { HostThreadGrants } from './core-state.js';
import { jsonValue } from './json-value.js';
import type { HostPlatform } from './ports.js';
import type { HostLogRow, HostParams, HostResults } from './protocol.js';
import { hostPolicyDecision } from './run-admission.js';

/** An MCP App's own `tools/call`, from the app a thread's tool result mounted. */
export interface HostMcpAppCall {
  readonly app: McpAppOrigin;
  readonly toolName: string;
}

const sameApp = (mounted: McpAppOrigin | undefined, app: McpAppOrigin): boolean =>
  mounted?.serverId === app.serverId &&
  mounted.toolName === app.toolName &&
  mounted.resourceUri === app.resourceUri &&
  mounted.mimeType === app.mimeType;

/**
 * Core decides an app's call as it decides a model's call of the same MCP
 * tool: the thread's live policy and grants, with the tool's `mcp` risk and
 * its `server.tool` catalog ID. Only an app that one of this thread's
 * committed tool results mounted may call at all, and only on its own server.
 */
export function decideHostMcpAppCall(
  rows: readonly HostLogRow[],
  policy: PermissionToolGateSnapshot,
  grants: HostThreadGrants,
  call: HostMcpAppCall
): 'allow' | 'ask' {
  const mounted = rows.some(
    ({ event }) =>
      event.type === 'effect.finished' &&
      sameApp(readMcpAppToolInvocationResult(event.output)?.app, call.app)
  );
  if (!mounted) {
    throw refusalError(
      'authorization',
      'mcp-app.not-mounted',
      'No committed tool result of this thread mounted this MCP App'
    );
  }
  const decision = hostPolicyDecision(
    policy,
    grants,
    'mcp',
    `${call.app.serverId}.${call.toolName}`
  );
  if (decision === 'deny') {
    throw refusalError(
      'authorization',
      'mcp-app.denied',
      'The permission policy denies this MCP App tool call'
    );
  }
  return decision;
}

/** The Core state an app's call reads; Core owns each of these. */
export interface HostMcpAppCallPorts {
  /** Refuses a closing host, an unknown thread, or one being deleted. */
  readonly assertAdmissible: (threadId: string) => void;
  readonly grants: (rootThreadId: string) => HostThreadGrants;
  readonly platform: () => Pick<HostPlatform, 'mcp' | 'readPermissionPolicy'>;
  readonly read: (threadId: string) => Promise<readonly HostLogRow[]>;
  /** A child thread's calls follow its root's live policy and grants (ADR-0010). */
  readonly rootThread: (threadId: string) => string;
}

/** `mcp/app/admit` and `mcp/app/call`: Core decides, the platform's MCP authority runs. */
export class HostMcpAppCalls {
  private readonly ports: HostMcpAppCallPorts;

  constructor(ports: HostMcpAppCallPorts) {
    this.ports = ports;
  }

  async admit(params: HostParams<'mcp/app/admit'>): Promise<HostResults['mcp/app/admit']> {
    return { decision: await this.decide(params), riskCategory: 'mcp' };
  }

  /** Decided afresh: an asked call runs only once approved, on the app's own server. */
  async call(
    params: HostParams<'mcp/app/call'>,
    signal: AbortSignal
  ): Promise<HostResults['mcp/app/call']> {
    const decision = await this.decide(params);
    if (decision === 'ask' && !params.approved) {
      throw refusalError(
        'authorization',
        'mcp-app.approval-required',
        'This MCP App tool call needs the user’s approval'
      );
    }
    const mcp = this.ports.platform().mcp;
    if (!mcp) {
      throw refusalError(
        'configuration',
        'mcp-app.unavailable',
        'This host has no MCP authority for app tool calls'
      );
    }
    const result = await mcp.callAppTool(
      { arguments: params.arguments, serverId: params.app.serverId, toolName: params.toolName },
      signal
    );
    return { result: jsonValue(result) };
  }

  private async decide(params: HostParams<'mcp/app/admit'>): Promise<'allow' | 'ask'> {
    this.ports.assertAdmissible(params.threadId);
    const root = this.ports.rootThread(params.threadId);
    return decideHostMcpAppCall(
      await this.ports.read(params.threadId),
      await this.ports.platform().readPermissionPolicy(root),
      this.ports.grants(root),
      params
    );
  }
}
