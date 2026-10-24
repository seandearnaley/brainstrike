import { DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW } from './context-budget.ts';

/** Where a local model's window came from, for diagnostics. */
export type LocalRuntimeContextWindowSource = 'capped' | 'default' | 'reported';

/**
 * BST-754: a discovered local model's window, the one the picker shows, the
 * run budgets and Ollama allocates (`num_ctx`). It is the model's reported
 * native context, capped at {@link DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW}, or that
 * documented default where the runtime reports none. Ollama left to itself
 * allocated gemma4:31b's native 262,144 tokens (20 GB) while the budget said
 * 32K, and the run stalled.
 */
export function localRuntimeContextWindow(reported: number | undefined): {
  readonly source: LocalRuntimeContextWindowSource;
  readonly tokens: number;
} {
  if (reported === undefined) {
    return { source: 'default', tokens: DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW };
  }
  return reported > DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW
    ? { source: 'capped', tokens: DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW }
    : { source: 'reported', tokens: reported };
}
