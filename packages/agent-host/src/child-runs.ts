/**
 * BST-1932: persona delegation on the host. A child is an ordinary host run
 * in a Core-created child thread (report §4, spike S-SUB); this module holds
 * the pure parts: the `agent-<persona>` tool catalog, the child's narrowed
 * admission, and the result the parent's model reads.
 */
import { createHash } from 'node:crypto';
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
import { canonical, jsonValue } from './json-value.js';
import type { HostDelegation, HostRunAdmission, HostTool } from './ports.js';
import type { HostEvent } from './protocol.js';

/** The shipped Mastra delegation input, less its model-controlled memory/step overrides. */
export const HostDelegationInputSchema = z.object({ prompt: z.string().min(1) });

export const HostChildResultSchema = z.strictObject({
  childThreadId: z.string().min(1),
  status: z.enum(['completed', 'no-answer', 'failed', 'stopped', 'interrupted', 'rejected']),
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
 * persona. A read-only persona keeps only its declared read-risk tools and
 * never delegates or asks the user (BST-1932 S1; workers arrive in S3).
 */
export function narrowHostChildTools(
  parent: Readonly<Record<string, HostTool>>,
  persona: AssistantPersonaDefinition
): Record<string, HostTool> {
  if (personaMode(persona) !== 'read-only') {
    throw new Error(`Persona "${persona.id}" is not a read-only persona`);
  }
  const allowed = new Set(persona.allowedToolIds);
  return Object.fromEntries(
    Object.entries(parent).filter(
      ([id, tool]) =>
        !(tool.delegation || tool.interaction) &&
        tool.risk === 'read' &&
        allowed.has(tool.permissionToolId ?? id)
    )
  );
}

/**
 * A child admission derived from its parent's: same model and provider
 * request hygiene, the persona's instructions ahead of the parent's host
 * system context, narrowed tools, and the persona's enforced step budget.
 */
export function deriveHostChildAdmission(
  parent: HostRunAdmission,
  persona: AssistantPersonaDefinition,
  settings: RuntimeSubagentSettings
): HostRunAdmission {
  const tools = narrowHostChildTools(parent.tools, persona);
  const system = (provided: string | undefined): string =>
    [persona.instructions, provided].filter(Boolean).join('\n\n');
  const provider = parent.provider;
  return {
    configuration: parent.configuration,
    model: parent.model,
    provider: {
      prepare: async (request) => {
        if (!provider) {
          return {
            messages: [...request.messages],
            model: parent.model,
            system: system(undefined),
          };
        }
        const prepared = await provider.prepare(request);
        return { ...prepared, system: system(prepared.system) };
      },
    },
    snapshot: {
      configuration: parent.snapshot.configuration,
      maxSteps: effectiveChildStepBudget(persona, settings),
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
