import { fireEvent, render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelPickerModel,
  ModelPickerProvider,
  ProviderGroupConfig,
} from '../../src/assistant-ui-panel/assistant-ui-panel';
import {
  AssistantUiPanel,
  ProviderSettingsPanel,
} from '../../src/assistant-ui-panel/assistant-ui-panel';

const useDataStreamRuntimeMock = vi.fn((_options?: unknown) => ({ runtime: 'test-runtime' }));
const useLocalRuntimeMock = vi.fn((_adapter?: unknown) => ({ runtime: 'local-runtime' }));
const setCollapsedMock = vi.fn();
let capturedLocalAdapterOptions: {
  completeRuntimeData?: (
    runtimeData: Record<string, unknown> | undefined,
    status: 'cancelled' | 'completed' | 'failed',
    error?: string
  ) => Promise<void> | void;
  onLoadingProgress?: (progress: {
    stage: 'downloading' | 'generating' | 'loading' | 'ready';
    progress: number;
    message: string;
    file?: string;
  }) => void;
  prepareRuntimeData?: () => Promise<Record<string, unknown> | undefined>;
} | null = null;

// @assistant-ui/styles v0.3.x consolidated all styles into index.css
vi.mock('@assistant-ui/styles/index.css', () => ({}));
vi.mock('@assistant-ui/react-markdown/styles/dot.css', () => ({}));

vi.mock('@assistant-ui/react-data-stream', () => ({
  useDataStreamRuntime: (options: unknown) => useDataStreamRuntimeMock(options),
}));

vi.mock('../../src/assistant-ui-panel/assistant-message-text', () => ({
  AssistantMessageText: () => <div data-testid="markdown-text" />,
  preloadMarkdownText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/assistant-ui-panel/tool-fallback', () => ({
  ToolFallback: () => <div data-testid="tool-fallback" />,
}));

vi.mock('../../src/assistant-ui-panel/local-runtime-adapter', () => ({
  createLocalModelAdapter: (options: unknown) => {
    capturedLocalAdapterOptions = options as typeof capturedLocalAdapterOptions;
    return { run: vi.fn() };
  },
  disposeLocalBackend: vi.fn().mockResolvedValue(undefined),
}));

