/**
 * The one pending composer MCP prompt selection (BST-1592).
 *
 * The "/" popover's `execute` runs outside React render (it is a plain callback
 * pre-bound into the adapter), so the selection is handed to the app-wide host
 * through this store exactly as Agent Skills hand their directive to
 * `assistant-composer-command-store`. Ephemeral by design: it holds no server
 * content, survives nothing, and needs no factory-reset wiring.
 *
 * Only ONE selection is pending at a time — the dialog is modal, and the "/"
 * menu is unreachable behind it — so a second `open` replaces the first rather
 * than queueing a stack the user never asked for.
 */
import { create } from 'zustand';
import type { McpPromptEntry } from './mcp-prompt-catalog';
import type { ComposerTriggerSplit } from './mcp-prompt-text';

export interface McpPromptSelection {
  /**
   * The live draft as it stood when the prompt was picked. `prompts/get` is a
   * round trip and the composer stays editable across it, so the host compares
   * this against the live draft before replacing anything — see
   * `isComposerDraftUntouched`.
   */
  readonly draftText: string;
  readonly entry: McpPromptEntry;
  /** The live draft split around the typed trigger, captured before it is stripped. */
  readonly split: ComposerTriggerSplit;
  readonly threadId: string;
}

interface McpPromptSelectionState {
  readonly clear: () => void;
  readonly select: (selection: McpPromptSelection) => void;
  readonly selection: McpPromptSelection | null;
}

export const useMcpPromptSelectionStore = create<McpPromptSelectionState>((set) => ({
  clear: () => set({ selection: null }),
  select: (selection) => set({ selection }),
  selection: null,
}));
