/**
 * App-wide host for composer MCP prompt selection (BST-1592).
 *
 * Owns every side effect the "/" menu's `execute` must not: the `prompts/get`
 * and `completion/complete` calls over the `mcp:content:*` bridge, the liveness
 * watch on the pinned server generation, the composer write-back, and the
 * visible failure surface. Renders nothing until the user selects a prompt, and
 * nothing at all when the desktop bridge is absent (web) — a capability gate,
 * never an `isElectron()` check.
 *
 * Prompts WITHOUT arguments stage straight into the composer draft (selecting
 * them from the menu is already the explicit user action, and the Settings
 * catalog behaves the same). Prompts WITH arguments open `McpPromptDialog`.
 * Either way the result lands in the DRAFT, never in a sent message and never
 * in model context on its own.
 */

import { createLogger } from '@brainstrike/logging';
import { useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { resolveMcpPromptBridge } from './mcp-prompt-bridge';
import { isMcpPromptEntryLive, type McpPromptEntry } from './mcp-prompt-catalog';
import { McpPromptDialog } from './mcp-prompt-dialog';
import { type McpPromptSelection, useMcpPromptSelectionStore } from './mcp-prompt-selection-store';
import { applyComposerTriggerSplit, buildMcpPromptInsertion } from './mcp-prompt-text';

const logger = createLogger('McpPromptComposerHost');

function retirementMessage(entry: McpPromptEntry): string {
  return `MCP server “${entry.configuredServerId}” is no longer connected on the generation that listed this prompt. Reconnect the server and choose the prompt again.`;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : 'MCP prompt request failed';
}

export function McpPromptComposerHost() {
  // Capability detection reads a preload bridge that exists before React
  // mounts, so resolve it once for the component's lifetime.
  const [bridge] = useState(resolveMcpPromptBridge);
  const selection = useMcpPromptSelectionStore((state) => state.selection);
  const clear = useMcpPromptSelectionStore((state) => state.clear);
  const { toast } = useToast();
  // Retirement is recorded against the SELECTION it was observed for, so a new
  // selection clears it by derivation rather than by a setState-in-effect reset.
  const [retiredSelection, setRetiredSelection] = useState<McpPromptSelection | null>(null);
  const retiredReason =
    retiredSelection !== null && retiredSelection === selection
      ? retirementMessage(retiredSelection.entry)
      : null;

  // The pinned generation is watched only while a selection is open: outside
  // that window the host costs nothing. The content port re-checks authority
  // around the invocation too, so this watch is the VISIBLE half of a failure
  // the port would reject anyway.
  useEffect(() => {
    if (!(bridge && selection)) {
      return;
    }
    let disposed = false;
    const retire = (): void => {
      if (!disposed) {
        setRetiredSelection(selection);
      }
    };
    const check = (snapshot: Parameters<typeof isMcpPromptEntryLive>[1]): void => {
      if (!isMcpPromptEntryLive(selection.entry, snapshot)) {
        retire();
      }
    };
    const dispose = bridge.onServerStatusUpdated((event) =>
      check({ revision: event.revision, servers: event.servers })
    );
    bridge
      .getServerStatusSnapshot()
      .then(check)
      .catch((error: unknown) => {
        logger.error('Failed to re-read MCP host status for a pending prompt', { error });
        retire();
      });
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [bridge, selection]);

  const stage = useCallback(
    async (values: Readonly<Record<string, string>>): Promise<void> => {
      if (!(bridge && selection)) {
        return;
      }
      const { entry, split, threadId } = selection;
      const response = await bridge.getPrompt({
        ...(Object.keys(values).length > 0 ? { arguments: values } : {}),
        authority: {
          configuredServerId: entry.configuredServerId,
          generation: entry.generation,
        },
        name: entry.promptName,
      });
      const insertion = buildMcpPromptInsertion(response.result);
      if (insertion.text.trim().length === 0) {
        throw new Error(
          `Prompt “${entry.title}” returned no text content, so there is nothing to stage.`
        );
      }
      useAssistantComposerCommandStore.getState().enqueue({
        mode: 'replace',
        text: applyComposerTriggerSplit(split, insertion.text),
        threadId,
      });
      if (insertion.omitted.length > 0) {
        toast({
          description: `Staged the text of “${entry.title}”. These parts cannot go in the composer: ${insertion.omitted.join('; ')}.`,
          title: 'Prompt partially staged',
        });
      }
      clear();
    },
    [bridge, clear, selection, toast]
  );

  // Argument-less prompts need no form, so they stage as soon as the user picks
  // them. Keyed on the selection object so a re-render never re-fetches.
  const autoStagedRef = useRef<object | null>(null);
  useEffect(() => {
    if (!(bridge && selection) || selection.entry.arguments.length > 0) {
      return;
    }
    if (autoStagedRef.current === selection) {
      return;
    }
    autoStagedRef.current = selection;
    stage({}).catch((error: unknown) => {
      logger.error('Failed to stage an MCP prompt', {
        error,
        prompt: selection.entry.commandId,
      });
      toast({
        description: failureMessage(error),
        title: 'MCP prompt failed',
        variant: 'destructive',
      });
      clear();
    });
  }, [bridge, clear, selection, stage, toast]);

  if (!(bridge && selection) || selection.entry.arguments.length === 0) {
    return null;
  }
  const entry = selection.entry;
  return (
    <McpPromptDialog
      entry={entry}
      key={entry.commandId}
      onCancel={clear}
      {...(entry.completionSupported
        ? {
            onRequestCompletion: async ({ argument, context, value }) => {
              const response = await bridge.complete({
                argument: { name: argument, value },
                authority: {
                  configuredServerId: entry.configuredServerId,
                  generation: entry.generation,
                },
                ...(Object.keys(context).length > 0 ? { context: { arguments: context } } : {}),
                ref: { name: entry.promptName, type: 'ref/prompt' },
              });
              return response.result.completion.values;
            },
          }
        : {})}
      onSubmit={stage}
      {...(retiredReason === null ? {} : { retiredReason })}
    />
  );
}
