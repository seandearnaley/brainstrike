import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract';
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

const useBrainstrikeDataStreamRuntimeMock = vi.fn((_options?: unknown) => ({
  runtime: 'test-runtime',
}));
const useAssistantDataUIMock = vi.fn((_dataUI: unknown) => undefined);
const messagePartsComponentsMock = vi.fn((_components: unknown) => undefined);
const useLocalRuntimeMock = vi.fn((_adapter?: unknown) => ({ runtime: 'local-runtime' }));
const setCollapsedMock = vi.fn();
interface MockAuiState {
  chainOfThought: {
    collapsed: boolean;
    parts: unknown[];
  };
  message: {
    parts: unknown[];
  };
  thread: {
    messages: Array<{ id: string }>;
  };
}

const completedReasoningPart = {
  status: { type: 'complete' },
  type: 'reasoning',
};

const createMockAuiState = (parts: unknown[]): MockAuiState => ({
  chainOfThought: { collapsed: true, parts },
  message: { parts },
  thread: { messages: [] },
});

let mockAuiState = createMockAuiState([completedReasoningPart]);
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

vi.mock('../../src/assistant-ui-panel/data-stream-runtime', () => ({
  useBrainstrikeDataStreamRuntime: (options: unknown) =>
    useBrainstrikeDataStreamRuntimeMock(options),
}));

vi.mock('../../src/assistant-ui-panel/assistant-message-text', () => ({
  AssistantMessageText: () => <div data-testid="markdown-text" />,
  preloadMarkdownText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/assistant-ui-panel/tool-fallback', () => ({
  ToolFallback: () => <div data-testid="tool-fallback" />,
}));

