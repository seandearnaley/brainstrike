/**
 * BST-1932: persona delegation on the host. A child is an ordinary host run
 * in a Core-created child thread (report §4, spike S-SUB); this module holds
 * the pure parts: the `agent-<persona>` tool catalog, the child's narrowed
 * admission, and the result the parent's model reads.
 */
import { createHash } from 'node:crypto';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import {
  type AssistantPersonaDefinition,
  delegationDescriptionForPersona,
  delegationToolNameForPersona,
  effectiveChildStepBudget,
  personaMode,
} from '@brainstrike/assistant-contract/personas';
import type { RuntimeSubagentSettings } from '@brainstrike/assistant-contract/subagent-settings';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { type HostChildWorkQueue, hostPermitModel } from './child-work-queue.js';
import { canonical, jsonValue } from './json-value.js';
import type { HostDelegation, HostRunAdmission, HostTool } from './ports.js';
import type { HostEvent } from './protocol.js';

/**
 * The shipped Mastra delegation input, less its model-controlled memory/step
 * overrides. `_background` keeps the shipped foreground opt-out; retries and
 * timeouts stay host-owned, so they are not offered.
 */
export const HostDelegationInputSchema = z.object({
  _background: z
    .object({
      disposition: z
        .enum(['foreground', 'deferred', 'awaited'])
        .optional()
        .describe('Run this delegation inline (foreground) or in the background (deferred).'),
      enabled: z.boolean().optional().describe('false runs this delegation in the foreground.'),
    })
    .optional()
    .describe('Optional: override how this delegation executes. Omit it in most cases.'),
  prompt: z.string().min(1),
});

/**
 * Report section 4: a root delegation runs in the background unless the
 * model opts out; a child's own delegations run in the foreground (B5).
 */
export function hostDelegationRunsInBackground(
  input: z.infer<typeof HostDelegationInputSchema>,
  parentIsChild: boolean
): boolean {
  const override = input._background;
  return !(
    parentIsChild ||
    override?.enabled === false ||
    override?.disposition === 'foreground' ||
    override?.disposition === 'awaited'
  );
}

export const HostChildResultSchema = z.strictObject({
  /** Absent only for a refused delegation, which starts no child. */
  childThreadId: z.string().min(1).optional(),
  status: z.enum([
    'started',
    'completed',
    'no-answer',
    'failed',
    'stopped',
    'interrupted',
    'rejected',
  ]),
  text: z.string(),
});
export type HostChildResult = z.infer<typeof HostChildResultSchema>;

function personaIdentity(persona: AssistantPersonaDefinition, settings: RuntimeSubagentSettings) {
  const digest = createHash('sha256')
    .update(canonical(jsonValue({ persona, settings })))
    .digest('hex')
    .slice(0, 16);
  return `delegation:${persona.id}:${digest}`;
}

/** The shipped refusal when a turn's invocation budget is spent (BST-1751). */
export function hostInvocationLimitText(settings: RuntimeSubagentSettings): string {
  return `[Delegation Rejected] Delegation invocation limit reached (${settings.maxInvocations} per original turn).`;
}

/**
 * One HostCore-dispatched `agent-<persona>` tool per persona. Spawning never
 * asks (report §4 "Spawn and parallel"); the child's own tools pass the gate.
 */
export function createHostDelegationTools(delegation: HostDelegation): Record<string, HostTool> {
  return Object.fromEntries(
    delegation.personas.map((persona): [string, HostTool] => [
      delegationToolNameForPersona(persona.id),
      {
        delegation: persona,
        description: delegationDescriptionForPersona(persona, delegation.settings),
        execute: () => Promise.reject(new Error('HostCore dispatches persona delegation')),
        identity: personaIdentity(persona, delegation.settings),
        inputSchema: HostDelegationInputSchema,
        risk: 'read',
        // Only the child's final text enters the parent's context (report §4).
        toModelOutput: ({ output }) => ({
          type: 'text',
          value: HostChildResultSchema.parse(output).text,
        }),
      },
    ])
  );
}

