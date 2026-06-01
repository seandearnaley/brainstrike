import type { Prompt } from './types';

export function hasModelSettingsChanged(
  next: Prompt['modelSettings'],
  previous: Prompt['modelSettings']
): boolean {
  return (
    next.model !== previous.model ||
    next.temperature !== previous.temperature ||
    next.topP !== previous.topP ||
    next.maxTokens !== previous.maxTokens ||
    next.frequencyPenalty !== previous.frequencyPenalty ||
    next.presencePenalty !== previous.presencePenalty
  );
}