vi.mock('../../src/assistant-ui-panel/tooltip-icon-button', () => ({
  TooltipIconButton: ({
    children,
    tooltip,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    tooltip: string;
  }) => (
    <button aria-label={tooltip} type="button" {...props}>
      {children}
    </button>
  ),
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
      ChainOfThought?: React.ComponentType;
      Text?: React.ComponentType;
      data?: unknown;
    };
  }

  interface MessagesProps {
    components?: {
      AssistantMessage?: React.ComponentType;
      EditComposer?: React.ComponentType;
      UserMessage?: React.ComponentType;
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
    // biome-ignore lint/style/useNamingConvention: assistant-ui export name
    ErrorPrimitive: {
      Root: Primitive,
      // Mirrors the real primitive: renders nothing when the message has no error.
      Message: () => null,
    },
    MessagePrimitive: {
      Root: Primitive,
      Parts: ({ components }: PartsProps) => {
        messagePartsComponentsMock(components);
        const Text = components?.Text ?? TextStub;
        return <Text />;
      },
      If,
    },
    useAssistantDataUI: (dataUI: unknown) => useAssistantDataUIMock(dataUI),
    useAui: () => ({
      chainOfThought: () => ({
        setCollapsed: setCollapsedMock,
      }),
    }),
    useAuiState: <T,>(selector: (state: MockAuiState) => T) => selector(mockAuiState),
    useLocalRuntime: (adapter: unknown) => useLocalRuntimeMock(adapter),
    useMessagePartReasoning: () => ({
      type: 'reasoning' as const,
      text: 'Reasoning text',
      status: { type: 'complete' as const },
    }),
    ThreadPrimitive: {
      Root: Primitive,
      Viewport: Primitive,
      Messages: ({ components }: MessagesProps) => {
        const Assistant = components?.AssistantMessage;
        return Assistant ? <Assistant /> : null;
      },
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
            id: 'claude-sonnet-4-6',
            label: 'Claude Sonnet 4.6',
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
    id: 'claude-sonnet-4-6',
    providerId: 'anthropic',
    name: 'Claude Sonnet 4.6',
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

const renderCapturedChainOfThought = () => {
  render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

  const components = messagePartsComponentsMock.mock.calls.at(-1)?.[0] as
    | { readonly ChainOfThought?: React.ComponentType }
    | undefined;
  const ChainOfThought = components?.ChainOfThought;

  if (!ChainOfThought) {
    throw new Error('Expected AssistantUiPanel to register a chain-of-thought component.');
  }

  render(<ChainOfThought />);
};

describe('AssistantUiPanel model picker', () => {
  beforeEach(() => {
    Object.assign(window, { assistant: undefined });
    capturedLocalAdapterOptions = null;
    mockAuiState = createMockAuiState([completedReasoningPart]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('uses the Brainstrike data-stream runtime for hosted providers', () => {
    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    expect(useBrainstrikeDataStreamRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        api: '/api/assistant',
      })
    );
  });

  it('registers assistant data renderers through assistant-ui data UI', () => {
    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    expect(useAssistantDataUIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: ASSISTANT_RUN_EVENT_DATA_NAME,
        render: expect.any(Function),
      })
    );
    expect(useAssistantDataUIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: TOOL_APPROVAL_DATA_NAME,
        render: expect.any(Function),
      })
    );
    expect(messagePartsComponentsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.anything(),
      })
    );
  });

  it('renders completed chain-of-thought with a static reasoning mark', () => {
    mockAuiState = createMockAuiState([null, { status: 'complete' }, completedReasoningPart]);

    renderCapturedChainOfThought();

    expect(screen.getByTestId('assistant-reasoning-indicator')).toHaveTextContent('Reasoning');
    expect(screen.getByTestId('assistant-reasoning-static-mark')).toHaveClass(
      'bs-thinking-mark-static'
    );
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
  });

  it('renders running chain-of-thought with the animated thinking indicator', () => {
    mockAuiState = createMockAuiState([
      {
        status: { type: 'running' },
        type: 'reasoning',
      },
    ]);

    renderCapturedChainOfThought();

    expect(screen.getByTestId('assistant-thinking-indicator')).toHaveTextContent('Thinking');
    expect(screen.getByTestId('assistant-thinking-mark')).toHaveAttribute('data-tone', 'greyscale');
    expect(screen.queryByTestId('assistant-reasoning-static-mark')).not.toBeInTheDocument();
  });

  it('keeps completed reasoning static while a chain tool call is running', () => {
    mockAuiState = createMockAuiState([
      completedReasoningPart,
      {
        status: { type: 'running' },
        type: 'tool-call',
      },
    ]);

    renderCapturedChainOfThought();

    expect(screen.getByTestId('assistant-reasoning-indicator')).toHaveTextContent('Reasoning');
    expect(screen.getByTestId('assistant-reasoning-static-mark')).toHaveClass(
      'bs-thinking-mark-static'
    );
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
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

    const options = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
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

    const options = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
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

    const options = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
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

    const options = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
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

    const options = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
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
    // Percent stays visible during the loading stage too (continuity with the
    // download phase avoids the span blinking in and out — layout shift).
    expect(screen.getByText('42%')).toBeInTheDocument();

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
    const option = await screen.findByText('Claude Sonnet 4.6');
    fireEvent.click(option);

    // Should be called with composite key format: "provider::model"
    expect(onModelChange).toHaveBeenCalledWith('anthropic::claude-sonnet-4-6');
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

  it('emits unset updates when token and step limit toggles are disabled', () => {
    const onSettingsChange = vi.fn();

    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="openai"
        settings={{
          agentInputTokenLimit: 32_000,
          agentMaxSteps: 8,
          maxOutputTokens: 1024,
        }}
      />
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Limit agent steps' }));
    expect(onSettingsChange).toHaveBeenCalledWith('openai', { agentMaxSteps: undefined });

    fireEvent.click(screen.getByRole('switch', { name: 'Limit input tokens' }));
    expect(onSettingsChange).toHaveBeenCalledWith('openai', {
      agentInputTokenLimit: undefined,
    });

    fireEvent.click(screen.getByRole('switch', { name: 'Limit output tokens per step' }));
    expect(onSettingsChange).toHaveBeenCalledWith('openai', { maxOutputTokens: undefined });
  });

  it('clamps provider numeric controls and clears invalid memory edits', () => {
    const onSettingsChange = vi.fn();

    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="OpenRouter"
        settings={{
          agentInputTokenLimit: 32_000,
          agentMaxSteps: 8,
          maxOutputTokens: 1024,
          memoryLastMessages: 40,
        }}
      />
    );

    expect(screen.getByText('OpenAI reasoning')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Max agent steps' }), {
      target: { value: '999' },
    });
    expect(onSettingsChange).toHaveBeenCalledWith('OpenRouter', { agentMaxSteps: 100 });

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Input token limit' }), {
      target: { value: '1' },
    });
    expect(onSettingsChange).toHaveBeenCalledWith('OpenRouter', {
      agentInputTokenLimit: 4096,
    });

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Memory messages' }), {
      target: { value: '' },
    });
    expect(onSettingsChange).toHaveBeenCalledWith('OpenRouter', {
      memoryLastMessages: undefined,
    });

    fireEvent.change(screen.getByRole('slider', { name: 'Max output tokens' }), {
      target: { value: '999999' },
    });
    expect(onSettingsChange).toHaveBeenCalledWith('OpenRouter', { maxOutputTokens: 8192 });
  });

  it('returns nothing when no provider is selected', () => {
    const { container } = render(<ProviderSettingsPanel settings={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('returns nothing for unsupported provider settings panels', () => {
    const { container } = render(<ProviderSettingsPanel providerId="unsupported" settings={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
