/**
 * ADR-0040: Core's part in project memory. The host's memory module writes the
 * files; Core commits each write (`memory.changed`) and each refusal
 * (`memory.refused`) under the call that made it, tells the tool whether the
 * run has read untrusted content, and finds the write an Undo names.
 */
import { isWebContentToolId, refusalError } from '@brainstrike/assistant-contract';
import type { HostMemoryRecord, HostPlatform, HostTool } from './ports.ts';
import type { HostEvent, HostLogRow, HostParams } from './protocol.ts';
import type { HostMemoryChange } from './protocol-project-memory.ts';

type EffectStarted = Extract<HostEvent, { type: 'effect.started' }>;

/** Whether a call's output is content from the web or an MCP server. */
function readsUntrustedContent(
  call: EffectStarted,
  tools: Readonly<Record<string, HostTool>>
): boolean {
  const registered = tools[call.toolId];
  if (registered?.risk === 'mcp' || registered?.mcpBinding !== undefined) {
    return true;
  }
  return isWebContentToolId(call.toolCatalogId ?? registered?.permissionToolId ?? call.toolId);
}

/** Whether a committed step's messages hold a call of the provider's own web search. */
function stepCalls(messages: readonly unknown[], toolName: string): boolean {
  return messages.some((message) => {
    const content =
      typeof message === 'object' && message !== null
        ? (message as { readonly content?: unknown }).content
        : undefined;
    return (
      Array.isArray(content) &&
      content.some(
        (part: unknown) =>
          typeof part === 'object' &&
          part !== null &&
          (part as { readonly toolName?: unknown }).toolName === toolName
      )
    );
  });
}

/**
 * Whether the run has read web or MCP tool output: a call of a web tool or an
 * MCP tool that finished, or the provider's own web search in one of its steps.
 * A call still running has not reached the model, so it does not count.
 */
export function hostRunReadUntrustedContent(
  rows: readonly HostLogRow[],
  run: {
    readonly id: string;
    readonly nativeWebSearch?: { readonly toolId: string } | undefined;
  },
  tools: Readonly<Record<string, HostTool>>
): boolean {
  const started = new Map<string, EffectStarted>();
  for (const { event } of rows) {
    if (!('runId' in event) || event.runId !== run.id) {
      continue;
    }
    if (event.type === 'effect.started') {
      started.set(event.toolCallId, event);
      continue;
    }
    if (event.type === 'effect.finished') {
      const call = started.get(event.toolCallId);
      if (call && readsUntrustedContent(call, tools)) {
        return true;
      }
      continue;
    }
    const native = run.nativeWebSearch?.toolId;
    if (event.type === 'model.step' && native !== undefined && stepCalls(event.messages, native)) {
      return true;
    }
  }
  return false;
}

/** The record one memory tool call writes through: its run's untrusted reads and its commits. */
export function hostMemoryRecord(options: {
  readonly append: (events: readonly HostEvent[]) => Promise<unknown>;
  readonly rows: () => readonly HostLogRow[];
  readonly run: Parameters<typeof hostRunReadUntrustedContent>[1];
  readonly runId: string;
  readonly toolCallId: string;
  readonly tools: Readonly<Record<string, HostTool>>;
}): HostMemoryRecord {
  const call = { runId: options.runId, toolCallId: options.toolCallId };
  return {
    changed: async (change) => {
      await options.append([{ ...call, ...change, type: 'memory.changed' }]);
    },
    refused: async (refusal) => {
      await options.append([{ ...call, ...refusal, type: 'memory.refused' }]);
    },
    untrustedContext: () => hostRunReadUntrustedContent(options.rows(), options.run, options.tools),
  };
}

/**
 * The write an Undo names, from the thread's committed rows. Refused when the
 * call made no write, and when Undo already restored it.
 */
export function committedMemoryChange(
  rows: readonly HostLogRow[],
  call: { readonly runId: string; readonly threadId: string; readonly toolCallId: string }
): HostMemoryChange {
  let change: HostMemoryChange | undefined;
  for (const { event, threadId } of rows) {
    if (
      threadId !== call.threadId ||
      !('runId' in event) ||
      event.runId !== call.runId ||
      !('toolCallId' in event) ||
      event.toolCallId !== call.toolCallId
    ) {
      continue;
    }
    if (event.type === 'memory.undone') {
      throw refusalError('conflict', 'memory.already-undone', 'This save was already undone.');
    }
    if (event.type === 'memory.changed') {
      const { runId: _run, toolCallId: _call, type: _type, ...fields } = event;
      change = fields;
    }
  }
  if (!change) {
    throw refusalError('conflict', 'memory.no-change', 'This call saved nothing to memory.');
  }
  return change;
}

/**
 * Undo of one memory write: the platform's memory files restore what the
 * write replaced, and the result is the `memory.undone` Core commits.
 */
export async function undoHostMemoryChange(
  params: HostParams<'memory/undo'>,
  rows: readonly HostLogRow[],
  platform: Pick<HostPlatform, 'projectMemory'>
): Promise<HostEvent> {
  const change = committedMemoryChange(rows, params);
  if (!platform.projectMemory) {
    throw refusalError(
      'availability',
      'memory.unavailable',
      'This host keeps no project memory, so nothing was undone.'
    );
  }
  await platform.projectMemory.undo(change);
  const { commandId, runId, toolCallId } = params;
  return { commandId, runId, toolCallId, type: 'memory.undone' };
}