// Mock theme provider for ModelPicker
vi.mock('../../src/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));

vi.mock('@assistant-ui/react', () => {
  interface PrimitiveProps {
    asChild?: boolean;
    children?: React.ReactNode;
    [key: string]: unknown;
  }

  const Primitive = ({ children, asChild, ...props }: PrimitiveProps) => {
    const Component = asChild ? 'span' : 'div';
    return <Component {...props}>{children}</Component>;
  };

  interface IfProps {
    children?: React.ReactNode | ((props: Record<string, unknown>) => React.ReactNode);
  }

  const If = ({ children }: IfProps) =>
    typeof children === 'function' ? children({}) : (children ?? null);

  const TextStub = () => <div data-testid="assistant-text" />;

  interface ProviderProps {
    children?: React.ReactNode;
  }

  interface CounterProps {
    children?: React.ReactNode;
  }

  type InputProps = Record<string, unknown>;
  type ButtonPrimitiveProps = PrimitiveProps & {
    disabled?: boolean;
  };

  interface PartsProps {
    components?: {
      Text?: React.ComponentType;
    };
  }

  return {
    ActionBarPrimitive: {
      Root: Primitive,
      Edit: Primitive,
      Copy: Primitive,
      Reload: Primitive,
    },
    AssistantRuntimeProvider: ({ children }: ProviderProps) => <>{children}</>,
    ChainOfThoughtPrimitive: {
      Root: Primitive,
      AccordionTrigger: Primitive,
      Parts: Primitive,
    },
    BranchPickerPrimitive: {
      Root: Primitive,
      Previous: Primitive,
      Next: Primitive,
      Number: ({ children }: CounterProps) => (
        <span data-testid="branch-number">{children ?? '1'}</span>
      ),
      Count: ({ children }: CounterProps) => (
        <span data-testid="branch-count">{children ?? '1'}</span>
      ),
    },
    ComposerPrimitive: {
      Root: Primitive,
      Input: (props: InputProps) => <textarea data-testid="composer-input" {...props} />,
      Send: ({ children, asChild: _asChild, ...props }: ButtonPrimitiveProps) => (
        <button data-testid="composer-send" type="submit" {...props}>
          {children}
        </button>
      ),
      Cancel: ({ children, asChild: _asChild, ...props }: ButtonPrimitiveProps) => (
        <button data-testid="composer-cancel" type="button" {...props}>
          {children}
        </button>
      ),
    },
    MessagePrimitive: {
      Root: Primitive,
      Parts: ({ components }: PartsProps) => {
        const Text = components?.Text ?? TextStub;
        return <Text />;
      },
      If,
    },
    useAui: () => ({
      chainOfThought: () => ({
        setCollapsed: setCollapsedMock,
      }),
    }),
    useAuiState: <T,>(
      selector: (state: {
        chainOfThought: { collapsed: boolean };
        thread: { messages: Array<{ id: string }> };
      }) => T
    ) => selector({ chainOfThought: { collapsed: true }, thread: { messages: [] } }),
    useLocalRuntime: (adapter: unknown) => useLocalRuntimeMock(adapter),
    useMessagePartReasoning: () => ({
      type: 'reasoning' as const,
      text: 'Reasoning text',
      status: { type: 'complete' as const },
    }),
    ThreadPrimitive: {
      Root: Primitive,
      Viewport: Primitive,
      Messages: Primitive,
      If,
    },
  };
});

beforeAll(() => {
  const elementProto = window.HTMLElement.prototype as unknown as {
    hasPointerCapture?: (pointerId: number) => boolean;
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
  };

  if (!elementProto.hasPointerCapture) {
    elementProto.hasPointerCapture = () => false;
  }
  if (!elementProto.setPointerCapture) {
    elementProto.setPointerCapture = () => {};
  }
  if (!elementProto.releasePointerCapture) {
    elementProto.releasePointerCapture = () => {};
  }
});

const providerGroups: ProviderGroupConfig[] = [
  {
    runtime: 'hosted',
    label: 'Cloud',
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        runtime: 'hosted',
        capabilities: {
          llm: true,
          embeddings: false,
          streaming: true,
          supportsStandardEmbeddingDimension: false,
        },
        models: [
          {
            id: 'gpt-5.2',
            label: 'GPT-5.2',
            type: 'llm',
            enabled: true,
            default: true,
            supportsStreaming: true,
          },
        ],
      },
    ],
  },
  {
    runtime: 'gateway',
    label: 'Gateway',
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        runtime: 'gateway',
        capabilities: {
          llm: true,
          embeddings: false,
          streaming: true,
          supportsStandardEmbeddingDimension: false,
        },
        models: [
          {
            id: 'claude-sonnet-4-5',
            label: 'Claude Sonnet 4.5',
            type: 'llm',
            enabled: true,
            supportsStreaming: true,
          },
        ],
      },
    ],
  },
];

// ModelPicker-compatible providers (matching the enabled models in providerGroups)
const pickerProviders: ModelPickerProvider[] = [
  { id: 'openai', name: 'OpenAI', icon: null },
  { id: 'anthropic', name: 'Anthropic', icon: null },
];

// ModelPicker-compatible models (only enabled models)
const pickerModels: ModelPickerModel[] = [
  {
    id: 'gpt-5.2',
    providerId: 'openai',
    name: 'GPT-5.2',
    description: null,
    capabilities: { type: 'llm', streaming: true },
  },
  {
    id: 'claude-sonnet-4-5',
    providerId: 'anthropic',
    name: 'Claude Sonnet 4.5',
    description: null,
    capabilities: { type: 'llm', streaming: true },
  },
];

