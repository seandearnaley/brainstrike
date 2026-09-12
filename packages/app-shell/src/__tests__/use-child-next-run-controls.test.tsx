// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useChildNextRunControls } from '../use-child-next-run-controls';

vi.mock('../hooks/use-configured-assistant-providers', () => ({
  useConfiguredAssistantProviders: () => ({ discoveryState: 'ready', providers: ['openai'] }),
}));
vi.mock('../hooks/use-assistant-local-runtime-catalog', () => ({
  useAssistantLocalRuntimeCatalog: () => ({ localRuntimeModels: null }),
}));
afterEach(cleanup);
const persona = {
  allowedToolIds: ['brainstrike.grepSearch', 'brainstrike.readWorkspaceFile'],
  description: 'Read',
  id: 'reader',
  instructions: 'Read',
  label: 'Reader',
  maxSteps: 4,
};
const input = { id: 'input', text: 'Continue' };
const inheritedProviderSettings = {
  openai: { maxOutputTokens: 1000, reasoningEffort: 'low' as const },
};
const props = {
  inheritedModel: 'openai::gpt-5.4',
  inheritedPlanMode: false,
  inheritedProviderSettings,
  isRunning: () => false,
  persona,
};

it('uses the current root selection until overridden and sends complete child-local generation settings', () => {
  const { result, rerender } = renderHook(useChildNextRunControls, { initialProps: props });
  expect(result.current.selectedModel).toBe('openai::gpt-5.4');
  rerender({ ...props, inheritedModel: 'openai::gpt-5.6-sol' });
  expect(result.current.selectedModel).toBe('openai::gpt-5.6-sol');
  act(() =>
    result.current.panelProps.onProviderSettingsChange?.('openai', {
      maxOutputTokens: 777,
      reasoningEffort: 'high',
    })
  );
  expect(result.current.prepareInput(input)).toMatchObject({
    nextRun: {
      model: { modelId: 'gpt-5.6-sol', provider: 'openai' },
      modelSettings: { maxOutputTokens: 777 },
      providerOptions: { openai: { reasoningEffort: 'high' } },
    },
  });
  expect(inheritedProviderSettings.openai).toEqual({
    maxOutputTokens: 1000,
    reasoningEffort: 'low',
  });
});
it('keeps a persona pin and attaches controls only to a new idle input', () => {
  const isRunning = vi.fn(() => true);
  const { result } = renderHook(useChildNextRunControls, {
    initialProps: {
      ...props,
      isRunning,
      persona: { ...persona, model: { modelId: 'gpt-5.4-mini', provider: 'openai' } },
    },
  });
  expect(result.current.selectedModel).toBe('openai::gpt-5.4-mini');
  act(() =>
    result.current.panelProps.onProviderSettingsChange?.('openai', { reasoningEffort: 'high' })
  );
  expect(result.current.prepareInput(input)).toBe(input);
  isRunning.mockReturnValue(false);
  expect(result.current.prepareInput(input).nextRun?.model?.modelId).toBe('gpt-5.4-mini');
});
it('only offers the admitted tool catalog and preserves a root-imposed plan', () => {
  const { result } = renderHook(useChildNextRunControls, {
    initialProps: { ...props, inheritedPlanMode: true },
  });
  expect(result.current.panelProps.toolMenu?.items.map((tool) => tool.id)).toEqual(
    persona.allowedToolIds
  );
  act(() => {
    result.current.panelProps.planMode?.onToggle();
    result.current.panelProps.toolMenu?.onToggleTool?.('brainstrike.grepSearch', false);
  });
  expect(result.current.prepareInput(input).nextRun).toMatchObject({
    disabledToolIds: ['brainstrike.grepSearch'],
    planMode: true,
  });
  expect(
    result.current.panelProps.toolMenu?.items.find(
      (tool) => tool.id === 'brainstrike.readWorkspaceFile'
    )?.disabled
  ).toBe(true);
});

it('carries explicit defaults so cleared generation controls cannot inherit stale root limits', () => {
  const { result } = renderHook(useChildNextRunControls, { initialProps: props });
  act(() =>
    result.current.panelProps.onProviderSettingsChange?.('openai', {
      maxOutputTokens: undefined,
      reasoningEffort: undefined,
    })
  );
  expect(result.current.prepareInput(input).nextRun?.modelSettings).toEqual({});
});

it('keeps local endpoint credentials out of the child receipt', () => {
  const { result } = renderHook(useChildNextRunControls, {
    initialProps: {
      ...props,
      inheritedModel: 'ollama::qwen3',
      inheritedProviderSettings: {
        ollama: { localRuntimeBaseUrl: 'http://localhost:11434' },
      },
    },
  });
  const prepared = result.current.prepareInput(input);
  expect(prepared.nextRun?.providerOptions).toEqual({});
  expect(JSON.stringify(prepared)).not.toContain('11434');
});
