import type { PromptItemKind } from '@brainstrike/db';

export interface PromptWorkbenchModelOption {
  readonly key: string;
  readonly label: string;
}

export interface PromptModelSettingsDraft {
  frequencyPenalty: string;
  maxOutputTokens: string;
  presencePenalty: string;
  temperature: string;
  topP: string;
}

export interface PromptDraft {
  content: string;
  description: string;
  isFavorite: boolean;
  kind: PromptItemKind;
  modelKey: string;
  modelSettings: PromptModelSettingsDraft;
  sourceUrl: string;
  tags: string;
  title: string;
}

export const PROMPT_KINDS: readonly PromptItemKind[] = ['fragment', 'snippet', 'prompt'];

export const KIND_COPY: Record<PromptItemKind, { label: string; short: string }> = {
  fragment: { label: 'Idea fragment', short: 'Fragment' },
  prompt: { label: 'Runnable prompt', short: 'Prompt' },
  snippet: { label: 'Reusable snippet', short: 'Snippet' },
};

export function promptWorkbenchErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : `Unexpected prompt workbench failure: ${String(error)}`;
}