/** `tools` plus the delegation catalog, refusing an identity collision. */
export function withHostDelegationTools(
  tools: Readonly<Record<string, HostTool>>,
  delegation: HostDelegation | undefined
): Record<string, HostTool> {
  const admitted = { ...tools };
  for (const [id, binding] of Object.entries(
    delegation ? createHostDelegationTools(delegation) : {}
  )) {
    if (Object.hasOwn(admitted, id)) {
      throw new Error('Native and delegation catalog identities collide');
    }
    admitted[id] = binding;
  }
  return admitted;
}

/**
 * The child's authority: the parent's admitted executors narrowed by the
 * persona (the shipped selectCandidateTools rule). A read-only persona keeps
 * only its declared read-risk tools; a worker keeps its declared tools, or with
 * a sole `*` every parent tool. Task-list state stays the parent's, and
 * delegation tools are granted by depth, never inherited.
 */
export function narrowHostChildTools(
  parent: Readonly<Record<string, HostTool>>,
  persona: AssistantPersonaDefinition
): Record<string, HostTool> {
  const worker = personaMode(persona) === 'worker';
  const wildcard = worker && persona.allowedToolIds[0] === '*';
  const allowed = new Set(persona.allowedToolIds);
  return Object.fromEntries(
    Object.entries(parent).filter(([id, tool]) => {
      const canonical = tool.permissionToolId ?? id;
      if (tool.delegation || canonical === NATIVE_TOOL_ID.manageTaskList) {
        return false;
      }
      return worker
        ? wildcard || allowed.has(canonical)
        : tool.risk === 'read' && allowed.has(canonical);
    })
  );
}

/**
 * The shipped wrap-up feedback (packages/agent/src/mastra/build-persona-subagents.ts,
 * removed with BST-1935): a child's last step is reserved for its summary.
 */
export const CHILD_WRAP_UP_FEEDBACK =
  'You are at your step limit and this is your final turn — no further tool calls will run. ' +
  'Using ONLY what you already found above, write your summary now: what you looked for, ' +
  'what you found, and the concrete file paths. If you covered only part of the task, say ' +
  'exactly which part you covered and which you did not.';

/** Each child tool execution holds one permit of the turn's work queue (C4). */
function queuedHostTools(
  tools: Readonly<Record<string, HostTool>>,
  queue: HostChildWorkQueue
): Record<string, HostTool> {
  return Object.fromEntries(
    Object.entries(tools).map(([id, tool]): [string, HostTool] => [
      id,
      {
        ...tool,
        execute: async (input, context) => {
          const release = await queue.acquire(context.signal);
          try {
            return await tool.execute(input, context);
          } finally {
            release();
          }
        },
      },
    ])
  );
}

/**
 * A child admission derived from its parent's: same model and provider
 * request hygiene, the persona's instructions ahead of the parent's host
 * system context, narrowed tools, and the persona's enforced step budget.
 * Every model step and tool execution queues on the turn's work queue, each
 * step's output is capped, and the last step is a tool-free summary.
 */
