import {
  applyToolGuards,
  applyToolModelOutputProjections,
  createSanitizedToolNameMap,
  type RuntimeData,
  resolveAssistantResilienceConfig,
  resolveRunPythonExecutionContext,
  resolveToolGuardBudget,
  type ScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import {
  isNativeToolId,
  NATIVE_TOOL_EXECUTION_BUDGETS,
  NATIVE_TOOL_ID,
  type PermissionToolGateSnapshot,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { HostTool, HostToolContext } from '../ports.js';
import {
  canonicalToolInputSchema,
  canonicalToolModelOutput,
  createCanonicalToolContext,
} from './canonical-context.js';

type CanonicalTools = NonNullable<RuntimeData['mastraTools']>;

const guardLogger = createLogger('AgentHostToolGuard');

/**
 * The legacy execution guard (BST-1777) on every native tool: a call that
 * outlives its declared budget, or the resilience default, answers with the
 * structured timeout result, and a throw becomes the guarded error result.
 * Other tools keep their owner's guard (MCP bindings guard themselves).
 */
function guardNativeTools(tools: CanonicalTools, defaultGuardMs: number): CanonicalTools {
  const native = Object.fromEntries(Object.entries(tools).filter(([id]) => isNativeToolId(id)));
  const guarded = applyToolGuards(native, {
    declaredMaxMs: (id) => NATIVE_TOOL_EXECUTION_BUDGETS.get(id)?.maxMs,
    logger: guardLogger,
    timeoutMs: (id) => (args) =>
      resolveToolGuardBudget({
        budget: NATIVE_TOOL_EXECUTION_BUDGETS.get(id),
        defaultGuardMs,
        input: args[0],
      }),
  });
  return { ...tools, ...guarded };
}
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

/** run_python's requested domains need a person per call (legacy Gate B). */
function canonicalConsent(canonicalId: string): HostTool['consent'] {
  if (canonicalId !== NATIVE_TOOL_ID.runPython) {
    return undefined;
  }
  return (input) => (resolveRunPythonExecutionContext(input)?.allowedDomains.length ?? 0) > 0;
}

/**
 * Borrow the shipped executable schemas, executors and model-output pipeline.
 * Names use the existing provider sanitizer; decisions remain in HostCore.
 */
export function createAgentHostToolBindings(options: {
  readonly bindings: Readonly<Record<string, AgentHostToolBinding>>;
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  /** The guard's default window; the resilience configuration owns it. */
  readonly toolTimeoutMs?: number;
  readonly tools: CanonicalTools;
}): AgentHostToolBindings {
  const toolNameMap = createSanitizedToolNameMap(Object.keys(options.tools));
  const guarded = guardNativeTools(
    options.tools,
    options.toolTimeoutMs ?? resolveAssistantResilienceConfig().toolTimeoutMs
  );
  const projected = applyToolModelOutputProjections(
    guarded,
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
    const consent = canonicalConsent(canonicalId);
    tools[name] = {
      ...(consent ? { consent } : {}),
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
