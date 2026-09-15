import './assistant-ui-panel-wrapper-test-support';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { WEB_NATIVE_TOOL_IDS } from '@brainstrike/assistant-contract';
import { HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES } from '@brainstrike/assistant-contract/assistant-request-body-limit';
import { DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY } from '@brainstrike/assistant-contract/memory-settings';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import {
  ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS,
  acquireAssistantForegroundActivity,
  getAssistantForegroundActivitySnapshot,
} from '../assistant-foreground-activity';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { AssistantProviderSourceProvider } from '../hooks/assistant-provider-source';
import {
  changesetRefreshMock,
  fileExplorerMocks,
  hasDesktopLlmHostMock,
  loadTestLocalLlmBackend,
  type McpToolDescriptor,
  mockDb,
  NATIVE_TOOL_COUNT,
  preparedRequestDataLog,
  readPanelContextMenu,
  readPanelRequestData,
  renderAssistantPanel,
  renderAssistantThreadPanel,
  type SelectionUpdateHandler,
  setMcpApi,
  testEnabledModels,
  useChangesetMock,
} from './assistant-ui-panel-wrapper-test-support';

describe('AssistantUiPanelWrapper', () => {
  test('re-reads the checkpoint journal when a run finishes (no thread switch)', async () => {
    const user = userEvent.setup();
    const countCheckpointReads = (): number =>
      mockDb.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('brainstrike_assistant_edit_checkpoints')
      ).length;

    await renderAssistantThreadPanel(['openai'], 'thread-existing');
    await screen.findByTestId('assistant-ui-panel');

    // The thread-open read happened; capture the baseline.
    await waitFor(() => {
      expect(countCheckpointReads()).toBeGreaterThan(0);
    });
    const beforeRunFinished = countCheckpointReads();

    // A run reaching a terminal state must re-read the journal so an edit
    // journaled during the turn that JUST ran surfaces without a thread switch.
    await act(async () => {
      await user.click(screen.getByTestId('trigger-run-finished'));
    });

    await waitFor(() => {
      expect(countCheckpointReads()).toBeGreaterThan(beforeRunFinished);
    });
  });

  test('composes the changeset refresh into run-finished and run-failed, inert until W4 wires a selection', async () => {
    const user = userEvent.setup();
    await renderAssistantThreadPanel(['openai'], 'thread-existing');
    await screen.findByTestId('assistant-ui-panel');
    changesetRefreshMock.mockClear();

    await act(async () => {
      await user.click(screen.getByTestId('trigger-run-finished'));
    });
    expect(changesetRefreshMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await user.click(screen.getByTestId('trigger-run-failed'));
    });
    expect(changesetRefreshMock).toHaveBeenCalledTimes(2);

    // No selection UI lands until W4: every call is wired with a null
    // changeset, so `useChangeset`'s own inertness (unit-tested separately)
    // guarantees today's composed refresh never reaches the bridge.
    for (const call of useChangesetMock.mock.calls) {
      expect(call[1]).toBeNull();
    }
  });

  test('bridges only the active thread command into the composer and acknowledges it', async () => {
    const activeCommand = useAssistantComposerCommandStore.getState().enqueue({
      mode: 'append',
      text: 'Use the evidence rubric.',
      threadId: 'thread-active',
    });
    useAssistantComposerCommandStore.getState().enqueue({
      mode: 'replace',
      text: 'Do not leak into the active composer.',
      threadId: 'thread-other',
    });

    await renderAssistantThreadPanel(['openai'], 'thread-active');

    expect(screen.getByTestId('composer-draft-command')).toHaveTextContent(activeCommand.id);
    await userEvent.click(screen.getByTestId('apply-composer-draft-command'));
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']
    ).toBeUndefined();
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-other']
    ).toHaveLength(1);

    await userEvent.click(screen.getByTestId('report-composer-text'));
    expect(useAssistantComposerCommandStore.getState().draftTextByThreadId['thread-active']).toBe(
      'Live composer draft'
    );
  });

  /**
   * A root Stop that cancelled an undecided pause re-reads history by
   * REMOUNTING the panel's runtime (BST-1749), which discards the live
   * composer. The wrapper carries the draft across that remount through the
   * thread-scoped command store the prompt library already uses — never the
   * global rewind slot, which no open thread owns (owner ruling 2026-09-15).
   */
  test('carries the live composer draft into the thread that re-reads after a Stop', async () => {
    const user = userEvent.setup();
    useAssistantComposerCommandStore.getState().enqueue({
      mode: 'replace',
      text: 'Another thread is mid-sentence.',
      threadId: 'thread-other',
    });

    await renderAssistantThreadPanel(['openai'], 'thread-active');
    await screen.findByTestId('assistant-ui-panel');

    await act(async () => {
      await user.click(screen.getByTestId('report-composer-text'));
    });
    await act(async () => {
      await user.click(screen.getByTestId('trigger-stop-reread'));
    });

    // The draft reaches the remounted thread as its own replace command.
    await waitFor(() =>
      expect(screen.getByTestId('composer-draft-command-text')).toHaveTextContent(
        'Live composer draft'
      )
    );
    expect(screen.getByTestId('composer-draft-command-mode')).toHaveTextContent('replace');

    // Only this thread's queue moved. The harness mounts ONE wrapper per
    // render, so the other thread is asserted through the shared store rather
    // than a second mounted composer.
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']
    ).toHaveLength(1);
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-other']
    ).toHaveLength(1);
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-other']?.[0]?.text
    ).toBe('Another thread is mid-sentence.');

    // Applied once: the wrapper acknowledges it, so a later mount cannot replay it.
    await act(async () => {
      await user.click(screen.getByTestId('apply-composer-draft-command'));
    });
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']
    ).toBeUndefined();
  });

  test('routes local chat through the data-stream transport when the desktop bridges exist', async () => {
    Object.defineProperty(window, 'assistant', {
      configurable: true,
      value: { url: 'http://127.0.0.1:51234' },
    });
    Object.defineProperty(window, 'desktopLifecycle', {
      configurable: true,
      value: { isTestMode: false },
    });
    hasDesktopLlmHostMock.mockReturnValue(true);
    try {
      await renderAssistantPanel(['openai'], () =>
        waitFor(() => {
          expect(screen.getByTestId('local-chat-transport')).toHaveTextContent('data-stream');
          expect(screen.getByTestId('request-body-limit')).toBeEmptyDOMElement();
        })
      );
    } finally {
      Object.defineProperty(window, 'assistant', { configurable: true, value: undefined });
      Reflect.deleteProperty(window, 'desktopLifecycle');
      hasDesktopLlmHostMock.mockReturnValue(false);
    }
  });

  test('enables composer attachments for hosted providers on the in-renderer transport (web gate)', async () => {
    // localChatTransport describes the LOCAL provider's transport and must
    // not gate hosted providers on web — the /api/assistant route shares the
    // desktop server's image-aware conversion (#1685 review fix).
    Reflect.deleteProperty(window, 'assistant');
    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('attachments-availability')).toHaveTextContent(
          '"state":"enabled"'
        );
        expect(screen.getByTestId('request-body-limit')).toHaveTextContent(
          String(HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES)
        );
      })
    );
  });

  test('gates composer attachments on the selected model vision capability', async () => {
    testEnabledModels.add('qwen/qwen3-coder-next');
    try {
      await renderAssistantPanel(['openrouter'], async () => {
        // Auto-selection lands on the first enabled openrouter route, the
        // text-only coder model: visibly disabled with a model-naming reason.
        await waitFor(() => {
          expect(screen.getByTestId('attachments-availability')).toHaveTextContent(
            '"state":"disabled"'
          );
        });
        expect(screen.getByTestId('attachments-availability')).toHaveTextContent(
          'Qwen3 Coder Next (OpenRouter)'
        );

        // Switching to a vision-capable route enables the affordance.
        await userEvent.selectOptions(screen.getByTestId('model-select'), 'openai/gpt-5.2');
        await waitFor(() => {
          expect(screen.getByTestId('attachments-availability')).toHaveTextContent(
            '"state":"enabled"'
          );
        });
      });
    } finally {
      testEnabledModels.delete('qwen/qwen3-coder-next');
    }
  });

  test('keeps the in-renderer local transport for web llm-host test doubles', async () => {
    hasDesktopLlmHostMock.mockReturnValue(true);
    try {
      await renderAssistantPanel(['openai'], () =>
        waitFor(() => {
          expect(screen.getByTestId('local-chat-transport')).toHaveTextContent('local-runtime');
        })
      );
    } finally {
      hasDesktopLlmHostMock.mockReturnValue(false);
    }
  });

  test('keeps the in-renderer local transport without the desktop llm-host bridge', async () => {
    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('local-chat-transport')).toHaveTextContent('local-runtime');
      })
    );
  });

  test('auto-selects first provider and default model when none selected', async () => {
    await renderAssistantPanel(['openai', 'anthropic'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;

          expect(providerSelect.value).toBe('openai');
          expect(modelSelect.value).toBe('gpt-5.2');
          expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
        },
        { timeout: 3000 }
      )
    );
  });

  test('shows disabled reason when no providers available', async () => {
    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
            'Connect an AI provider in Settings → Providers to enable the assistant.'
          );
          expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
        },
        { timeout: 3000 }
      )
    );
  });

  test('shows local runtime unavailable message when a local provider is selected but not configured', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      modelsByProvider: {
        ...state.modelsByProvider,
        ollama: 'nomic-embed-text',
      },
      selectedModel: 'ollama::nomic-embed-text',
      selectedProvider: 'ollama',
    }));

    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
            'The selected local runtime is currently unavailable.'
          );
          expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
        },
        { timeout: 3000 }
      )
    );
  });

  test('reselects a valid local runtime model when the previously selected local model is unavailable', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getLocalRuntimeModels: async () => ({
        lmstudio: {
          availability: {
            checkedAt: 10,
            message: 'not detected',
            state: 'unavailable',
          },
          checkedAt: 10,
          endpoint: 'http://localhost:1234/v1/models',
          freshness: 'live',
          models: [],
          runtime: 'lmstudio',
          source: 'openai_v1_models',
          state: 'loaded_empty',
        },
        ollama: {
          availability: {
            checkedAt: 10,
            endpoint: 'http://127.0.0.1:11434/v1/models',
            latencyMs: 5,
            state: 'available',
          },
          checkedAt: 10,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          freshness: 'live',
          models: [
            {
              capabilities: { embeddings: 'supported', llm: true, vision: 'unknown' },
              capabilitySource: 'inferred',
              dimensionsKnown: { endpoint: '', state: 'known', values: [768], verifiedAt: 10 },
              displayName: 'Nomic Embed Text',
              endpoint: 'http://127.0.0.1:11434/v1/models',
              freshness: 'live',
              modelId: 'nomic-embed-text',
              modelKey: 'ollama::nomic-embed-text',
              providerId: 'ollama',
              runtime: 'ollama',
              source: 'openai_v1_models',
            },
          ],
          runtime: 'ollama',
          source: 'openai_v1_models',
          state: 'loaded_non_empty',
        },
      }),
      getLocalRuntimeStatuses: async () => ({
        lmstudio: {
          checkedAt: 10,
          message: 'not detected',
          state: 'unavailable',
        },
        ollama: {
          checkedAt: 10,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          latencyMs: 5,
          state: 'available',
        },
      }),
      modelsByProvider: {
        ...state.modelsByProvider,
        ollama: 'retired-model',
      },
      selectedModel: 'ollama::retired-model',
      selectedProvider: 'ollama',
    }));

    await renderAssistantPanel(['ollama'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;

          expect(providerSelect.value).toBe('ollama');
          expect(modelSelect.value).toBe('nomic-embed-text');
        },
        { timeout: 3000 }
      )
    );

    const state = useAssistantPreferencesStore.getState();
    expect(state.getSelectedModel()).toBe('ollama::nomic-embed-text');
  });

  test('includes local runtime detection hint when no providers are configured', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getLocalRuntimeModels: async () => ({
        lmstudio: {
          availability: {
            checkedAt: 20,
            endpoint: 'http://localhost:1234/v1/models',
            lastSuccessfulAt: 19,
            reason: 'unavailable',
            state: 'stale',
          },
          checkedAt: 20,
          endpoint: 'http://localhost:1234/v1/models',
          freshness: 'live',
          models: [],
          runtime: 'lmstudio',
          source: 'openai_v1_models',
          state: 'loaded_empty',
        },
        ollama: {
          availability: {
            checkedAt: 20,
            endpoint: 'http://127.0.0.1:11434/v1/models',
            latencyMs: 7,
            state: 'available',
          },
          checkedAt: 20,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          freshness: 'live',
          models: [
            {
              capabilities: { embeddings: 'unsupported', llm: true, vision: 'unknown' },
              capabilitySource: 'inferred',
              dimensionsKnown: { state: 'not_applicable' },
              displayName: 'Qwen3',
              endpoint: 'http://127.0.0.1:11434/v1/models',
              freshness: 'live',
              modelId: 'qwen3',
              modelKey: 'ollama::qwen3',
              providerId: 'ollama',
              runtime: 'ollama',
              source: 'openai_v1_models',
            },
            {
              capabilities: { embeddings: 'supported', llm: false, vision: 'unknown' },
              capabilitySource: 'inferred',
              dimensionsKnown: { endpoint: '', state: 'known', values: [768], verifiedAt: 20 },
              displayName: 'Nomic Embed Text',
              endpoint: 'http://127.0.0.1:11434/v1/models',
              freshness: 'live',
              modelId: 'nomic-embed-text',
              modelKey: 'ollama::nomic-embed-text',
              providerId: 'ollama',
              runtime: 'ollama',
              source: 'openai_v1_models',
            },
          ],
          runtime: 'ollama',
          source: 'openai_v1_models',
          state: 'loaded_non_empty',
        },
      }),
      getLocalRuntimeStatuses: async () => ({
        lmstudio: {
          checkedAt: 20,
          endpoint: 'http://localhost:1234/v1/models',
          lastSuccessfulAt: 19,
          reason: 'unavailable',
          state: 'stale',
        },
        ollama: {
          checkedAt: 20,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          latencyMs: 7,
          state: 'available',
        },
      }),
    }));

    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
            'Detected local runtime: Ollama (2 models) + LM Studio (no models) on localhost.'
          );
        },
        { timeout: 3000 }
      )
    );
  });

  test('includes blocked web policy hint when runtime localhost probing is blocked', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getLocalRuntimeModels: async () => ({
        lmstudio: {
          availability: {
            checkedAt: 30,
            message: 'not detected',
            state: 'unavailable',
          },
          checkedAt: 30,
          message: 'not detected',
          runtime: 'lmstudio',
          state: 'failed',
        },
        ollama: {
          availability: {
            checkedAt: 30,
            message: 'Failed to fetch',
            state: 'blocked_web',
          },
          checkedAt: 30,
          message: 'probe blocked',
          runtime: 'ollama',
          state: 'failed',
        },
      }),
      getLocalRuntimeStatuses: async () => ({
        lmstudio: {
          checkedAt: 30,
          message: 'not detected',
          state: 'unavailable',
        },
        ollama: {
          checkedAt: 30,
          message: 'Failed to fetch',
          state: 'blocked_web',
        },
      }),
    }));

    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
            'Ollama probe was blocked by browser networking policy.'
          );
        },
        { timeout: 3000 }
      )
    );
  });

  test('allows changing provider and auto-selects default model', async () => {
    const user = userEvent.setup();

    await renderAssistantPanel(['openai', 'anthropic'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openai');
        },
        { timeout: 3000 }
      )
    );

    // Change provider to anthropic
    const providerSelect = screen.getByTestId('provider-select');
    await user.selectOptions(providerSelect, 'anthropic');

    // Wait for model to update and panel to remain enabled
    await waitFor(() => {
      const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
      expect(modelSelect.value).toBe('claude-sonnet-4-6');
      expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
    });
  });

  test('allows changing model for selected provider', async () => {
    const user = userEvent.setup();

    // Enable an additional model for testing model switching (via DB mock)
    testEnabledModels.add('anthropic/claude-sonnet-4.6');

    await renderAssistantPanel(['openrouter'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openrouter');
        },
        { timeout: 3000 }
      )
    );

    // Change model
    const modelSelect = screen.getByTestId('model-select');
    await user.selectOptions(modelSelect, 'anthropic/claude-sonnet-4.6');

    // Verify model changed in store
    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.getSelectedProvider()).toBe('openrouter');
      expect(state.getSelectedModel()).toBe('openrouter::anthropic/claude-sonnet-4.6');
      expect(state.modelsByProvider['openrouter']).toBe('anthropic/claude-sonnet-4.6');
    });
  });

  test('preserves selected provider across re-renders', async () => {
    const renderResult = await renderAssistantPanel(['openai', 'anthropic', 'google'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openai');
        },
        { timeout: 3000 }
      )
    );
    const { rerender } = renderResult;

    // Manually select a different provider
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'google');

    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');
    });

    // Re-render component
    await act(async () => {
      rerender(
        <AssistantProviderSourceProvider
          source={{
            kind: 'authoritative',
            providers: ['openai', 'anthropic', 'google'],
          }}
        >
          <AssistantUiPanelWrapper loadLocalLlmBackend={loadTestLocalLlmBackend} />
        </AssistantProviderSourceProvider>
      );
    });

    // Selection should persist - wait for re-render to complete
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');
    });
  });

  test('starts with first provider when initially loaded', async () => {
    // Start with a single provider
    await renderAssistantPanel(['anthropic'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('anthropic');

          const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
          expect(modelSelect.value).toBe('claude-sonnet-4-6');

          expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
        },
        { timeout: 3000 }
      )
    );
  });

  test('model selector is disabled when no provider selected', async () => {
    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
          expect(modelSelect).toBeDisabled();
        },
        { timeout: 3000 }
      )
    );
  });

  test('shows correct models for each provider', async () => {
    await renderAssistantPanel(['openai', 'anthropic', 'google'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openai');
        },
        { timeout: 3000 }
      )
    );

    // Check OpenAI default model is available (only models with default: true are enabled)
    const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
    const options = Array.from(modelSelect.options).map((o) => o.value);
    expect(options).toContain('gpt-5.2'); // default model for openai

    // Switch to Google
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'google');

    // Wait for provider switch and model update to complete
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');

      const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
      const options = Array.from(modelSelect.options).map((o) => o.value);
      expect(options).toContain('gemini-3.5-flash'); // default model for google
      expect(options).not.toContain('gpt-5.2'); // openai model shouldn't be here
    });
  });

  test('persists provider and model selections in store', async () => {
    // Enable an additional model for testing model switching (via DB mock)
    testEnabledModels.add('anthropic/claude-sonnet-4.6');

    await renderAssistantPanel(['openai', 'openrouter'], () =>
      waitFor(() => {
        const state = useAssistantPreferencesStore.getState();
        expect(state.getSelectedProvider()).toBe('openai');
        expect(state.modelsByProvider['openai']).toBe('gpt-5.2');
      })
    );

    // Change provider
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'openrouter');

    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.getSelectedProvider()).toBe('openrouter');
      expect(state.modelsByProvider['openrouter']).toBe('openai/gpt-5.2');
    });

    // Change model (to the model we enabled above)
    await user.selectOptions(screen.getByTestId('model-select'), 'anthropic/claude-sonnet-4.6');

    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.modelsByProvider['openrouter']).toBe('anthropic/claude-sonnet-4.6');
    });
  });

  test('disabling the active model calls toggleModel with correct args', async () => {
    const user = userEvent.setup();
    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect((screen.getByTestId('provider-select') as HTMLSelectElement).value).toBe('openai');
      })
    );

    const initialCompositeModel = useAssistantPreferencesStore.getState().getSelectedModel();
    if (!initialCompositeModel) {
      throw new Error('expected initial model');
    }

    // Extract just the model name from composite key (format: "provider::model")
    const initialModelName = initialCompositeModel.split('::')[1];
    if (!initialModelName) {
      throw new Error('expected model name in composite key');
    }

    const toggle = screen.getByTestId(
      `model-toggle-openai-${initialModelName}`
    ) as HTMLInputElement;

    // Verify toggle is checked before clicking
    expect(toggle.checked).toBe(true);

    await user.click(toggle);

    // Verify the model was removed from the test enabled set (DB mock)
    expect(testEnabledModels.has(initialModelName)).toBe(false);
  });

  test('loads MCP tools on mount', async () => {
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockResolvedValue({
        'mcp-server': [
          {
            description: 'Test tool',
            enabled: true,
            id: 'mcp.tool',
          },
        ],
      }),
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('tool-menu-item-mcp.tool')).toBeInTheDocument();
      })
    );

    expect(mcpApi.listTools).toHaveBeenCalled();
    expect(screen.getByTestId('tool-menu-count')).toHaveTextContent(String(NATIVE_TOOL_COUNT + 1));
  });

  test('handles MCP load failures gracefully', async () => {
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('tool-menu-count')).toHaveTextContent(String(NATIVE_TOOL_COUNT));
      })
    );

    expect(mcpApi.listTools).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('tool-menu-loading')).toHaveTextContent('false');
    });
  });

  test('refreshes MCP tools when requested', async () => {
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockResolvedValue({
        'mcp-server': [
          {
            enabled: true,
            id: 'mcp.tool',
          },
        ],
      }),
    });
    const user = userEvent.setup();

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('tool-menu-item-mcp.tool')).toBeInTheDocument();
      })
    );

    await user.click(screen.getByTestId('tool-menu-refresh'));

    await waitFor(() => {
      expect(mcpApi.listTools).toHaveBeenCalledTimes(2);
    });
  });

  test('updates MCP tools when the desktop bridge publishes a tool change event', async () => {
    let handleToolsUpdated: ((tools: Record<string, McpToolDescriptor[]>) => void) | undefined;

    setMcpApi({
      listTools: vi.fn().mockResolvedValue({}),
      onToolsUpdated: vi.fn().mockImplementation((callback) => {
        handleToolsUpdated = callback;
        return () => undefined;
      }),
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('tool-menu-count')).toHaveTextContent(String(NATIVE_TOOL_COUNT));
      })
    );

    expect(handleToolsUpdated).toBeTypeOf('function');

    handleToolsUpdated?.({
      filesystem: [
        {
          description: 'List directory contents',
          enabled: true,
          id: 'filesystem.list_directory',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('tool-menu-item-filesystem.list_directory')).toBeInTheDocument();
    });
    expect(screen.getByTestId('tool-menu-count')).toHaveTextContent(String(NATIVE_TOOL_COUNT + 1));
  });

  test('toggles MCP tools via IPC and reloads', async () => {
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockResolvedValue({
        'mcp-server': [
          {
            enabled: false,
            id: 'mcp.tool',
          },
        ],
      }),
    });
    const user = userEvent.setup();

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('tool-menu-item-mcp.tool')).toBeInTheDocument();
      })
    );

    await user.click(screen.getByTestId('tool-toggle-mcp.tool'));

    await waitFor(() => {
      expect(mcpApi.enableTools).toHaveBeenCalledWith(['mcp.tool']);
    });

    await waitFor(() => {
      expect(mcpApi.listTools).toHaveBeenCalledTimes(2);
    });
  });

  test('applies root-tree selection updates with default add mode and unsubscribes on unmount', async () => {
    let handler: SelectionUpdateHandler | undefined;
    const unsubscribe = vi.fn();
    (
      window as typeof window & {
        tools?: { onRootTreeSelectionUpdate: (cb: SelectionUpdateHandler) => () => void };
      }
    ).tools = {
      onRootTreeSelectionUpdate: (cb) => {
        handler = cb as SelectionUpdateHandler;
        return unsubscribe;
      },
    };

    const { unmount } = await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    act(() => {
      handler?.({
        filePaths: ['alpha.ts', '/beta.ts', 'alpha.ts'],
        folderId: 'test-folder',
      });
    });

    expect(fileExplorerMocks.addMultipleSelectedFiles).toHaveBeenCalledWith('test-folder', [
      '/alpha.ts',
      '/beta.ts',
    ]);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('applies preview-context selection updates in remove mode', async () => {
    let handler: SelectionUpdateHandler | undefined;
    (
      window as typeof window & {
        tools?: { onPreviewContextSelectionUpdate: (cb: SelectionUpdateHandler) => () => void };
      }
    ).tools = {
      onPreviewContextSelectionUpdate: (cb) => {
        handler = cb as SelectionUpdateHandler;
        return vi.fn();
      },
    };

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    act(() => {
      handler?.({
        filePaths: ['/remove-me.ts'],
        folderId: 'test-folder',
        mode: 'remove',
      });
    });

    expect(fileExplorerMocks.removeMultipleSelectedFiles).toHaveBeenCalledWith('test-folder', [
      '/remove-me.ts',
    ]);
  });

  test('applies workspace-context selection updates from native tools', async () => {
    let handler: SelectionUpdateHandler | undefined;
    (
      window as typeof window & {
        tools?: { onWorkspaceContextSelectionUpdate: (cb: SelectionUpdateHandler) => () => void };
      }
    ).tools = {
      onWorkspaceContextSelectionUpdate: (cb) => {
        handler = cb as SelectionUpdateHandler;
        return vi.fn();
      },
    };

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    act(() => {
      handler?.({
        filePaths: ['/curated.ts'],
        folderId: 'test-folder',
        mode: 'add',
      });
    });

    expect(fileExplorerMocks.addMultipleSelectedFiles).toHaveBeenCalledWith('test-folder', [
      '/curated.ts',
    ]);
  });

  test('applies workspace-context tapestry updates from native tools', async () => {
    let handler:
      | ((payload: {
          folderId: string;
          mode: 'replace' | 'add';
          updates: Array<{
            path: string;
            ranges: Array<{ startLine: number; endLine: number; isActive?: boolean }>;
          }>;
        }) => void)
      | undefined;
    (
      window as typeof window & {
        tools?: {
          onWorkspaceContextTapestryUpdate: (cb: NonNullable<typeof handler>) => () => void;
        };
      }
    ).tools = {
      onWorkspaceContextTapestryUpdate: (cb) => {
        handler = cb;
        return vi.fn();
      },
    };

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    act(() => {
      handler?.({
        folderId: 'test-folder',
        mode: 'replace',
        updates: [
          {
            path: '/curated.ts',
            ranges: [{ endLine: 12, isActive: true, startLine: 4 }],
          },
        ],
      });
    });

    expect(fileExplorerMocks.setTapestryRangesForKey).toHaveBeenCalledTimes(1);
    expect(fileExplorerMocks.setTapestryRangesForKey.mock.calls[0]?.[0]).toBe(
      encodeFileSelection('test-folder', '/curated.ts')
    );
    expect(fileExplorerMocks.setTapestryRangesForKey.mock.calls[0]?.[1]).toMatchObject([
      {
        endLine: 12,
        isActive: true,
        startLine: 3,
        userModified: true,
      },
    ]);
  });

  test('adds workspace-context tapestry updates against the current store snapshot', async () => {
    let handler:
      | ((payload: {
          folderId: string;
          mode: 'add';
          updates: Array<{
            path: string;
            ranges: Array<{ startLine: number; endLine: number; isActive?: boolean }>;
          }>;
        }) => void)
      | undefined;
    (
      window as typeof window & {
        tools?: {
          onWorkspaceContextTapestryUpdate: (cb: NonNullable<typeof handler>) => () => void;
        };
      }
    ).tools = {
      onWorkspaceContextTapestryUpdate: (cb) => {
        handler = cb;
        return vi.fn();
      },
    };

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    const compositeKey = encodeFileSelection('test-folder', '/curated.ts');
    fileExplorerMocks.tapestryRangesByKey = {
      [compositeKey]: [{ endLine: 2, isActive: true, startLine: 0 }],
    };

    act(() => {
      handler?.({
        folderId: 'test-folder',
        mode: 'add',
        updates: [
          {
            path: '/curated.ts',
            ranges: [{ endLine: 12, isActive: true, startLine: 4 }],
          },
        ],
      });
    });

    expect(fileExplorerMocks.setTapestryRangesForKey).toHaveBeenCalledWith(
      compositeKey,
      expect.arrayContaining([
        expect.objectContaining({ endLine: 2, startLine: 0 }),
        expect.objectContaining({ endLine: 12, startLine: 3 }),
      ])
    );
  });

  test('replace mode preserves other-folder selections and bad keys', async () => {
    let handler: SelectionUpdateHandler | undefined;
    (
      window as typeof window & {
        tools?: { onRootTreeSelectionUpdate: (cb: SelectionUpdateHandler) => () => void };
      }
    ).tools = {
      onRootTreeSelectionUpdate: (cb) => {
        handler = cb as SelectionUpdateHandler;
        return vi.fn();
      },
    };
    fileExplorerMocks.effectiveSelection = new Set<string>([
      encodeFileSelection('other-folder', '/keep.ts'),
      encodeFileSelection('test-folder', '/drop.ts'),
      'bad-selection-key',
    ]);

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    act(() => {
      handler?.({
        filePaths: ['new-file.ts', '/new-file.ts'],
        folderId: 'test-folder',
        mode: 'replace',
      });
    });

    expect(fileExplorerMocks.resetSelectionToExplicit).toHaveBeenCalledTimes(1);
    expect(fileExplorerMocks.setSelectedFiles).toHaveBeenCalledTimes(1);
    const nextSelection = fileExplorerMocks.setSelectedFiles.mock.calls[0]?.[0] as
      | Set<string>
      | undefined;
    expect(nextSelection).toBeDefined();
    expect(nextSelection?.has(encodeFileSelection('other-folder', '/keep.ts'))).toBe(true);
    expect(nextSelection?.has('bad-selection-key')).toBe(true);
    expect(nextSelection?.has(encodeFileSelection('test-folder', '/new-file.ts'))).toBe(true);
    expect(nextSelection?.has(encodeFileSelection('test-folder', '/drop.ts'))).toBe(false);
  });

  test('ignores invalid selection update payloads', async () => {
    let handler: SelectionUpdateHandler | undefined;
    (
      window as typeof window & {
        tools?: { onRootTreeSelectionUpdate: (cb: SelectionUpdateHandler) => () => void };
      }
    ).tools = {
      onRootTreeSelectionUpdate: (cb) => {
        handler = cb as SelectionUpdateHandler;
        return vi.fn();
      },
    };

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    act(() => {
      handler?.({
        filePaths: [],
        folderId: '',
      });
    });

    expect(fileExplorerMocks.addMultipleSelectedFiles).not.toHaveBeenCalled();
    expect(fileExplorerMocks.removeMultipleSelectedFiles).not.toHaveBeenCalled();
    expect(fileExplorerMocks.setSelectedFiles).not.toHaveBeenCalled();
  });

  test('keeps selected files as tool hints without sending hidden context controls', async () => {
    useWorkspaceCollectionSyncStatusStore.setState({
      blockedReason: 'missing-provider-key',
      lastError: 'OpenAI key is required for Workspace Index.',
      queueProgress: {
        failed: 1,
        lastError: 'provider key unavailable',
        lastEvent: null,
        pending: 3,
        processed: 7,
        totalQueued: 11,
      },
      state: 'blocked',
    });
    fileExplorerMocks.effectiveSelection = new Set<string>([
      encodeFileSelection('test-folder', '/alpha.ts'),
      encodeFileSelection('test-folder', '/beta.ts'),
    ]);
    fileExplorerMocks.includeProjectTree = true;
    fileExplorerMocks.tokenCache = {
      cacheVersion: 1,
      getTokenCount: (_folderId: string, path: string) => {
        if (path === '/alpha.ts') {
          return 40;
        }
        if (path === '/beta.ts') {
          return 60;
        }
        return 0;
      },
    };
    fileExplorerMocks.workspaceContextSnapshot = {
      files: [
        {
          approxTokens: 200,
          outputApproxTokens: 60,
          path: '/alpha.ts',
          ranges: [{ endLine: 12, isActive: true, startLine: 4 }],
        },
      ],
      includeProjectTree: false,
      projectTreeApproxTokens: 1200,
      projectTreeTokenCountLoading: false,
      selectedOutputApproxTokens: 180,
      selectedSourceApproxTokens: 320,
      tokenBudget: 8192,
    };
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('token_count')) {
        return {
          rows: [
            { path: '/alpha.ts', tokenCount: 200 },
            { path: '/beta.ts', tokenCount: 120 },
          ],
        };
      }
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ count: '5' }] };
      }
      return { rows: [] };
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        const contextMenu = readPanelContextMenu();
        expect(requestData['selectionFilePaths']).toEqual(['/alpha.ts', '/beta.ts']);
        expect(requestData['selectionFolderId']).toBe('test-folder');
        expect(requestData['workspaceRootPath']).toBe('/tmp/test-workspace');
        expect(requestData['workspaceIndexEmbeddingSetId']).toBe('managed-set-1');
        expect(requestData['workspaceIndexingEnabled']).toBe(true);
        expect(requestData['workspaceIndexingMode']).toBe('root-folder-cache');
        expect(requestData['workspaceIndexingPaused']).toBe(false);
        expect(requestData['workspaceIndexStatusState']).toBe('blocked');
        expect(requestData['workspaceIndexBlockedReason']).toBe('missing-provider-key');
        expect(requestData['workspaceIndexLastError']).toBe(
          'OpenAI key is required for Workspace Index.'
        );
        expect(requestData['workspaceIndexQueueProgress']).toEqual({
          failed: 1,
          lastError: 'provider key unavailable',
          pending: 3,
          processed: 7,
          totalQueued: 11,
        });
        expect(requestData['workspaceContext']).toEqual(fileExplorerMocks.workspaceContextSnapshot);
        expect(requestData['embeddingSetId']).toBeUndefined();
        expect(requestData['tokenBudget']).toBeUndefined();
        expect(requestData['contextTokenCount']).toBeUndefined();
        expect(requestData['includeFileReport']).toBeUndefined();
        expect(requestData['includeProjectTree']).toBeUndefined();
        expect(contextMenu).toEqual({});
      })
    );
  });

  test('omits stale workspace context snapshots from another selection root', async () => {
    fileExplorerMocks.effectiveSelection = new Set<string>([
      encodeFileSelection('test-folder', '/alpha.ts'),
    ]);
    fileExplorerMocks.workspaceContextSnapshot = {
      files: [
        {
          approxTokens: 200,
          outputApproxTokens: 60,
          path: '/alpha.ts',
          ranges: [{ endLine: 12, isActive: true, startLine: 4 }],
        },
      ],
      includeProjectTree: false,
      projectTreeApproxTokens: 1200,
      projectTreeTokenCountLoading: false,
      selectedOutputApproxTokens: 60,
      selectedSourceApproxTokens: 320,
      selectionFolderId: 'other-folder',
      tokenBudget: 8192,
    };

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['selectionFolderId']).toBe('test-folder');
        expect(requestData['workspaceContext']).toBeUndefined();
      })
    );
  });

  test('passes enabled native tool ids to hosted assistant requests', async () => {
    const user = userEvent.setup();

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(
          screen.getByTestId('tool-menu-item-brainstrike.readWorkspaceFile')
        ).toBeInTheDocument();
      });
    });

    await user.click(screen.getByTestId('tool-toggle-brainstrike.readWorkspaceFile'));

    await waitFor(() => {
      const enabledNativeToolIds = readPanelRequestData()['enabledNativeToolIds'];
      expect(enabledNativeToolIds).toEqual(
        WEB_NATIVE_TOOL_IDS.filter((toolId) => toolId !== 'brainstrike.readWorkspaceFile')
      );
      expect(enabledNativeToolIds).not.toContain('brainstrike.inspectCommandSessions');
      expect(enabledNativeToolIds).not.toContain('brainstrike.manageCommandSession');
      expect(enabledNativeToolIds).not.toContain('skill');
      expect(enabledNativeToolIds).not.toContain('skill_read');
      expect(enabledNativeToolIds).not.toContain('skill_search');
    });
  });

  test('builds model and provider options for openai settings', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          agentInputTokenLimit: 32_000,
          agentMaxSteps: 18,
          maxOutputTokens: 513.9,
          memoryLastMessages: 12,
          reasoningEffort: 'high',
          reasoningSummary: 'auto',
          workingMemoryEnabled: false,
        },
      },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['agentLoop']).toEqual({
          inputTokenLimit: 32_000,
          maxSteps: 18,
        });
        expect(requestData['modelSettings']).toEqual({ maxOutputTokens: 513 });
        expect(requestData['memory']).toMatchObject({
          memoryOptions: {
            lastMessages: 12,
            workingMemory: {
              enabled: false,
              scope: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY.scope,
            },
          },
        });
        expect(requestData['providerOptions']).toEqual({
          openai: {
            reasoningEffort: 'high',
            reasoningSummary: 'auto',
          },
        });
      })
    );
  });

  test('uses per-thread draft settings instead of global provider settings for requests', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));
    useAssistantThreadStore.getState().setThreadDraftRuntime('thread-existing', {
      model: 'gpt-5.2',
      modelSettings: { maxOutputTokens: 2048 },
      provider: 'openai',
      providerOptions: { openai: { reasoningEffort: 'low' } },
    });

    await renderAssistantThreadPanel(['openai'], 'thread-existing', () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['modelSettings']).toEqual({ maxOutputTokens: 2048 });
        expect(requestData['providerOptions']).toEqual({
          openai: { reasoningEffort: 'low' },
        });
      })
    );
  });

  test('stores provider setting changes as per-thread draft runtime', async () => {
    const user = userEvent.setup();
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    await renderAssistantThreadPanel(['openai'], 'thread-existing', async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('provider-settings-change-openai'));
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']).toEqual(
      expect.objectContaining({
        model: 'gpt-5.2',
        modelSettings: { maxOutputTokens: 2048 },
        provider: 'openai',
        providerOptions: { openai: { reasoningEffort: 'low', reasoningSummary: 'auto' } },
      })
    );
    expect(useAssistantPreferencesStore.getState().providerSettings['openai']).toEqual(
      expect.objectContaining({
        maxOutputTokens: 512,
        reasoningEffort: 'high',
      })
    );
  });

  test('removes per-thread draft provider settings when a control is toggled off', async () => {
    const user = userEvent.setup();
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          agentMaxSteps: 8,
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    await renderAssistantThreadPanel(['openai'], 'thread-existing', async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('provider-settings-clear-openai'));
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']).toEqual(
      expect.objectContaining({
        model: 'gpt-5.2',
        provider: 'openai',
      })
    );
    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']
        ?.providerSettings?.['openai']
    ).toEqual({});
    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']?.modelSettings
    ).toBeUndefined();
    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']?.providerOptions
    ).toBeUndefined();
  });

  test('stores provider setting changes globally when no thread prop is mounted', async () => {
    const user = userEvent.setup();
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('provider-settings-change-openai'));
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId).toEqual({});
    expect(useAssistantPreferencesStore.getState().providerSettings['openai']).toEqual(
      expect.objectContaining({
        maxOutputTokens: 2048,
        reasoningEffort: 'low',
      })
    );
  });

  test('stores model changes per thread and remembers them as the next thread default', async () => {
    const user = userEvent.setup();
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    await renderAssistantThreadPanel(['openai', 'anthropic'], 'thread-existing', async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByTestId('provider-select'), 'anthropic');
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']).toEqual({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
    expect(useAssistantPreferencesStore.getState().selectedModel).toContain('anthropic::');
  });

  test('does not expose assistant runtime test hooks outside desktop E2E mode', async () => {
    (window as typeof window & { desktopLifecycle?: { isTestMode?: boolean } }).desktopLifecycle = {
      isTestMode: false,
    };

    await renderAssistantThreadPanel(['openai'], 'thread-existing', () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    expect(window.__brainstrikeAssistantRuntimeTestHooks__).toBeUndefined();
  });

  test('registers assistant runtime test hooks only during desktop E2E mode', async () => {
    (window as typeof window & { desktopLifecycle?: { isTestMode?: boolean } }).desktopLifecycle = {
      isTestMode: true,
    };
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    const { unmount } = await renderAssistantThreadPanel(
      ['openai', 'anthropic'],
      'thread-existing',
      () =>
        waitFor(() => {
          expect(window.__brainstrikeAssistantRuntimeTestHooks__).toBeDefined();
        })
    );

    act(() => {
      window.__brainstrikeAssistantRuntimeTestHooks__?.setCurrentThreadModel(
        'anthropic::claude-sonnet-4-6'
      );
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']).toEqual({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
    expect(useAssistantPreferencesStore.getState().selectedModel).toBe(
      'anthropic::claude-sonnet-4-6'
    );

    unmount();
    expect(window.__brainstrikeAssistantRuntimeTestHooks__).toBeUndefined();
  });

  test('includes workspace-scoped Mastra memory context in assistant requests', async () => {
    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['memory']).toMatchObject({
          memoryOptions: {
            lastMessages: 40,
            workingMemory: { enabled: true, scope: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY.scope },
          },
          resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
          threadId: 'thread-existing',
        });
      })
    );
  });

  test('can disable Mastra message history through provider settings', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          memoryLastMessages: 0,
        },
      },
    }));

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['memory']).toMatchObject({
          memoryOptions: {
            lastMessages: false,
            workingMemory: { enabled: true, scope: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY.scope },
          },
        });
      })
    );
  });

  test('disables hosted memory requests when the runtime has no Mastra memory backend', async () => {
    Reflect.deleteProperty(window, 'assistant');

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['memory']).toBeUndefined();
        expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
        expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
          'Assistant memory for hosted providers requires the desktop assistant backend.'
        );
      })
    );
  });

  test('blocks unsupported persisted semantic recall embedding providers before assistant requests run', async () => {
    useAssistantMemoryPreferencesStore.setState({
      semanticRecall: {
        embeddingModelTarget: 'cohere/embed-english-v3.0',
        enabled: true,
        messageRange: 2,
        scope: 'resource',
        topK: 5,
      },
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
        expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
          'Semantic recall requires an OpenAI, Google, or built-in local embedding model. Reconfigure Assistant Memory settings.'
        );
      })
    );
  });

  test('passes assistant memory preferences into Mastra runtime requests', async () => {
    useAssistantMemoryPreferencesStore.setState({
      observationalMemory: {
        enabled: true,
        messageTokens: 18_000,
        modelTarget: 'anthropic/claude-haiku-4-5',
        observationTokens: 36_000,
        retrievalMode: 'messages',
        scope: 'resource',
      },
      semanticRecall: {
        embeddingModelTarget: 'openai/text-embedding-3-small',
        enabled: false,
        messageRange: 2,
        scope: 'resource',
        topK: 5,
      },
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['memory']).toMatchObject({
          memorySettings: {
            observationalMemory: {
              enabled: true,
              messageTokens: 18_000,
              modelTarget: 'anthropic/claude-haiku-4-5',
              observationTokens: 36_000,
              retrievalMode: 'messages',
              scope: 'resource',
            },
            semanticRecall: {
              embeddingModelTarget: 'openai/text-embedding-3-small',
              enabled: false,
              messageRange: 2,
              scope: 'resource',
              topK: 5,
            },
          },
        });
      })
    );
  });

  test('does not rewrite Mastra thread metadata just by selecting a thread', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
    });
    expect(
      mockDb.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE mastra_threads'))
    ).toBe(false);
  });

  test('creates immutable run records and attaches run IDs to prepared requests', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-00000000000d');
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    await waitFor(() => {
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO brainstrike_assistant_thread_runs'),
        expect.arrayContaining([
          'run-00000000-0000-4000-8000-00000000000d',
          WORKSPACE_MEMORY_RESOURCE_ID,
          'thread-existing',
          'openai',
          'gpt-5.2',
          JSON.stringify({ maxOutputTokens: 512 }),
          JSON.stringify({ openai: { reasoningEffort: 'high', reasoningSummary: 'auto' } }),
          'hosted',
          'running',
        ])
      );
    });
    expect(
      mockDb.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE mastra_threads'))
    ).toBe(false);
    expect(preparedRequestDataLog[0]?.['memory']).toMatchObject({
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      runId: 'run-00000000-0000-4000-8000-00000000000d',
      threadId: 'thread-existing',
    });
    const insertCall = mockDb.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO brainstrike_assistant_thread_runs')
    );
    expect(insertCall?.[1]?.[6]).toContain('"reasoningEffort":"high"');
    expect(insertCall?.[1]?.[5]).toContain('"maxOutputTokens":512');
    uuidSpy.mockRestore();
  });

  test('completes prepared run records with terminal statuses', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000012');
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('prepare-thread-request'));
      await user.click(screen.getByTestId('complete-prepared-request-success'));
      await user.click(screen.getByTestId('complete-prepared-request-failure'));
      await user.click(screen.getByTestId('complete-prepared-request-without-run'));
    });

    const updateCalls = mockDb.query.mock.calls.filter(([sql]) =>
      String(sql).includes('UPDATE brainstrike_assistant_thread_runs')
    );
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]?.[1]).toEqual(
      expect.arrayContaining(['run-00000000-0000-4000-8000-000000000012', 'completed', null])
    );
    expect(updateCalls[1]?.[1]).toEqual(
      expect.arrayContaining(['run-00000000-0000-4000-8000-000000000012', 'failed', 'model failed'])
    );
    uuidSpy.mockRestore();
  });

  test('marks assistant foreground activity while a prepared request is running', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000013');
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });

      expect(getAssistantForegroundActivitySnapshot()).toBe(false);
      await user.click(screen.getByTestId('prepare-thread-request'));
      expect(getAssistantForegroundActivitySnapshot()).toBe(true);
      await user.click(screen.getByTestId('complete-prepared-request-success'));
      expect(getAssistantForegroundActivitySnapshot()).toBe(false);
    });

    uuidSpy.mockRestore();
  });

  test('releases assistant foreground activity when unmounted mid-request', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000014');
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    const renderResult = await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('prepare-thread-request'));
      expect(getAssistantForegroundActivitySnapshot()).toBe(true);
    });

    renderResult.unmount();
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
    uuidSpy.mockRestore();
  });

  test('expires assistant foreground activity when a completion callback is lost', () => {
    vi.useFakeTimers();

    try {
      const onExpired = vi.fn();
      const lease = acquireAssistantForegroundActivity({ onExpired });

      expect(getAssistantForegroundActivitySnapshot()).toBe(true);
      // A leaked lease produces no stream activity, so the idle fuse fires.
      act(() => {
        vi.advanceTimersByTime(ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS);
      });
      expect(getAssistantForegroundActivitySnapshot()).toBe(false);
      expect(onExpired).toHaveBeenCalledTimes(1);

      lease.release();
      expect(onExpired).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('stream activity keeps a legitimate long run from being expired', () => {
    vi.useFakeTimers();

    try {
      const onExpired = vi.fn();
      const lease = acquireAssistantForegroundActivity({ onExpired });

      // A 30-minute run that streams chunks stays alive indefinitely.
      act(() => {
        for (let i = 0; i < 30; i++) {
          vi.advanceTimersByTime(60_000);
          lease.renew();
        }
      });
      expect(getAssistantForegroundActivitySnapshot()).toBe(true);
      expect(onExpired).not.toHaveBeenCalled();

      lease.release();
      expect(getAssistantForegroundActivitySnapshot()).toBe(false);
      expect(onExpired).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('creates a fresh run record for each prepared request', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000010')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000011');
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('prepare-thread-request'));
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    const runInsertCalls = mockDb.query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO brainstrike_assistant_thread_runs')
    );

    expect(runInsertCalls).toHaveLength(2);
    expect(runInsertCalls[0]?.[1]).toEqual(
      expect.arrayContaining(['run-00000000-0000-4000-8000-000000000010'])
    );
    expect(runInsertCalls[1]?.[1]).toEqual(
      expect.arrayContaining(['run-00000000-0000-4000-8000-000000000011'])
    );
    expect(preparedRequestDataLog[0]?.['memory']).toMatchObject({
      runId: 'run-00000000-0000-4000-8000-000000000010',
    });
    expect(preparedRequestDataLog[1]?.['memory']).toMatchObject({
      runId: 'run-00000000-0000-4000-8000-000000000011',
    });
    uuidSpy.mockRestore();
  });

  test('retries thread run creation after a transient failure', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-00000000000e')
      .mockReturnValueOnce('00000000-0000-4000-8000-00000000000f');
    let runInsertCount = 0;
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM mastra_threads')) {
        return {
          rows: [
            {
              createdAt: new Date('2026-04-22T10:00:00Z'),
              id: 'thread-existing',
              resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
              title: 'Existing thread',
              updatedAt: new Date('2026-04-22T10:00:00Z'),
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO brainstrike_assistant_thread_runs')) {
        runInsertCount += 1;
        if (runInsertCount === 1) {
          throw new Error('temporary run insert failure');
        }
        return {
          rows: [
            {
              completed_at: null,
              created_at: new Date('2026-04-22T10:00:00Z'),
              error: null,
              id: 'run-00000000-0000-4000-8000-00000000000f',
              model: 'gpt-5.2',
              model_settings: null,
              provider: 'openai',
              provider_options: null,
              resource_id: WORKSPACE_MEMORY_RESOURCE_ID,
              runtime_kind: 'hosted',
              started_at: new Date('2026-04-22T10:00:00Z'),
              status: 'running',
              thread_id: 'thread-existing',
              updated_at: new Date('2026-04-22T10:00:00Z'),
            },
          ],
        };
      }
      return { rows: [] };
    });
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      selectedModel: 'openai::gpt-5.2',
      selectedProvider: 'openai',
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('prepare-thread-request'));
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    expect(preparedRequestDataLog[0]).toEqual({ error: 'temporary run insert failure' });
    expect(preparedRequestDataLog[1]?.['memory']).toMatchObject({
      runId: 'run-00000000-0000-4000-8000-00000000000f',
    });
    expect(runInsertCount).toBe(2);
    uuidSpy.mockRestore();
  });

  test('builds provider options for anthropic settings', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, anthropic: 'claude-sonnet-4-6' },
      providerSettings: {
        ...state.providerSettings,
        anthropic: {
          ...state.providerSettings['anthropic'],
          anthropicEffort: 'medium',
          anthropicThinkingBudgetTokens: 422.2,
        },
      },
      selectedModel: 'anthropic::claude-sonnet-4-6',
      selectedProvider: 'anthropic',
    }));
    await renderAssistantPanel(['anthropic'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['providerOptions']).toEqual({
          anthropic: {
            effort: 'medium',
            thinking: {
              budgetTokens: 422,
              type: 'enabled',
            },
          },
        });
      })
    );
  });

  test('drops invalid google thinking level for gemini-3.1-pro-preview and opens tool settings', async () => {
    testEnabledModels.add('gemini-3.1-pro-preview');
    useAssistantPreferencesStore.setState((state) => ({
      modelsByProvider: { ...state.modelsByProvider, google: 'gemini-3.1-pro-preview' },
      providerSettings: {
        ...state.providerSettings,
        google: {
          ...state.providerSettings['google'],
          googleThinkingLevel: 'minimal',
        },
      },
      selectedModel: 'google::gemini-3.1-pro-preview',
      selectedProvider: 'google',
    }));
    usePanelLayoutStore.setState({ activeTab: 'explorer' });
    window.location.hash = '';

    const user = userEvent.setup();
    await renderAssistantPanel(['google'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['providerOptions']).toBeUndefined();
      })
    );

    await user.click(screen.getByTestId('tool-menu-open-settings'));
    expect(usePanelLayoutStore.getState().activeTab).toBe('settings');
    expect(window.location.hash).toBe('#settings/ai-tools');
  });

  test('does not update state after unmount during MCP load', async () => {
    let resolveList: ((value: Record<string, McpToolDescriptor[]>) => void) | undefined;
    const listPromise = new Promise<Record<string, McpToolDescriptor[]>>((resolve) => {
      resolveList = resolve;
    });
    setMcpApi({
      listTools: vi.fn().mockReturnValue(listPromise),
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(
      <AssistantProviderSourceProvider source={{ kind: 'authoritative', providers: ['openai'] }}>
        <AssistantUiPanelWrapper loadLocalLlmBackend={loadTestLocalLlmBackend} />
      </AssistantProviderSourceProvider>
    );

    unmount();

    await act(async () => {
      resolveList?.({
        'mcp-server': [
          {
            enabled: true,
            id: 'mcp.tool',
          },
        ],
      });
      await listPromise;
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
