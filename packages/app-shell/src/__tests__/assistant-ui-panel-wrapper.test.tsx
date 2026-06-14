import './assistant-ui-panel-wrapper-test-support';
import { NATIVE_TOOL_DEFAULTS, type SupportedProvider } from '@brainstrike/assistant-contract';
import {
  useAssistantMemoryPreferencesStore,
  useAssistantPreferencesStore,
  usePanelLayoutStore,
} from '@brainstrike/preferences';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import {
  ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS,
  acquireAssistantForegroundActivity,
  getAssistantForegroundActivitySnapshot,
} from '../assistant-foreground-activity';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '../assistant-memory-resource';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import {
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
} from './assistant-ui-panel-wrapper-test-support';

describe('AssistantUiPanelWrapper', () => {
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
        })
      );
    } finally {
      Object.defineProperty(window, 'assistant', { configurable: true, value: undefined });
      Reflect.deleteProperty(window, 'desktopLifecycle');
      hasDesktopLlmHostMock.mockReturnValue(false);
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
            'Connect an AI provider in Settings → LLM Provider Keys to enable the assistant.'
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
      selectedProvider: 'ollama',
      selectedModel: 'ollama::nomic-embed-text',
      modelsByProvider: {
        ...state.modelsByProvider,
        ollama: 'nomic-embed-text',
      },
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
      selectedProvider: 'ollama',
      selectedModel: 'ollama::retired-model',
      modelsByProvider: {
        ...state.modelsByProvider,
        ollama: 'retired-model',
      },
      getLocalRuntimeStatuses: async () => ({
        ollama: {
          state: 'available',
          checkedAt: 10,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          latencyMs: 5,
        },
        lmstudio: {
          state: 'unavailable',
          checkedAt: 10,
          message: 'not detected',
        },
      }),
      getLocalRuntimeModels: async () => ({
        ollama: {
          state: 'loaded_non_empty',
          runtime: 'ollama',
          checkedAt: 10,
          availability: {
            state: 'available',
            checkedAt: 10,
            endpoint: 'http://127.0.0.1:11434/v1/models',
            latencyMs: 5,
          },
          endpoint: 'http://127.0.0.1:11434/v1/models',
          source: 'openai_v1_models',
          freshness: 'live',
          models: [
            {
              runtime: 'ollama',
              providerId: 'ollama',
              modelId: 'nomic-embed-text',
              modelKey: 'ollama::nomic-embed-text',
              displayName: 'Nomic Embed Text',
              endpoint: 'http://127.0.0.1:11434/v1/models',
              source: 'openai_v1_models',
              freshness: 'live',
              capabilities: { llm: true, embeddings: 'supported' },
              capabilitySource: 'inferred',
              dimensionsKnown: { state: 'known', values: [768], verifiedAt: 10, endpoint: '' },
            },
          ],
        },
        lmstudio: {
          state: 'loaded_empty',
          runtime: 'lmstudio',
          checkedAt: 10,
          availability: {
            state: 'unavailable',
            checkedAt: 10,
            message: 'not detected',
          },
          endpoint: 'http://localhost:1234/v1/models',
          source: 'openai_v1_models',
          freshness: 'live',
          models: [],
        },
      }),
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
      getLocalRuntimeStatuses: async () => ({
        ollama: {
          state: 'available',
          checkedAt: 20,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          latencyMs: 7,
        },
        lmstudio: {
          state: 'stale',
          checkedAt: 20,
          endpoint: 'http://localhost:1234/v1/models',
          lastSuccessfulAt: 19,
          reason: 'unavailable',
        },
      }),
      getLocalRuntimeModels: async () => ({
        ollama: {
          state: 'loaded_non_empty',
          runtime: 'ollama',
          checkedAt: 20,
          availability: {
            state: 'available',
            checkedAt: 20,
            endpoint: 'http://127.0.0.1:11434/v1/models',
            latencyMs: 7,
          },
          endpoint: 'http://127.0.0.1:11434/v1/models',
          source: 'openai_v1_models',
          freshness: 'live',
          models: [
            {
              runtime: 'ollama',
              providerId: 'ollama',
              modelId: 'qwen3',
              modelKey: 'ollama::qwen3',
              displayName: 'Qwen3',
              endpoint: 'http://127.0.0.1:11434/v1/models',
              source: 'openai_v1_models',
              freshness: 'live',
              capabilities: { llm: true, embeddings: 'unsupported' },
              capabilitySource: 'inferred',
              dimensionsKnown: { state: 'not_applicable' },
            },
            {
              runtime: 'ollama',
              providerId: 'ollama',
              modelId: 'nomic-embed-text',
              modelKey: 'ollama::nomic-embed-text',
              displayName: 'Nomic Embed Text',
              endpoint: 'http://127.0.0.1:11434/v1/models',
              source: 'openai_v1_models',
              freshness: 'live',
              capabilities: { llm: false, embeddings: 'supported' },
              capabilitySource: 'inferred',
              dimensionsKnown: { state: 'known', values: [768], verifiedAt: 20, endpoint: '' },
            },
          ],
        },
        lmstudio: {
          state: 'loaded_empty',
          runtime: 'lmstudio',
          checkedAt: 20,
          availability: {
            state: 'stale',
            checkedAt: 20,
            endpoint: 'http://localhost:1234/v1/models',
            lastSuccessfulAt: 19,
            reason: 'unavailable',
          },
          endpoint: 'http://localhost:1234/v1/models',
          source: 'openai_v1_models',
          freshness: 'live',
          models: [],
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
      getLocalRuntimeStatuses: async () => ({
        ollama: {
          state: 'blocked_web',
          checkedAt: 30,
          message: 'Failed to fetch',
        },
        lmstudio: {
          state: 'unavailable',
          checkedAt: 30,
          message: 'not detected',
        },
      }),
      getLocalRuntimeModels: async () => ({
        ollama: {
          state: 'failed',
          runtime: 'ollama',
          checkedAt: 30,
          availability: {
            state: 'blocked_web',
            checkedAt: 30,
            message: 'Failed to fetch',
          },
          message: 'probe blocked',
        },
        lmstudio: {
          state: 'failed',
          runtime: 'lmstudio',
          checkedAt: 30,
          availability: {
            state: 'unavailable',
            checkedAt: 30,
            message: 'not detected',
          },
          message: 'not detected',
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
        <AssistantUiPanelWrapper
          initialProviders={['openai', 'anthropic', 'google']}
          loadLocalLlmBackend={loadTestLocalLlmBackend}
        />
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
            id: 'mcp.tool',
            description: 'Test tool',
            enabled: true,
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
            id: 'mcp.tool',
            enabled: true,
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
          id: 'filesystem.list_directory',
          description: 'List directory contents',
          enabled: true,
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
            id: 'mcp.tool',
            enabled: false,
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
        folderId: 'test-folder',
        filePaths: ['alpha.ts', '/beta.ts', 'alpha.ts'],
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
        folderId: 'test-folder',
        filePaths: ['/remove-me.ts'],
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
        folderId: 'test-folder',
        filePaths: ['/curated.ts'],
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
            ranges: [{ startLine: 4, endLine: 12, isActive: true }],
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
        startLine: 3,
        endLine: 12,
        isActive: true,
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
      [compositeKey]: [{ startLine: 0, endLine: 2, isActive: true }],
    };

    act(() => {
      handler?.({
        folderId: 'test-folder',
        mode: 'add',
        updates: [
          {
            path: '/curated.ts',
            ranges: [{ startLine: 4, endLine: 12, isActive: true }],
          },
        ],
      });
    });

    expect(fileExplorerMocks.setTapestryRangesForKey).toHaveBeenCalledWith(
      compositeKey,
      expect.arrayContaining([
        expect.objectContaining({ startLine: 0, endLine: 2 }),
        expect.objectContaining({ startLine: 3, endLine: 12 }),
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
        folderId: 'test-folder',
        filePaths: ['new-file.ts', '/new-file.ts'],
        mode: 'replace',
      });
    });

    expect(fileExplorerMocks.clearSelectionRules).toHaveBeenCalledTimes(1);
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
        folderId: '',
        filePaths: [],
      });
    });

    expect(fileExplorerMocks.addMultipleSelectedFiles).not.toHaveBeenCalled();
    expect(fileExplorerMocks.removeMultipleSelectedFiles).not.toHaveBeenCalled();
    expect(fileExplorerMocks.setSelectedFiles).not.toHaveBeenCalled();
  });

  test('keeps selected files as tool hints without sending hidden context controls', async () => {
    useWorkspaceCollectionSyncStatusStore.setState({
      state: 'blocked',
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
      tokenBudget: 8192,
      selectedSourceApproxTokens: 320,
      selectedOutputApproxTokens: 180,
      useTapestryRanges: true,
      includeProjectTree: false,
      projectTreeApproxTokens: 1200,
      projectTreeTokenCountLoading: false,
      files: [
        {
          path: '/alpha.ts',
          approxTokens: 200,
          outputApproxTokens: 60,
          ranges: [{ startLine: 4, endLine: 12, isActive: true }],
        },
      ],
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
          pending: 3,
          processed: 7,
          totalQueued: 11,
          lastError: 'provider key unavailable',
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
      selectionFolderId: 'other-folder',
      tokenBudget: 8192,
      selectedSourceApproxTokens: 320,
      selectedOutputApproxTokens: 60,
      useTapestryRanges: true,
      includeProjectTree: false,
      projectTreeApproxTokens: 1200,
      projectTreeTokenCountLoading: false,
      files: [
        {
          path: '/alpha.ts',
          approxTokens: 200,
          outputApproxTokens: 60,
          ranges: [{ startLine: 4, endLine: 12, isActive: true }],
        },
      ],
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
        Object.keys(NATIVE_TOOL_DEFAULTS).filter(
          (toolId) => toolId !== 'brainstrike.readWorkspaceFile'
        )
      );
    });
  });

  test('builds model and provider options for openai settings', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
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
            workingMemory: { enabled: false, scope: 'resource' },
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
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
    }));
    useAssistantThreadStore.getState().setThreadDraftRuntime('thread-existing', {
      provider: 'openai',
      model: 'gpt-5.2',
      modelSettings: { maxOutputTokens: 2048 },
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
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
    }));

    await renderAssistantThreadPanel(['openai'], 'thread-existing', async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('provider-settings-change-openai'));
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']).toEqual(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.2',
        modelSettings: { maxOutputTokens: 2048 },
        providerOptions: { openai: { reasoningEffort: 'low' } },
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
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
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
    }));

    await renderAssistantThreadPanel(['openai'], 'thread-existing', async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('provider-settings-clear-openai'));
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']).toEqual(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.2',
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
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
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

  test('stores model changes as per-thread draft runtime instead of global preferences', async () => {
    const user = userEvent.setup();
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
    }));

    await renderAssistantThreadPanel(['openai', 'anthropic'], 'thread-existing', async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByTestId('provider-select'), 'anthropic');
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(useAssistantPreferencesStore.getState().selectedModel).toBe('openai::gpt-5.2');
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
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
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
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
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
          threadId: 'thread-existing',
          resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
          memoryOptions: {
            lastMessages: 40,
            workingMemory: { enabled: true, scope: 'resource' },
          },
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
            workingMemory: { enabled: true, scope: 'resource' },
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
        enabled: true,
        embeddingModelTarget: 'cohere/embed-english-v3.0',
        scope: 'resource',
        topK: 5,
        messageRange: 2,
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
        modelTarget: 'anthropic/claude-haiku-4-5',
        scope: 'resource',
        messageTokens: 18_000,
        observationTokens: 36_000,
        retrievalMode: 'messages',
      },
      semanticRecall: {
        enabled: false,
        embeddingModelTarget: 'openai/text-embedding-3-small',
        scope: 'resource',
        topK: 5,
        messageRange: 2,
      },
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['memory']).toMatchObject({
          memorySettings: {
            observationalMemory: {
              enabled: true,
              modelTarget: 'anthropic/claude-haiku-4-5',
              scope: 'resource',
              messageTokens: 18_000,
              observationTokens: 36_000,
              retrievalMode: 'messages',
            },
            semanticRecall: {
              enabled: false,
              embeddingModelTarget: 'openai/text-embedding-3-small',
              scope: 'resource',
              topK: 5,
              messageRange: 2,
            },
          },
        });
      })
    );
  });

  test('does not rewrite Mastra thread metadata just by selecting a thread', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
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
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
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
          JSON.stringify({ openai: { reasoningEffort: 'high' } }),
          'hosted',
          'running',
        ])
      );
    });
    expect(
      mockDb.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE mastra_threads'))
    ).toBe(false);
    expect(preparedRequestDataLog[0]?.['memory']).toMatchObject({
      threadId: 'thread-existing',
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      runId: 'run-00000000-0000-4000-8000-00000000000d',
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
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
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
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
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
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
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
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
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
              id: 'thread-existing',
              resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
              title: 'Existing thread',
              createdAt: new Date('2026-04-22T10:00:00Z'),
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
              id: 'run-00000000-0000-4000-8000-00000000000f',
              resource_id: WORKSPACE_MEMORY_RESOURCE_ID,
              thread_id: 'thread-existing',
              provider: 'openai',
              model: 'gpt-5.2',
              model_settings: null,
              provider_options: null,
              runtime_kind: 'hosted',
              status: 'running',
              error: null,
              started_at: new Date('2026-04-22T10:00:00Z'),
              completed_at: null,
              created_at: new Date('2026-04-22T10:00:00Z'),
              updated_at: new Date('2026-04-22T10:00:00Z'),
            },
          ],
        };
      }
      return { rows: [] };
    });
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
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
      selectedProvider: 'anthropic',
      selectedModel: 'anthropic::claude-sonnet-4-6',
      modelsByProvider: { ...state.modelsByProvider, anthropic: 'claude-sonnet-4-6' },
      providerSettings: {
        ...state.providerSettings,
        anthropic: {
          ...state.providerSettings['anthropic'],
          anthropicEffort: 'medium',
          anthropicThinkingBudgetTokens: 422.2,
        },
      },
    }));
    await renderAssistantPanel(['anthropic'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['providerOptions']).toEqual({
          anthropic: {
            effort: 'medium',
            thinking: {
              type: 'enabled',
              budgetTokens: 422,
            },
          },
        });
      })
    );
  });

  test('drops invalid google thinking level for gemini-3.1-pro-preview and opens tool settings', async () => {
    testEnabledModels.add('gemini-3.1-pro-preview');
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'google',
      selectedModel: 'google::gemini-3.1-pro-preview',
      modelsByProvider: { ...state.modelsByProvider, google: 'gemini-3.1-pro-preview' },
      providerSettings: {
        ...state.providerSettings,
        google: {
          ...state.providerSettings['google'],
          googleThinkingLevel: 'minimal',
        },
      },
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
      <AssistantUiPanelWrapper
        initialProviders={['openai'] as SupportedProvider[]}
        loadLocalLlmBackend={loadTestLocalLlmBackend}
      />
    );

    unmount();

    await act(async () => {
      resolveList?.({
        'mcp-server': [
          {
            id: 'mcp.tool',
            enabled: true,
          },
        ],
      });
      await listPromise;
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