export function deriveHostChildAdmission(
  parent: HostRunAdmission,
  persona: AssistantPersonaDefinition,
  delegation: HostDelegation,
  queue: HostChildWorkQueue,
  depth: number
): HostRunAdmission {
  const { settings } = delegation;
  const narrowed = narrowHostChildTools(parent.tools, persona);
  // AT-21: only workers delegate onward, and only while above the depth limit.
  const delegates = personaMode(persona) === 'worker' && depth < settings.maxDepth;
  const tools = {
    ...queuedHostTools(narrowed, queue),
    ...(delegates ? createHostDelegationTools(delegation) : {}),
  };
  const maxSteps = effectiveChildStepBudget(persona, settings);
  // The shipped child instructions: a read-only persona also names its tools.
  const instructions =
    personaMode(persona) === 'worker' || Object.keys(narrowed).length === 0
      ? persona.instructions
      : `${persona.instructions}\n\nAvailable tools: ${Object.entries(narrowed)
          .map(([id, tool]) => tool.permissionToolId ?? id)
          .join(', ')}.`;
  // The shipped child context: its persona, then only host-supplied context.
  const system = [instructions, parent.childSystem].filter(Boolean).join('\n\n');
  const provider = parent.provider;
  return {
    childSystem: parent.childSystem,
    configuration: parent.configuration,
    ...(delegates ? { delegation } : {}),
    model: parent.model,
    // The shipped child Memory: the parent's configuration on the child's own
    // thread; a read-only persona's run never reads or writes working memory.
    ...(parent.openRun ? { openRun: parent.openRun } : {}),
    ...(personaMode(persona) === 'worker' ? {} : { workingMemory: false as const }),
    provider: {
      prepare: async (request) => {
        const prepared = provider
          ? await provider.prepare(request)
          : { messages: [...request.messages], model: parent.model };
        if (typeof prepared.model === 'string') {
          throw new Error('A child step requires a resolved model instance');
        }
        const synthesis = maxSteps >= 2 && (request.stepNumber ?? 0) >= maxSteps - 1;
        const cap = synthesis ? settings.synthesisOutputTokens : settings.maxStepOutputTokens;
        return {
          ...prepared,
          maxOutputTokens: Math.min(prepared.maxOutputTokens ?? cap, cap),
          model: hostPermitModel(prepared.model, queue, request.signal),
          system,
          ...(synthesis
            ? {
                activeTools: [],
                messages: [
                  ...prepared.messages,
                  { content: CHILD_WRAP_UP_FEEDBACK, role: 'user' as const },
                ],
                toolChoice: 'none' as const,
              }
            : {}),
        };
      },
    },
    snapshot: {
      configuration: parent.snapshot.configuration,
      maxSteps,
      toolIdentities: Object.fromEntries(
        Object.entries(tools).map(([id, tool]) => [id, tool.identity])
      ),
      ...(parent.snapshot.workspaceBinding
        ? { workspaceBinding: parent.snapshot.workspaceBinding }
        : {}),
    },
    tools,
  };
}

function assistantText(messages: readonly ModelMessage[]): string {
  const last = messages.findLast((message) => message.role === 'assistant');
  if (!last) {
    return '';
  }
  if (typeof last.content === 'string') {
    return last.content;
  }
  return last.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
    .trim();
}

function toolCallCount(messages: readonly ModelMessage[]): number {
  return messages.reduce(
    (count, message) =>
      message.role === 'assistant' && typeof message.content !== 'string'
        ? count + message.content.filter((part) => part.type === 'tool-call').length
        : count,
    0
  );
}

// Wording ported from the shipped delegation hook
// (packages/agent/src/mastra/subagent-delegation.ts, removed with BST-1935).
function missingAnswerText(persona: AssistantPersonaDefinition, calls: number): string {
  if (calls === 0) {
    return (
      `The ${persona.id} subagent returned no answer and made no tool calls, so this ` +
      'delegation produced nothing. Do not treat it as an empty result for the task — ' +
      'retry with a more specific prompt, or gather the material directly.'
    );
  }
  return (
    `The ${persona.id} subagent made ${calls} tool call${calls === 1 ? '' : 's'} ` +
    'but never wrote its summary, so this delegation returned no analysis. Its raw tool ' +
    `results are unanalysed. The subagent may run at most ${persona.maxSteps} steps, so a ` +
    'task this broad can exhaust them before it answers: re-delegate a narrower slice, or ' +
    'gather the remainder directly.'
  );
}

/** The shipped Mastra acknowledgement for a background dispatch. */
export function hostChildStarted(childThreadId: string, toolName: string): HostChildResult {
  return {
    childThreadId,
    status: 'started',
    text: `Background task started. Task ID: ${childThreadId}. The tool "${toolName}" is running in the background. You will be notified when it completes.`,
  };
}

/** What the parent's model reads for a settled child; never an empty success. */
export function hostChildResult(
  childThreadId: string,
  persona: AssistantPersonaDefinition,
  outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome'],
  messages: readonly ModelMessage[]
): HostChildResult {
  if (outcome === 'completed') {
    const text = assistantText(messages);
    return text
      ? { childThreadId, status: 'completed', text }
      : {
          childThreadId,
          status: 'no-answer',
          text: missingAnswerText(persona, toolCallCount(messages)),
        };
  }
  const ended =
    outcome === 'failed' ? 'failed before completing' : `was ${outcome} before completing`;
  return {
    childThreadId,
    status: outcome,
    text:
      `Subagent "${persona.label}" ${ended} the task. Any partial results remain in its ` +
      'child conversation; do not treat this as a completed deliverable.',
  };
}
