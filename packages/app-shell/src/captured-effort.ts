import type { ChildExecutionConfiguration } from '@brainstrike/assistant-contract';

/** The reasoning effort a run's captured provider options asked for; `Auto` leaves it to the model, as the composer's Effort chip says. */
export function capturedEffort(execution: ChildExecutionConfiguration): string {
  const options = execution.providerOptions;
  switch (execution.provider) {
    case 'openai':
    case 'chatgpt':
      return options?.openai?.reasoningEffort ?? 'Auto';
    case 'openrouter':
      return options?.openrouter?.reasoning?.enabled === false
        ? 'none'
        : (options?.openrouter?.reasoning?.effort ?? 'Auto');
    case 'anthropic':
      return options?.anthropic?.thinking?.type === 'disabled'
        ? 'none'
        : (options?.anthropic?.effort ?? 'Auto');
    case 'bedrock':
      return options?.bedrock?.reasoningConfig?.type === 'disabled'
        ? 'none'
        : (options?.bedrock?.reasoningConfig?.maxReasoningEffort ?? 'Auto');
    case 'google':
      return options?.google?.thinkingConfig?.thinkingBudget === 0
        ? 'none'
        : (options?.google?.thinkingConfig?.thinkingLevel ?? 'Auto');
    default:
      return 'Auto';
  }
}
