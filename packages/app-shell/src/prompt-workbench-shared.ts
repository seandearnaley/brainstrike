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

export const PROMPT_EDITABLE_MODEL_SETTING_KEYS = [
  'frequencyPenalty',
  'maxOutputTokens',
  'maxTokens',
  'presencePenalty',
  'temperature',
  'topP',
] as const;

export const PROMPT_MODEL_SETTING_KEYS: ReadonlySet<string> = new Set([
  ...PROMPT_EDITABLE_MODEL_SETTING_KEYS,
  'model',
]);

export const PROMPT_MODEL_SETTING_LIMITS = {
  frequencyPenalty: { max: 2, min: -2, step: 'any' },
  maxOutputTokens: { integer: true, min: 1, step: '1' },
  presencePenalty: { max: 2, min: -2, step: 'any' },
  temperature: { max: 2, min: 0, step: 'any' },
  topP: { max: 1, min: 0, step: 'any' },
} as const;

type PromptModelSettingLimitKey = keyof typeof PROMPT_MODEL_SETTING_LIMITS;

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

export function requirePromptModelSettingNumber(
  value: unknown,
  field: string,
  limitKey: PromptModelSettingLimitKey
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Prompt model setting "${field}" must be a finite number.`);
  }
  const limits = PROMPT_MODEL_SETTING_LIMITS[limitKey];
  if ('integer' in limits && (!Number.isInteger(value) || value < limits.min)) {
    throw new Error(`Prompt model setting "${field}" must be a positive integer.`);
  }
  if ('max' in limits && (value < limits.min || value > limits.max)) {
    throw new Error(
      `Prompt model setting "${field}" must be between ${limits.min} and ${limits.max}.`
    );
  }
  if (!('max' in limits) && value < limits.min) {
    throw new Error(`Prompt model setting "${field}" must be at least ${limits.min}.`);
  }
  return value;
}

function parseDraftNumber(
  value: string,
  field: string,
  limitKey: PromptModelSettingLimitKey
): number | undefined {
  if (!value.trim()) {
    return;
  }
  const parsed = Number(value);
  return requirePromptModelSettingNumber(parsed, field, limitKey);
}

export function buildPromptModelSettings(
  draft: PromptModelSettingsDraft,
  existing: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  const settings = { ...(existing ?? {}) };
  for (const key of PROMPT_EDITABLE_MODEL_SETTING_KEYS) {
    delete settings[key];
  }

  const temperature = parseDraftNumber(draft.temperature, 'temperature', 'temperature');
  const topP = parseDraftNumber(draft.topP, 'topP', 'topP');
  const maxOutputTokens = parseDraftNumber(
    draft.maxOutputTokens,
    'maxOutputTokens',
    'maxOutputTokens'
  );
  const frequencyPenalty = parseDraftNumber(
    draft.frequencyPenalty,
    'frequencyPenalty',
    'frequencyPenalty'
  );
  const presencePenalty = parseDraftNumber(
    draft.presencePenalty,
    'presencePenalty',
    'presencePenalty'
  );

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
