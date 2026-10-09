/**
 * MCP server prompts as composer "/" slash commands (BST-1592) — the FOURTH
 * entry kind in the same `SlashCommand[]` the app commands, user-defined
 * `/commands`, and Agent Skills already flow through. No parallel autocomplete
 * surface is introduced.
 *
 * Desktop-only by construction: `resolveMcpPromptBridge()` reports `unsupported`
 * without the visible-UI preload, so web offers nothing (capability gating,
 * never `isElectron()`). A present-but-partial bridge is a DEFECT, not an
 * unsupported runtime: it also offers nothing here, and `McpPromptComposerHost`
 * says so out loud.
 *
 * Selecting an entry NEVER sends and never enters model context on its own: it
 * hands the selection to `McpPromptComposerHost`, which fetches `prompts/get`
 * only on an explicit user action and stages the result in the composer draft
 * for the user to read, edit, and send.
 */
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import type { SlashCommand } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';
import { useMcpContentCapability } from './mcp-content-capability';
import { resolveMcpPromptBridge } from './mcp-prompts/mcp-prompt-bridge';
import { type McpPromptEntry, selectMcpPromptEntries } from './mcp-prompts/mcp-prompt-catalog';
import { useMcpPromptSelectionStore } from './mcp-prompts/mcp-prompt-selection-store';
import { splitComposerTrigger } from './mcp-prompts/mcp-prompt-text';
import { useMcpStatusCapability } from './mcp-status-capability';

const logger = createLogger('McpPromptSlashCommands');

type McpPromptToast = (input: {
  description: string;
  title: string;
  variant: 'destructive';
}) => void;

const EMPTY_SNAPSHOT: McpHostSnapshot = { revision: 0, servers: [] };

/**
 * Hand one selected prompt to the app-wide host. The typed trigger is still in
 * the LIVE draft at this point (the adapter strips it after `execute`), so the
 * surrounding text is captured NOW and spliced back when the prompt is staged.
 */
function selectPrompt(
  entry: McpPromptEntry,
  threadId: string | undefined,
  toast: McpPromptToast
): void {
  if (!threadId) {
    logger.warn('Cannot stage an MCP prompt without an active thread', {
      prompt: entry.commandId,
    });
    toast({
      description: 'Open or start a thread, then choose the prompt again.',
      title: 'No active thread',
      variant: 'destructive',
    });
    return;
  }
  const draftText = useAssistantComposerCommandStore.getState().draftTextByThreadId[threadId] ?? '';
  useMcpPromptSelectionStore.getState().select({
    draftText,
    entry,
    split: splitComposerTrigger(draftText, entry.commandId),
    threadId,
  });
}

/**
 * The prompts every connected MCP server currently offers, as slash commands.
 * The revisioned host status channel is the single source of truth: the list
 * reloads on the pushed watch event, so a server that connects, disconnects, or
 * republishes its catalog is reflected without a reload.
 */
export function useMcpPromptSlashCommands(threadId: string | undefined): readonly SlashCommand[] {
  // Capability detection reads a preload bridge that exists before React
  // mounts, so resolve it once for the component's lifetime. A malformed bridge
  // is surfaced by `McpPromptComposerHost` (always mounted); this hook only has
  // to offer nothing.
  const status = useMcpStatusCapability();
  const content = useMcpContentCapability();
  const [resolution] = useState(() => resolveMcpPromptBridge(status, content));
  const bridge = resolution.status === 'ready' ? resolution.bridge : null;
  const [snapshot, setSnapshot] = useState<McpHostSnapshot>(EMPTY_SNAPSHOT);
  const { toast } = useToast();

  // TWO independent channels feed this state: the initial snapshot read and the
  // pushed watch events. The effect generation separates effect RUNS but says
  // nothing about their ordering, so an initial reply issued at revision 4 can
  // still land after a pushed revision 5 and restore the pre-update list until
  // some unrelated push arrives. `McpHostSnapshot.revision` is the monotonic
  // token that closes it: an older snapshot is dropped, never applied.
  const generationRef = useRef(0);
  const appliedRevisionRef = useRef(-1);
  const applySnapshot = useCallback((next: McpHostSnapshot, generation: number) => {
    if (generation !== generationRef.current || next.revision < appliedRevisionRef.current) {
      return;
    }
    appliedRevisionRef.current = next.revision;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    generationRef.current += 1;
    // A new generation watches a fresh host: revisions are only comparable
    // within one, so the applied watermark resets with it.
    appliedRevisionRef.current = -1;
    const generation = generationRef.current;
    const dispose = bridge.onServerStatusUpdated((event) => {
      applySnapshot({ revision: event.revision, servers: event.servers }, generation);
    });
    bridge
      .getServerStatusSnapshot()
      .then((initial) => applySnapshot(initial, generation))
      .catch((error: unknown) => {
        logger.error('Failed to read MCP host status for the slash menu', { error });
      });
    return () => {
      generationRef.current += 1;
      dispose?.();
    };
  }, [applySnapshot, bridge]);

  const entries = useMemo(() => selectMcpPromptEntries(snapshot), [snapshot]);

  return useMemo<readonly SlashCommand[]>(
    () =>
      entries.map((entry) => ({
        ...(entry.description === undefined ? {} : { description: entry.description }),
        execute: () => {
          selectPrompt(entry, threadId, toast);
        },
        id: entry.commandId,
        label: entry.label,
      })),
    [entries, threadId, toast]
  );
}
