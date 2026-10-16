import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { parseMcpHostOperationResult } from '@brainstrike/assistant-contract/mcp-host-runtime';
// @boundaries-ignore packaged verification exercises the local Apps package before production registration exports it to Desktop.
import type {
  McpAppPreparedToolCall,
  McpAppToolCall,
} from '../../../../packages/mcp-app-host/src/index';

/**
 * The admission an MCP App's ordinary `tools/call` is prepared with, for the
 * packaged-app verifier.
 *
 * WHAT THIS DOES NOT PROVE, stated rather than implied. This used to compose
 * the production Agent pipeline (`composeRuntimeToolMap` →
 * `createMcpAppOrdinaryToolCallPreparer`) to obtain a real admission. That
 * pipeline was the Mastra agent loop's, and ADR-0022 retired it. Production
 * admission is now HostCore's — `decideHostMcpAppCall` in
 * `packages/agent-host/src/mcp-app-calls.ts`, which is per-call and
 * mount-evidenced rather than per-run and declaration-counted (ADR-0023) — and
 * it needs a committed `effect.finished` row, a live thread policy and the
 * thread's grants, none of which this standalone harness bundle has. Its own
 * coverage is `packages/agent-host/__tests__/mcp-app-calls.test.ts` and
 * `mcp-app-calls.integration.test.ts`.
 *
 * So the decision below is a FIXTURE, matching what the host's policy would
 * decide for this tool (`mcp` risk, `ask`), and this file's subject is what it
 * always observably was: the packaged shell, its CSP and session policy, the
 * frame fence, the consent prompt, and quiescence. A regression in the host's
 * admission rule will not fail this verifier, and is not meant to.
 */
export async function installOrdinaryRuntimeAdmission(server: {
  readonly installAdmission: (
    prepare: (call: McpAppToolCall) => Promise<McpAppPreparedToolCall>
  ) => void;
  readonly origin: string;
}): Promise<() => Promise<void>> {
  const configuredServerId = parseConfiguredMcpServerId('linear');
  server.installAdmission(async (call) => {
    if (`${call.serverId}.${call.toolName}` !== `${configuredServerId}.create_issue`) {
      throw new Error(`BST-1571 verifier admits no ${call.serverId}.${call.toolName}`);
    }
    return Object.freeze({
      // The host's policy for an `mcp`-risk tool with no standing grant.
      decision: 'ask' as const,
      execute: async ({ signal }: Readonly<{ signal: AbortSignal }>): Promise<unknown> => {
        const response = await fetch(`${server.origin}/tool`, {
          body: JSON.stringify(call.input ?? {}),
          method: 'POST',
          signal,
        });
        if (!response.ok) {
          throw new Error(`BST-1571 loopback tool failed with ${response.status}`);
        }
        const result: unknown = await response.json();
        if (!(result && typeof result === 'object' && !Array.isArray(result))) {
          throw new Error('BST-1571 loopback tool returned an invalid result');
        }
        // The app receives a validated MCP CallToolResult, as it does in the app.
        return parseMcpHostOperationResult({ result, type: 'tools/call' });
      },
      riskCategory: 'execute' as const,
    });
  });
  return async () => undefined;
}
