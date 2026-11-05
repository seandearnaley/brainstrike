import { createLogger } from '@brainstrike/logging';
import { persistDurable } from '@brainstrike/storage';
import { create } from 'zustand';

const logger = createLogger('ToolPlaygroundInputs');

/** The Tool Playground's saved test input per tool; tests write the same key. */
export const TOOL_PLAYGROUND_STORAGE_KEY = 'brainstrike:tool-playground-inputs.v1';

interface ToolPlaygroundInputs {
  readonly inputsByToolId: Readonly<Record<string, string>>;
}

/**
 * Keeps each saved input that is text; anything else reads as nothing saved for that tool
 * and is logged.
 */
function savedInputs(saved: unknown): Record<string, string> {
  const byToolId = (saved as Partial<Record<string, unknown>> | undefined)?.['inputsByToolId'];
  if (byToolId === undefined) {
    return {};
  }
  if (!(byToolId && typeof byToolId === 'object')) {
    logger.warn('Ignoring saved Tool Playground inputs that are not a map', {
      type: typeof byToolId,
    });
    return {};
  }
  const entries = Object.entries(byToolId);
  const kept = entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (kept.length < entries.length) {
    const keptIds = new Set(kept.map(([toolId]) => toolId));
    logger.warn('Ignoring saved Tool Playground inputs that are not text', {
      toolIds: entries.map(([toolId]) => toolId).filter((toolId) => !keptIds.has(toolId)),
    });
  }
  return Object.fromEntries(kept);
}

/** Renderer-only view state (`persistDurable`): what the user last typed into each tool's playground. */
export const useToolPlaygroundInputsStore = create<ToolPlaygroundInputs>()(
  persistDurable(
    TOOL_PLAYGROUND_STORAGE_KEY,
    (): ToolPlaygroundInputs => ({ inputsByToolId: {} }),
    {
      merge: (saved, current) => ({ ...current, inputsByToolId: savedInputs(saved) }),
      version: 1,
    }
  )
);

export function saveToolPlaygroundInput(toolId: string, input: string): void {
  useToolPlaygroundInputsStore.setState((state) => ({
    inputsByToolId: { ...state.inputsByToolId, [toolId]: input },
  }));
}
