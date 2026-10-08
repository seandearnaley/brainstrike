import {
  guardToolExecution,
  type RuntimeData,
  type ScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import {
  assertMcpAuthorityReconstruction,
  type HostMcpToolSelection,
} from '@brainstrike/agent-host';
import type { HostRunSnapshot } from '@brainstrike/agent-host/protocol';
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { createAgentHostToolBindings } from '../agent-host-tool-bindings';
import type { McpHostRuntime } from '../mcp/node-host-runtime';

type CanonicalTools = NonNullable<RuntimeData['mastraTools']>;
type ExecutableMcpBindings = HostMcpToolSelection['bindings'];

/** Structural injection of the shipped collector, until its public barrel is available. */
export interface AgentHostMcpCollection {
  readonly mcpDiscoverySkips: readonly unknown[];
  readonly tools: CanonicalTools;
}

export function bindMcpTool(options: {
  readonly after: McpHostSnapshot;
  readonly before: McpHostSnapshot;
  readonly canonicalId: string;
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  readonly source: CanonicalTools[string];
  readonly runtime: Pick<McpHostRuntime, 'describeToolAuthority'>;
  readonly snapshot?: HostRunSnapshot;
  readonly toolId: string;
  readonly toolTimeoutMs: number;
}): ExecutableMcpBindings[string] {
  const { after, before, canonicalId, source } = options;
  // Match the collector's existing dotted namespace to exact catalog entries;
  // routing never parses an arbitrary model-provided name.
  const owners = after.servers.filter(
    (server) =>
      server.state === 'connected' &&
      server.catalog?.tools?.tools.some(
        (tool) => `${server.configuredServerId}.${tool.name}` === canonicalId
      )
  );
  const owner = owners[0];
  if (
    owners.length !== 1 ||
    !owner ||
    !before.servers.some(
      (server) =>
        server.configuredServerId === owner.configuredServerId &&
        server.generation === owner.generation
    )
  ) {
    throw new Error('MCP discovery no longer belongs to one configured server generation.');
  }
  if (!('id' in source && typeof source.id === 'string')) {
    throw new Error('MCP collector returned no canonical executor identity.');
  }
  const identity = JSON.stringify([owner.configuredServerId, owner.generation, source.id]);
  const mcpAuthority = options.runtime.describeToolAuthority(
    owner.configuredServerId,
    owner.generation
  );
  if (options.snapshot) {
    assertMcpAuthorityReconstruction(
      options.snapshot.mcpAuthorities?.[options.toolId],
      mcpAuthority
    );
  }
  const bound = createAgentHostToolBindings({
    bindings: { [canonicalId]: { identity, risk: 'mcp' } },
    resolvedToolResultBudget: options.resolvedToolResultBudget,
    tools: {
      [canonicalId]: guardToolExecution(source, {
        timeoutMs: options.toolTimeoutMs,
        toolName: canonicalId,
      }),
    },
  });
  const tool = Object.values(bound.tools)[0];
  if (!tool) {
    throw new Error('MCP collector returned no executable binding.');
  }
  return {
    configuredServerId: owner.configuredServerId,
    generation: owner.generation,
    tool: { ...tool, mcpAuthority },
  };
}
