import {
  applyToolModelOutputProjections,
  createSanitizedToolNameMap,
  type RuntimeData,
  type ScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import {
  canonicalToolInputSchema,
  canonicalToolModelOutput,
  createCanonicalToolContext,
  type HostTool,
  type HostToolContext,
} from '@brainstrike/agent-host';
import {
  NATIVE_TOOL_ID,
  type PermissionToolGateSnapshot,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract';

type CanonicalTools = NonNullable<RuntimeData['mastraTools']>;
type CanonicalTool = Extract<CanonicalTools[string], { id: string; description: string }>;

function isCanonicalTool(source: CanonicalTools[string]): source is CanonicalTool {
  return (
    'id' in source &&
    typeof source.id === 'string' &&
    'description' in source &&
    typeof source.description === 'string'
  );
}

export interface AgentHostToolBinding {
  /** Identity supplied by the native registry or MCP server-generation owner. */
  readonly identity: string;
  readonly risk: ToolRiskCategory;
}

export interface AgentHostToolBindings {
  permissionPolicy(snapshot: PermissionToolGateSnapshot): PermissionToolGateSnapshot;
  readonly toolNameMap: ReadonlyMap<string, string>;
  readonly tools: Readonly<Record<string, HostTool>>;
}

function canonicalInteraction(
  source: CanonicalTool,
  canonicalId: string,
  risk: ToolRiskCategory
): HostTool['interaction'] {
  if (risk !== 'read') {
    return undefined;
  }
  const kind =
    canonicalId === NATIVE_TOOL_ID.askUser
      ? 'question'
      : canonicalId === NATIVE_TOOL_ID.submitPlan
        ? 'plan'
        : undefined;
  if (!kind) {
    return undefined;
  }
  if (!('resumeSchema' in source && source.resumeSchema)) {
    throw new Error('Canonical human interaction has no resume schema');
  }
  return Object.freeze({ kind, resumeSchema: canonicalToolInputSchema(source.resumeSchema) });
}

/**
 * Borrow the shipped executable schemas, executors and model-output pipeline.
 * Names use the existing provider sanitizer; decisions remain in HostCore.
 */
export function createAgentHostToolBindings(options: {
  readonly bindings: Readonly<Record<string, AgentHostToolBinding>>;
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  readonly tools: CanonicalTools;
}): AgentHostToolBindings {
  const toolNameMap = createSanitizedToolNameMap(Object.keys(options.tools));
  const projected = applyToolModelOutputProjections(
    options.tools,
    toolNameMap,
    undefined,
    options.resolvedToolResultBudget
  );
  const tools: Record<string, HostTool> = {};
  for (const [name, canonicalId] of toolNameMap) {
    const source = projected[canonicalId];
    const binding = options.bindings[canonicalId];
    if (
      !(
        source &&
        isCanonicalTool(source) &&
        typeof source.execute === 'function' &&
        source.inputSchema &&
        binding
      )
    ) {
      throw new Error(`Canonical tool ${canonicalId} has no executable host binding`);
    }
    const execute = source.execute;
    const project = source.toModelOutput;
    const strict = source.strict;
    const interaction = canonicalInteraction(source, canonicalId, binding.risk);
    tools[name] = {
      description: source.description,
      execute: async (input: unknown, context: HostToolContext): Promise<unknown> =>
        await execute.call(source, input, createCanonicalToolContext(context, canonicalId)),
      identity: binding.identity,
      inputSchema: canonicalToolInputSchema(source.inputSchema),
      ...(interaction ? { interaction } : {}),
      permissionToolId: canonicalId,
      risk: binding.risk,
      ...(strict === undefined ? {} : { strict }),
      ...(project
        ? {
            toModelOutput: async ({ output, toolCallId }) =>
              canonicalToolModelOutput(await project.call(source, output), toolCallId, canonicalId),
          }
        : {}),
    };
  }
  return {
    permissionPolicy(snapshot): PermissionToolGateSnapshot {
      if (!snapshot.perToolOverrides) {
        return snapshot;
      }
      const perToolOverrides = { ...snapshot.perToolOverrides };
      for (const [name, canonicalId] of toolNameMap) {
        const decision = snapshot.perToolOverrides[canonicalId];
        if (decision !== undefined) {
          perToolOverrides[name] = decision;
        }
      }
      return { ...snapshot, perToolOverrides };
    },
    toolNameMap,
    tools,
  };
}
