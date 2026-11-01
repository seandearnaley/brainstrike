import { persistDurable } from '@brainstrike/storage';
import { create } from 'zustand';

/** The Tool Playground's saved test input per tool; tests and E2E seeds write the same key. */
export const TOOL_PLAYGROUND_STORAGE_KEY = 'brainstrike:tool-playground-inputs.v1';

interface ToolPlaygroundInputs {
  readonly inputsByToolId: Readonly<Record<string, string>>;
}

/** Keeps each saved input that is text; anything else reads as nothing saved for that tool. */
function savedInputs(saved: unknown): Record<string, string> {
  const byToolId = (saved as Partial<Record<string, unknown>> | undefined)?.['inputsByToolId'];
  if (!(byToolId && typeof byToolId === 'object')) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(byToolId).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
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
