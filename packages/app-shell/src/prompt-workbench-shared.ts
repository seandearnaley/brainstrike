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

function draftNumberValue(value: unknown, field: string): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Prompt model setting "${field}" must be a finite number.`);
  }
  return String(value);
}

export function toModelSettingsDraft(
  settings: Record<string, unknown> | null
): PromptModelSettingsDraft {
  if (settings?.['maxTokens'] !== undefined && settings['maxOutputTokens'] !== undefined) {
    throw new Error('Prompt model settings cannot specify both "maxTokens" and "maxOutputTokens".');
  }
  return {
    frequencyPenalty: draftNumberValue(settings?.['frequencyPenalty'], 'frequencyPenalty'),
    maxOutputTokens: draftNumberValue(
      settings?.['maxOutputTokens'] ?? settings?.['maxTokens'],
      settings?.['maxOutputTokens'] === undefined ? 'maxTokens' : 'maxOutputTokens'
    ),
    presencePenalty: draftNumberValue(settings?.['presencePenalty'], 'presencePenalty'),
    temperature: draftNumberValue(settings?.['temperature'], 'temperature'),
    topP: draftNumberValue(settings?.['topP'], 'topP'),
  };
}

function parseDraftNumber(
  value: string,
  field: string,
  bounds: { readonly integer?: boolean; readonly max?: number; readonly min?: number }
): number | undefined {
  if (!value.trim()) {
    return;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Prompt model setting "${field}" must be a finite number.`);
  }
  if (bounds.integer && !Number.isInteger(parsed)) {
    throw new Error(`Prompt model setting "${field}" must be an integer.`);
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    throw new Error(`Prompt model setting "${field}" must be at least ${bounds.min}.`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new Error(`Prompt model setting "${field}" must be at most ${bounds.max}.`);
  }
  return parsed;
}

export function buildPromptModelSettings(
  draft: PromptModelSettingsDraft,
  existing: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  const settings = { ...(existing ?? {}) };
  for (const key of [
    'frequencyPenalty',
    'maxOutputTokens',
    'maxTokens',
    'presencePenalty',
    'temperature',
    'topP',
  ]) {
    delete settings[key];
  }

  const temperature = parseDraftNumber(draft.temperature, 'temperature', { max: 2, min: 0 });
  const topP = parseDraftNumber(draft.topP, 'topP', { max: 1, min: 0 });
  const maxOutputTokens = parseDraftNumber(draft.maxOutputTokens, 'maxOutputTokens', {
    integer: true,
    min: 1,
  });
  const frequencyPenalty = parseDraftNumber(draft.frequencyPenalty, 'frequencyPenalty', {
    max: 2,
    min: -2,
  });
  const presencePenalty = parseDraftNumber(draft.presencePenalty, 'presencePenalty', {
    max: 2,
    min: -2,
  });

  if (temperature !== undefined) {
    settings['temperature'] = temperature;
  }
  if (topP !== undefined) {
    settings['topP'] = topP;
  }
  if (maxOutputTokens !== undefined) {
    settings['maxOutputTokens'] = maxOutputTokens;
  }
  if (frequencyPenalty !== undefined) {
    settings['frequencyPenalty'] = frequencyPenalty;
  }
  if (presencePenalty !== undefined) {
    settings['presencePenalty'] = presencePenalty;
  }
  return Object.keys(settings).length > 0 ? settings : null;
}
