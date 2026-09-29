import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAssistantModelChange } from './use-assistant-model-change';

function renderModelChange(
  providerSettings: Parameters<typeof useAssistantModelChange>[0]['providerSettings'],
  currentModel = 'google::gemini-3.5-flash'
) {
  const setModel = vi.fn();
  const setProviderSettings = vi.fn();
  const setThreadDraftRuntime = vi.fn();
  const { result } = renderHook(() =>
    useAssistantModelChange({
      currentModel,
      draftRuntimeByThreadId: {},
      fixedProviderModels: undefined,
      memoryThreadId: undefined,
      providerSettings,
      setModel,
      setProviderSettings,
      setThreadDraftRuntime,
    })
  );
  return { result, setModel, setProviderSettings, setThreadDraftRuntime };
}

describe('useAssistantModelChange provider reconciliation', () => {
  it('clears a persisted minimal level when switching to Gemini 3.7 Flash', () => {
    const { result, setModel, setProviderSettings } = renderModelChange({
      google: { googleThinkingLevel: 'minimal', maxOutputTokens: 2048 },
    });

    act(() => result.current.handleModelChange('google::gemini-3.7-flash'));

    expect(setProviderSettings).toHaveBeenCalledOnce();
    const [provider, updates] = setProviderSettings.mock.calls[0] ?? [];
    expect(provider).toBe('google');
    expect(Object.keys(updates ?? {})).toEqual(['googleThinkingLevel']);
    expect(updates).toHaveProperty('googleThinkingLevel', undefined);
    expect(setModel).toHaveBeenCalledWith('google::gemini-3.7-flash');
  });

  it('preserves a thinking level offered by Gemini 3.7 Flash', () => {
    const { result, setProviderSettings } = renderModelChange({
      google: { googleThinkingLevel: 'low' },
    });

    act(() => result.current.handleModelChange('google::gemini-3.7-flash'));

    expect(setProviderSettings).not.toHaveBeenCalled();
  });

  it('clears an unsupported Bedrock effort on a global model switch', () => {
    const { result, setModel, setProviderSettings } = renderModelChange({
      bedrock: { bedrockEffort: 'max', maxOutputTokens: 2048 },
    });

    act(() => result.current.handleModelChange('bedrock::amazon.nova-2-lite-v1:0'));

    expect(setProviderSettings).toHaveBeenCalledOnce();
    const [provider, updates] = setProviderSettings.mock.calls[0] ?? [];
    expect(provider).toBe('bedrock');
    expect(Object.keys(updates ?? {})).toEqual(['bedrockEffort']);
    expect(updates).toHaveProperty('bedrockEffort', undefined);
    expect(setModel).toHaveBeenCalledWith('bedrock::amazon.nova-2-lite-v1:0');
  });
  it('clears only anthropicEffort on a global Sonnet 5 to Sonnet 4.6 switch', () => {
    const { result, setModel, setProviderSettings, setThreadDraftRuntime } = renderModelChange(
      {
        anthropic: { anthropicEffort: 'xhigh', maxOutputTokens: 2048 },
      },
      'anthropic::claude-sonnet-5'
    );
    act(() => result.current.handleModelChange('anthropic::claude-sonnet-4-6'));
    expect(setProviderSettings).toHaveBeenCalledOnce();
    const [provider, updates] = setProviderSettings.mock.calls[0] ?? [];
    expect(provider).toBe('anthropic');
    expect(Object.keys(updates ?? {})).toEqual(['anthropicEffort']);
    expect(updates).toHaveProperty('anthropicEffort', undefined);
    expect(setModel).toHaveBeenCalledWith('anthropic::claude-sonnet-4-6');
    expect(setThreadDraftRuntime).not.toHaveBeenCalled();
  });

  it('emits nothing for a supported Anthropic effort on a global switch', () => {
    const { result, setProviderSettings } = renderModelChange(
      {
        anthropic: { anthropicEffort: 'high' },
      },
      'anthropic::claude-sonnet-5'
    );
    act(() => result.current.handleModelChange('anthropic::claude-sonnet-4-6'));
    expect(setProviderSettings).not.toHaveBeenCalled();
  });
});
