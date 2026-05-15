import { describe, expect, it } from 'vitest';
import {
  type AssistantProviderSettings,
  type AssistantProviderSettingsUpdate,
  mergeAssistantProviderSettings,
  mergeProviderSettings,
  type ProviderSettingsUpdate,
} from '../src/assistant-provider-settings';

interface SettingsWithObjectValue {
  readonly nested?: {
    readonly enabled: boolean;
    readonly label: string;
  };
}

interface SettingsWithRequiredValue {
  readonly required: string;
}

const assertRequiredSettingsRejected = (): void => {
  // This helper is intentionally invoked only by type-checking; the runtime test keeps it referenced.
  mergeProviderSettings<SettingsWithRequiredValue>(
    // @ts-expect-error Required-property records are not provider settings bags.
    { required: 'current' },
    { required: undefined },
    ['required']
  );
};

describe('mergeProviderSettings', () => {
  it('removes keys that are present with undefined values', () => {
    const merged = mergeProviderSettings<AssistantProviderSettings>(
      {
        maxOutputTokens: 4096,
        reasoningEffort: 'medium',
      },
      {
        maxOutputTokens: undefined,
      },
      ['maxOutputTokens', 'reasoningEffort']
    );

    expect(merged).toEqual({ reasoningEffort: 'medium' });
    expect('maxOutputTokens' in merged).toBe(false);
  });

  it('ignores deleted keys that are already absent', () => {
    const merged = mergeProviderSettings<AssistantProviderSettings>(
      {},
      {
        maxOutputTokens: undefined,
      },
      ['maxOutputTokens']
    );

    expect(merged).toEqual({});
    expect('maxOutputTokens' in merged).toBe(false);
  });

  it('preserves existing values when update keys are omitted', () => {
    const merged = mergeProviderSettings<AssistantProviderSettings>(
      {
        maxOutputTokens: 4096,
        reasoningEffort: 'medium',
      },
      {
        reasoningSummary: 'auto',
      },
      ['maxOutputTokens', 'reasoningEffort', 'reasoningSummary']
    );

    expect(merged).toEqual({
      maxOutputTokens: 4096,
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
    });
  });

  it('overwrites existing values when update keys have explicit values', () => {
    const merged = mergeProviderSettings<AssistantProviderSettings>(
      {
        maxOutputTokens: 4096,
        reasoningEffort: 'medium',
      },
      {
        maxOutputTokens: 8192,
        reasoningEffort: 'high',
      },
      ['maxOutputTokens', 'reasoningEffort']
    );

    expect(merged).toEqual({
      maxOutputTokens: 8192,
      reasoningEffort: 'high',
    });
  });

  it('assigns nested object values as explicit replacements', () => {
    const previousNestedValue = { enabled: false, label: 'previous' };
    const nextNestedValue = { enabled: true, label: 'next' };
    const updates: ProviderSettingsUpdate<SettingsWithObjectValue> = {
      nested: nextNestedValue,
    };

    const merged = mergeProviderSettings<SettingsWithObjectValue>(
      {
        nested: previousNestedValue,
      },
      updates,
      ['nested']
    );

    expect(merged.nested).toBe(nextNestedValue);
    expect(merged.nested).not.toBe(previousNestedValue);
  });

  it('keeps no-op updates stable', () => {
    const current: AssistantProviderSettings = {
      googleIncludeThoughts: true,
      maxOutputTokens: 2048,
    };

    expect(
      mergeProviderSettings<AssistantProviderSettings>(current, {}, [
        'googleIncludeThoughts',
        'maxOutputTokens',
      ])
    ).toEqual(current);
  });

  it('ignores runtime update keys outside the explicit allowlist', () => {
    const updates = {
      maxOutputTokens: 4096,
      unexpectedSetting: 'do not persist',
    } as ProviderSettingsUpdate<AssistantProviderSettings> & Record<string, unknown>;

    const merged = mergeProviderSettings<AssistantProviderSettings>({}, updates, [
      'maxOutputTokens',
    ]);

    expect(merged).toEqual({ maxOutputTokens: 4096 });
    expect('unexpectedSetting' in merged).toBe(false);
  });

  it('uses the assistant provider key allowlist in the typed wrapper', () => {
    const updates = {
      maxOutputTokens: 4096,
      unexpectedSetting: 'do not persist',
    } as AssistantProviderSettingsUpdate & Record<string, unknown>;

    const merged = mergeAssistantProviderSettings(undefined, updates);

    expect(merged).toEqual({ maxOutputTokens: 4096 });
    expect('unexpectedSetting' in merged).toBe(false);
  });

  it('rejects required-property settings bags at compile time', () => {
    expect(assertRequiredSettingsRejected).toBeTypeOf('function');
  });
});
