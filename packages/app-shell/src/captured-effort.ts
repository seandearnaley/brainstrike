import type { ChildExecutionConfiguration } from '@brainstrike/assistant-contract';

/** The reasoning effort a child run's captured provider options asked for. */
export function capturedEffort(execution: ChildExecutionConfiguration): string {
  const options = execution.providerOptions;
  switch (execution.provider) {
    case 'openai':
      return options?.openai?.reasoningEffort ?? 'Provider default';
    case 'openrouter':
      return options?.openrouter?.reasoning?.enabled === false
        ? 'none'
        : (options?.openrouter?.reasoning?.effort ?? 'Provider default');
    case 'anthropic':
      return options?.anthropic?.thinking?.type === 'disabled'
        ? 'none'
        : (options?.anthropic?.effort ?? 'Provider default');
    case 'bedrock':
      return options?.bedrock?.reasoningConfig?.type === 'disabled'
        ? 'none'
        : (options?.bedrock?.reasoningConfig?.maxReasoningEffort ?? 'Provider default');
    case 'google':
      return options?.google?.thinkingConfig?.thinkingBudget === 0
        ? 'none'
        : (options?.google?.thinkingConfig?.thinkingLevel ?? 'Provider default');
    default:
      return 'Provider default';
  }
}