const baseProps = {
  providerGroups,
  pickerModels,
  pickerProviders,
  selectedProvider: 'openai',
  selectedModel: 'openai::gpt-5.2',
};

describe('AssistantUiPanel model picker', () => {
  beforeEach(() => {
    Object.assign(window, { assistant: undefined });
    capturedLocalAdapterOptions = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('uses the legacy data-stream protocol for hosted providers', () => {
    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    expect(useDataStreamRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        api: '/api/assistant',
        protocol: 'data-stream',
      })
    );
  });

  it('prepares per-run request data when the hosted runtime starts a request', async () => {
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        threadId: 'thread-1',
        resourceId: 'workspace-1',
        runId: 'run-1',
      },
    }));

    render(
      <AssistantUiPanel
        {...baseProps}
        onModelChange={() => {}}
        prepareRequestData={prepareRequestData}
        requestData={{ tokenBudget: 123 }}
      />
    );

    const options = useDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
      body?: () => Promise<Record<string, unknown> | undefined>;
    };

    await expect(options.body?.()).resolves.toEqual({
      data: {
        tokenBudget: 123,
        memory: {
          threadId: 'thread-1',
          resourceId: 'workspace-1',
          runId: 'run-1',
        },
        provider: 'openai',
        model: 'gpt-5.2',
      },
    });
    expect(prepareRequestData).toHaveBeenCalledTimes(1);
  });

  it('completes hosted prepared requests from data stream terminal callbacks', async () => {
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        threadId: 'thread-1',
        resourceId: 'workspace-1',
        runId: 'run-1',
      },
    }));
    const completePreparedRequest = vi.fn();

    render(
      <AssistantUiPanel
        {...baseProps}
        completePreparedRequest={completePreparedRequest}
        onModelChange={() => {}}
        prepareRequestData={prepareRequestData}
      />
    );

    const options = useDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
      body?: () => Promise<Record<string, unknown> | undefined>;
      onCancel?: () => void;
      onError?: (error: Error) => void;
      onFinish?: () => void;
    };

    const preparedBody = await options.body?.();
    options.onFinish?.();
    options.onError?.(new Error('late stream error'));
    options.onCancel?.();

    expect(preparedBody).toMatchObject({
      data: {
        memory: {
          runId: 'run-1',
        },
      },
    });
    expect(completePreparedRequest).toHaveBeenCalledTimes(1);
    expect(completePreparedRequest).toHaveBeenCalledWith(
      {
        memory: {
          threadId: 'thread-1',
          resourceId: 'workspace-1',
          runId: 'run-1',
        },
      },
      'completed',
      undefined
    );
  });

  it('uses the latest hosted completion callback when the panel rerenders mid-run', async () => {
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        threadId: 'thread-1',
        resourceId: 'workspace-1',
        runId: 'run-1',
      },
    }));
    const firstCompletePreparedRequest = vi.fn();
    const secondCompletePreparedRequest = vi.fn();

    const view = render(
      <AssistantUiPanel
        {...baseProps}
        completePreparedRequest={firstCompletePreparedRequest}
        onModelChange={() => {}}
        prepareRequestData={prepareRequestData}
      />
    );

    const options = useDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
      body?: () => Promise<Record<string, unknown> | undefined>;
      onFinish?: () => void;
    };

    await options.body?.();
    view.rerender(
      <AssistantUiPanel
        {...baseProps}
        completePreparedRequest={secondCompletePreparedRequest}
        onModelChange={() => {}}
        prepareRequestData={prepareRequestData}
      />
    );
    options.onFinish?.();

    expect(firstCompletePreparedRequest).not.toHaveBeenCalled();
    expect(secondCompletePreparedRequest).toHaveBeenCalledWith(
      {
        memory: {
          threadId: 'thread-1',
          resourceId: 'workspace-1',
          runId: 'run-1',
        },
      },
      'completed',
      undefined
    );
  });

  it('rejects concurrent hosted prepared requests before creating a second run', async () => {
    const prepareRequestData = vi
      .fn()
      .mockResolvedValueOnce({
        memory: {
          threadId: 'thread-1',
          resourceId: 'workspace-1',
          runId: 'run-1',
        },
      })
      .mockResolvedValueOnce({
        memory: {
          threadId: 'thread-1',
          resourceId: 'workspace-1',
          runId: 'run-2',
        },
      });
    const completePreparedRequest = vi.fn();

    render(
      <AssistantUiPanel
        {...baseProps}
        completePreparedRequest={completePreparedRequest}
        onModelChange={() => {}}
        prepareRequestData={prepareRequestData}
      />
    );

    const options = useDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
      body?: () => Promise<Record<string, unknown> | undefined>;
      onCancel?: () => void;
    };

    await options.body?.();
    await expect(options.body?.()).rejects.toThrow(
      'Cannot start a hosted assistant run while another run is in progress.'
    );
    options.onCancel?.();

    expect(prepareRequestData).toHaveBeenCalledTimes(1);
    expect(completePreparedRequest).toHaveBeenCalledTimes(1);
    expect(completePreparedRequest).toHaveBeenCalledWith(
      {
        memory: {
          threadId: 'thread-1',
          resourceId: 'workspace-1',
          runId: 'run-1',
        },
      },
      'cancelled',
      undefined
    );
  });

  it('marks hosted prepared requests failed when the data stream errors', async () => {
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        threadId: 'thread-1',
        resourceId: 'workspace-1',
        runId: 'run-1',
      },
    }));
    const completePreparedRequest = vi.fn();

    render(
      <AssistantUiPanel
        {...baseProps}
        completePreparedRequest={completePreparedRequest}
        onModelChange={() => {}}
        prepareRequestData={prepareRequestData}
      />
    );

    const options = useDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
      body?: () => Promise<Record<string, unknown> | undefined>;
      onError?: (error: Error) => void;
    };

    await options.body?.();
    options.onError?.(new Error('stream failed'));

    expect(completePreparedRequest).toHaveBeenCalledWith(
      {
        memory: {
          threadId: 'thread-1',
          resourceId: 'workspace-1',
          runId: 'run-1',
        },
      },
      'failed',
      'stream failed'
    );
  });

  it('forwards per-run request preparation and completion to local runtime runs', async () => {
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        threadId: 'thread-local',
        resourceId: 'workspace-local',
        runId: 'run-local',
      },
    }));
    const completePreparedRequest = vi.fn();
    const localGroups: ProviderGroupConfig[] = [
      {
        runtime: 'local',
        label: 'Local',
        providers: [
          {
            id: 'local',
            name: 'Local',
            runtime: 'local',
            capabilities: {
              llm: true,
              embeddings: false,
              streaming: false,
              supportsStandardEmbeddingDimension: false,
            },
            models: [
              {
                id: 'onnx-community/gemma-4-E2B-it-ONNX',
                label: 'Gemma 4 E2B',
                type: 'llm',
                enabled: true,
                default: true,
              },
            ],
          },
        ],
      },
    ];

    render(
      <AssistantUiPanel
        completePreparedRequest={completePreparedRequest}
        onModelChange={() => {}}
        pickerModels={[
          {
            id: 'onnx-community/gemma-4-E2B-it-ONNX',
            providerId: 'local',
            name: 'Gemma 4 E2B',
            description: null,
            capabilities: { type: 'llm', streaming: false },
          },
        ]}
        pickerProviders={[{ id: 'local', name: 'Local', icon: null }]}
        prepareRequestData={prepareRequestData}
        providerGroups={localGroups}
        requestData={{ tokenBudget: 456 }}
        selectedModel="local::onnx-community/gemma-4-E2B-it-ONNX"
        selectedProvider="local"
      />
    );

    await expect(capturedLocalAdapterOptions?.prepareRuntimeData?.()).resolves.toEqual({
      tokenBudget: 456,
      memory: {
        threadId: 'thread-local',
        resourceId: 'workspace-local',
        runId: 'run-local',
      },
    });
    await capturedLocalAdapterOptions?.completeRuntimeData?.(
      { memory: { runId: 'run-local' } },
      'completed'
    );
    expect(prepareRequestData).toHaveBeenCalledTimes(1);
    expect(completePreparedRequest).toHaveBeenCalledWith(
      { memory: { runId: 'run-local' } },
      'completed'
    );
  });

  it('renders compact local model status and auto-hides ready state', () => {
    vi.useFakeTimers();

    const localGroups: ProviderGroupConfig[] = [
      {
        runtime: 'local',
        label: 'Local',
        providers: [
          {
            id: 'local',
            name: 'Local',
            runtime: 'local',
            capabilities: {
              llm: true,
              embeddings: false,
              streaming: false,
              supportsStandardEmbeddingDimension: false,
            },
            models: [
              {
                id: 'onnx-community/gemma-4-E2B-it-ONNX',
                label: 'Gemma 4 E2B',
                type: 'llm',
                enabled: true,
                default: true,
              },
            ],
          },
        ],
      },
    ];

    render(
      <AssistantUiPanel
        onModelChange={() => {}}
        pickerModels={[
          {
            id: 'onnx-community/gemma-4-E2B-it-ONNX',
            providerId: 'local',
            name: 'Gemma 4 E2B',
            description: null,
            capabilities: { type: 'llm', streaming: false },
          },
        ]}
        pickerProviders={[{ id: 'local', name: 'Local', icon: null }]}
        providerGroups={localGroups}
        selectedModel="local::onnx-community/gemma-4-E2B-it-ONNX"
        selectedProvider="local"
      />
    );

    act(() => {
      capturedLocalAdapterOptions?.onLoadingProgress?.({
        stage: 'loading',
        progress: 42,
        message: 'Warming up local model host...',
      });
    });

    expect(screen.getByTestId('local-model-status')).toBeInTheDocument();
    expect(screen.getByText('Gemma')).toBeInTheDocument();
    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.queryByText('Loading model...')).not.toBeInTheDocument();
    expect(screen.queryByText('42%')).not.toBeInTheDocument();

    act(() => {
      capturedLocalAdapterOptions?.onLoadingProgress?.({
        stage: 'ready',
        progress: 100,
        message: 'Local model ready.',
      });
    });

    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(screen.queryByTestId('local-model-status')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('shows the labelled downloading progress bar during local model download', () => {
    const localGroups: ProviderGroupConfig[] = [
      {
        runtime: 'local',
        label: 'Local',
        providers: [
          {
            id: 'local',
            name: 'Local',
            runtime: 'local',
            capabilities: {
              llm: true,
              embeddings: false,
              streaming: false,
              supportsStandardEmbeddingDimension: false,
            },
            models: [
              {
                id: 'onnx-community/gemma-4-E2B-it-ONNX',
                label: 'Gemma 4 E2B',
                type: 'llm',
                enabled: true,
                default: true,
              },
            ],
          },
        ],
      },
    ];

    render(
      <AssistantUiPanel
        onModelChange={() => {}}
        pickerModels={[
          {
            id: 'onnx-community/gemma-4-E2B-it-ONNX',
            providerId: 'local',
            name: 'Gemma 4 E2B',
            description: null,
            capabilities: { type: 'llm', streaming: false },
          },
        ]}
        pickerProviders={[{ id: 'local', name: 'Local', icon: null }]}
        providerGroups={localGroups}
        selectedModel="local::onnx-community/gemma-4-E2B-it-ONNX"
        selectedProvider="local"
      />
    );

    act(() => {
      capturedLocalAdapterOptions?.onLoadingProgress?.({
        stage: 'downloading',
        progress: 33,
        message: 'Downloading model weights...',
        file: 'model.onnx',
      });
    });

    const status = screen.getByTestId('local-model-status');
    expect(status).toBeInTheDocument();
    // Percent only renders for the downloading stage
    expect(within(status).getByText('33%')).toBeInTheDocument();
    // The labelled progress bar covers the new aria-label branch
    const labelled = within(status).getByLabelText('Model downloading progress');
    expect(labelled).toBeInTheDocument();
  });

  it('renders the model picker in the composer controls dock', async () => {
    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    // The selected model appears in the ModelPicker trigger.
    const modelTexts = screen.getAllByText('GPT-5.2');
    expect(modelTexts.length).toBeGreaterThan(0);

    // The dropdown container should be present
    const container = screen.getByTestId('assistant-model-dropdown');
    expect(container).toBeInTheDocument();

    // Verify the ModelPicker trigger (combobox) exists
    const trigger = within(container).getByRole('combobox');
    expect(trigger).toBeInTheDocument();
    expect(screen.queryByText(/OpenAI \/ GPT-5\.2/)).not.toBeInTheDocument();
  });

  it('keeps model and controls inside the composer surface with icon send controls', () => {
    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    const composerInput = screen.getByTestId('composer-input');
    const composerShell = composerInput.closest('.bs-composer-shell');
    expect(composerShell).toBeTruthy();
    expect(
      within(composerShell as HTMLElement).getByTestId('assistant-model-dropdown')
    ).toBeVisible();
    expect(
      within(composerShell as HTMLElement).getByRole('button', { name: 'Send' })
    ).toBeVisible();
    expect(screen.queryByText('Send')).not.toBeInTheDocument();
  });

  it('invokes model change handler with composite key when selecting a model', async () => {
    const onModelChange = vi.fn();

    render(<AssistantUiPanel {...baseProps} onModelChange={onModelChange} />);

    // The ModelPicker uses a button trigger - click to open the popover
    const container = screen.getByTestId('assistant-model-dropdown');
    const trigger = within(container).getByRole('combobox');
    fireEvent.click(trigger);

    // Wait for the popover to open and find the Claude model option
    const option = await screen.findByText('Claude Sonnet 4.5');
    fireEvent.click(option);

    // Should be called with composite key format: "provider::model"
    expect(onModelChange).toHaveBeenCalledWith('anthropic::claude-sonnet-4-5');
  });

  it('shows placeholder when no models are enabled', () => {
    const noModelsGroups: ProviderGroupConfig[] = providerGroups.map((group) => ({
      ...group,
      providers: group.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, enabled: false })),
      })),
    }));

    // Provide empty pickerModels - shows the "no models" state
    render(
      <AssistantUiPanel
        pickerModels={[]}
        pickerProviders={pickerProviders}
        providerGroups={noModelsGroups}
      />
    );

    expect(screen.getByText('No models enabled')).toBeInTheDocument();
    const trigger = screen.getByTestId('assistant-model-dropdown');
    expect(trigger).toBeInTheDocument();
  });

  it('disables the model picker when no models are enabled', () => {
    const noModelsGroups: ProviderGroupConfig[] = providerGroups.map((group) => ({
      ...group,
      providers: group.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, enabled: false })),
      })),
    }));

    // Provide empty pickerModels - the picker should be disabled
    render(
      <AssistantUiPanel
        pickerModels={[]}
        pickerProviders={pickerProviders}
        providerGroups={noModelsGroups}
      />
    );

    expect(screen.getByText('No models enabled')).toBeInTheDocument();
    // The ModelPicker combobox should be disabled when no models available
    const trigger = screen.getByRole('combobox');
    expect(trigger).toBeDisabled();
  });

  it('omits context summary and context controls while keeping tool controls visible', () => {
    render(
      <AssistantUiPanel
        {...baseProps}
        onModelChange={() => {}}
        toolMenu={{
          items: [
            {
              id: 'brainstrike.readWorkspaceFile',
              label: 'Read workspace file',
              enabled: true,
              group: 'Workspace',
              source: 'native',
            },
          ],
          summary: '1 tool enabled',
        }}
      />
    );

    expect(screen.queryByTestId('assistant-context-summary')).not.toBeInTheDocument();
    expect(screen.queryByText('Context')).not.toBeInTheDocument();
    expect(screen.queryByText('3 files')).not.toBeInTheDocument();
    expect(screen.queryByText('100,000 tokens')).not.toBeInTheDocument();
    expect(screen.queryByText('84 est.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open assistant controls' })).toBeInTheDocument();
  });

  it('renders provider settings for the local runtime and updates the thinking toggle', () => {
    const onSettingsChange = vi.fn();

    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="local"
        settings={{ localThinkingEnabled: true }}
      />
    );

    expect(screen.getByText('Gemma thinking')).toBeInTheDocument();
    const switches = screen.getAllByRole('switch');
    const localThinkingToggle = switches.at(-1);
    expect(localThinkingToggle).toBeDefined();
    fireEvent.click(localThinkingToggle as HTMLElement);

    expect(onSettingsChange).toHaveBeenCalledWith('local', { localThinkingEnabled: false });
  });

  it('renders google provider settings and updates include-thoughts', () => {
    const onSettingsChange = vi.fn();

    render(
      <ProviderSettingsPanel
        modelName="gemini-3-pro-preview"
        onSettingsChange={onSettingsChange}
        providerId="google"
        settings={{ googleIncludeThoughts: false, googleThinkingLevel: 'high' }}
      />
    );

    expect(screen.getByText('Gemini thinking')).toBeInTheDocument();
    expect(screen.getByText('Include thoughts')).toBeInTheDocument();
    const switches = screen.getAllByRole('switch');
    const includeThoughtsToggle = switches.at(-1);
    expect(includeThoughtsToggle).toBeDefined();
    fireEvent.click(includeThoughtsToggle as HTMLElement);

    expect(onSettingsChange).toHaveBeenCalledWith('google', { googleIncludeThoughts: true });
  });

  it('renders anthropic settings and updates the thinking budget input', () => {
    const onSettingsChange = vi.fn();

    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="anthropic"
        settings={{ anthropicThinkingBudgetTokens: 4096, maxOutputTokens: 1024 }}
      />
    );

    expect(screen.getByText('Claude reasoning')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Anthropic thinking budget input' }), {
      target: { value: '2048' },
    });

    expect(onSettingsChange).toHaveBeenCalledWith('anthropic', {
      anthropicThinkingBudgetTokens: 2048,
    });
  });

  it('updates agent context and memory controls', () => {
    const onSettingsChange = vi.fn();

    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="openai"
        settings={{ memoryLastMessages: 40, workingMemoryEnabled: true }}
      />
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Limit agent steps' }));
    expect(onSettingsChange).toHaveBeenCalledWith('openai', { agentMaxSteps: 20 });

    fireEvent.click(screen.getByRole('switch', { name: 'Limit input tokens' }));
    expect(onSettingsChange).toHaveBeenCalledWith('openai', {
      agentInputTokenLimit: 64_000,
    });

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Memory messages' }), {
      target: { value: '12' },
    });
    expect(onSettingsChange).toHaveBeenCalledWith('openai', { memoryLastMessages: 12 });

    fireEvent.click(screen.getByRole('switch', { name: 'Enable working memory' }));
    expect(onSettingsChange).toHaveBeenCalledWith('openai', { workingMemoryEnabled: false });
  });

  it('returns nothing for unsupported provider settings panels', () => {
    const { container } = render(<ProviderSettingsPanel providerId="unsupported" settings={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
