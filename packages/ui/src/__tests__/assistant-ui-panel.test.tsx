import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import { TooltipProvider } from '../tooltip';

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
  composer: {
    text: string;
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
  composer: { text: '' },
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

// Stub the heavy ToolFallback card but keep the real `extractPrimaryArg`
// helper — the Activity group summary imports it from this module.
vi.mock('../../src/assistant-ui-panel/tool-fallback', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/assistant-ui-panel/tool-fallback')>();
  return {
    ...actual,
    ToolFallback: () => <div data-testid="tool-fallback" />,
  };
});

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
  useTheme: () => ({ setTheme: vi.fn(), theme: 'light' }),
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
      Copy: Primitive,
      Edit: Primitive,
      Reload: Primitive,
      Root: Primitive,
    },
    AssistantRuntimeProvider: ({ children }: ProviderProps) => <>{children}</>,
    AttachmentPrimitive: {
      Remove: Primitive,
      Root: Primitive,
    },
    BranchPickerPrimitive: {
      Count: ({ children }: CounterProps) => (
        <span data-testid="branch-count">{children ?? '1'}</span>
      ),
      Next: Primitive,
      Number: ({ children }: CounterProps) => (
        <span data-testid="branch-number">{children ?? '1'}</span>
      ),
      Previous: Primitive,
      Root: Primitive,
    },
    ChainOfThoughtPrimitive: {
      AccordionTrigger: Primitive,
      Parts: Primitive,
      Root: Primitive,
    },
    ComposerPrimitive: {
      // The real primitive is a button wired to the registered attachment
      // adapter; the composer passes its own data-testid through props.
      AddAttachment: ({ children, asChild: _asChild, ...props }: ButtonPrimitiveProps) => (
        <button type="button" {...props}>
          {children}
        </button>
      ),
      // Renders no children for an empty attachment list, like the real one.
      Attachments: () => null,
      Cancel: ({ children, asChild: _asChild, ...props }: ButtonPrimitiveProps) => (
        <button data-testid="composer-cancel" type="button" {...props}>
          {children}
        </button>
      ),
      Input: (props: InputProps) => <textarea data-testid="composer-input" {...props} />,
      Root: Primitive,
      Send: ({ children, asChild: _asChild, ...props }: ButtonPrimitiveProps) => (
        <button data-testid="composer-send" type="submit" {...props}>
          {children}
        </button>
      ),
      Unstable_TriggerPopover: Object.assign(
        ({ children }: { children: React.ReactNode }) => <>{children}</>,
        {
          Action: () => null,
          Directive: () => null,
        }
      ),
      Unstable_TriggerPopoverItem: () => null,
      Unstable_TriggerPopoverItems: () => null,
      // "/" and "@" trigger-popover primitives (unified under one
      // Unstable_TriggerPopoverRoot since @assistant-ui/react 0.12.26). The
      // popover only renders its content when the trigger is active, which
      // never happens in these structural tests, so the items render nothing —
      // the root and the popover container just pass children through, and
      // the behavior sub-primitives (Action/Directive) render nothing (they
      // contribute no DOM in the real library either).
      Unstable_TriggerPopoverRoot: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    },
    ErrorPrimitive: {
      // Mirrors the real primitive: renders nothing when the message has no error.
      Message: () => null,
      Root: Primitive,
    },
    MessagePrimitive: {
      If,
      PartByIndex: ({
        index,
        components,
      }: {
        index: number;
        components: {
          Reasoning?: React.ComponentType;
          tools?: { Fallback?: React.ComponentType<Record<string, unknown>> };
        };
      }) => {
        const part = mockAuiState.message.parts[index] as { type?: string } | undefined;
        if (part?.type === 'reasoning') {
          const Reasoning = components.Reasoning ?? (() => null);
          return <Reasoning />;
        }
        if (part?.type === 'tool-call') {
          const Fallback = components.tools?.Fallback ?? (() => null);
          return <Fallback {...part} />;
        }
        return null;
      },
      Parts: ({ components }: PartsProps) => {
        messagePartsComponentsMock(components);
        const Text = components?.Text ?? TextStub;
        return <Text />;
      },
      Root: Primitive,
    },
    ThreadPrimitive: {
      If,
      Messages: ({ components }: MessagesProps) => {
        const Assistant = components?.AssistantMessage;
        return Assistant ? <Assistant /> : null;
      },
      Root: Primitive,
      Viewport: Primitive,
    },
    unstable_useSlashCommandAdapter: () => ({
      categories: () => [],
      categoryItems: () => [],
      search: () => [],
    }),
    useAssistantDataUI: (dataUI: unknown) => useAssistantDataUIMock(dataUI),
    useAttachment: () => ({ content: undefined, file: undefined, name: 'attachment' }),
    useAui: () => ({
      chainOfThought: () => ({
        setCollapsed: setCollapsedMock,
      }),
      composer: () => ({ setText: vi.fn() }),
    }),
    useAuiEvent: () => undefined,
    useAuiState: <T,>(selector: (state: MockAuiState) => T) => selector(mockAuiState),
    useComposerRuntime: () => ({ addAttachment: async () => undefined }),
    useLocalRuntime: (adapter: unknown) => useLocalRuntimeMock(adapter),
    useMessagePartReasoning: () => ({
      status: { type: 'complete' as const },
      text: 'Reasoning text',
      type: 'reasoning' as const,
    }),
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
    label: 'Cloud',
    providers: [
      {
        capabilities: {
          embeddings: false,
          llm: true,
          streaming: true,
          supportsStandardEmbeddingDimension: false,
        },
        id: 'openai',
        models: [
          {
            default: true,
            enabled: true,
            id: 'gpt-5.2',
            label: 'GPT-5.2',
            supportsStreaming: true,
            type: 'llm',
          },
        ],
        name: 'OpenAI',
        runtime: 'hosted',
      },
    ],
    runtime: 'hosted',
  },
  {
    label: 'Gateway',
    providers: [
      {
        capabilities: {
          embeddings: false,
          llm: true,
          streaming: true,
          supportsStandardEmbeddingDimension: false,
        },
        id: 'anthropic',
        models: [
          {
            enabled: true,
            id: 'claude-sonnet-4-6',
            label: 'Claude Sonnet 4.6',
            supportsStreaming: true,
            type: 'llm',
          },
        ],
        name: 'Anthropic',
        runtime: 'gateway',
      },
    ],
    runtime: 'gateway',
  },
];

// ModelPicker-compatible providers (matching the enabled models in providerGroups)
const pickerProviders: ModelPickerProvider[] = [
  { icon: null, id: 'openai', name: 'OpenAI' },
  { icon: null, id: 'anthropic', name: 'Anthropic' },
];

// ModelPicker-compatible models (only enabled models)
const pickerModels: ModelPickerModel[] = [
  {
    capabilities: { streaming: true, type: 'llm' },
    description: null,
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    providerId: 'openai',
  },
  {
    capabilities: { streaming: true, type: 'llm' },
    description: null,
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    providerId: 'anthropic',
  },
];

const baseProps = {
  pickerModels,
  pickerProviders,
  providerGroups,
  selectedModel: 'openai::gpt-5.2',
  selectedProvider: 'openai',
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

  it('hides background run-event rows by default (memory/context bookkeeping)', () => {
    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    const dataUi = useAssistantDataUIMock.mock.calls
      .map((call) => call[0] as { name?: string; render?: React.ComponentType<{ data: unknown }> })
      .find((entry) => entry.name === ASSISTANT_RUN_EVENT_DATA_NAME);
    const RunEventPart = dataUi?.render;
    if (!RunEventPart) {
      throw new Error('Expected a run-event data renderer to be registered.');
    }

    // No AssistantDetailLevelProvider here → standard default → background hidden.
    render(
      <RunEventPart
        data={{
          id: 'evt-1',
          kind: 'memory.semantic.completed',
          label: 'Recalled memory',
          status: 'completed',
          timestamp: '2026-06-16T10:00:00.000Z',
        }}
      />
    );

    expect(screen.queryByTestId('assistant-run-timeline')).not.toBeInTheDocument();
  });

  it('still surfaces run.failed/run.cancelled at default detail (failures never silently hidden)', () => {
    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    const dataUi = useAssistantDataUIMock.mock.calls
      .map((call) => call[0] as { name?: string; render?: React.ComponentType<{ data: unknown }> })
      .find((entry) => entry.name === ASSISTANT_RUN_EVENT_DATA_NAME);
    const RunEventPart = dataUi?.render;
    if (!RunEventPart) {
      throw new Error('Expected a run-event data renderer to be registered.');
    }

    // No AssistantDetailLevelProvider → standard default → background hidden,
    // yet a terminal run failure must still render so the turn isn't silently
    // swallowed.
    const { rerender } = render(
      <TooltipProvider>
        <RunEventPart
          data={{
            id: 'evt-fail',
            kind: 'run.failed',
            label: 'Run failed',
            status: 'failed',
            timestamp: '2026-06-16T10:00:00.000Z',
          }}
        />
      </TooltipProvider>
    );
    expect(screen.getByTestId('assistant-run-timeline')).toBeInTheDocument();
    expect(screen.getByText('Run failed')).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <RunEventPart
          data={{
            id: 'evt-cancel',
            kind: 'run.cancelled',
            label: 'Run cancelled',
            status: 'cancelled',
            timestamp: '2026-06-16T10:00:01.000Z',
          }}
        />
      </TooltipProvider>
    );
    expect(screen.getByText('Run cancelled')).toBeInTheDocument();
  });

  it('renders completed chain-of-thought with a static reasoning mark', () => {
    mockAuiState = createMockAuiState([null, { status: 'complete' }, completedReasoningPart]);

    renderCapturedChainOfThought();

    expect(screen.getByTestId('assistant-reasoning-indicator')).toHaveTextContent('Thinking');
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

    expect(screen.getByTestId('assistant-reasoning-indicator')).toHaveTextContent('Thinking');
    expect(screen.getByTestId('assistant-reasoning-static-mark')).toHaveClass(
      'bs-thinking-mark-static'
    );
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
  });

  it('groups all of a turn’s tool calls into one Activity panel (N steps, not N groups)', () => {
    // The Mastra loop splits each tool into its own step/chain; the turn-level
    // grouping must collapse them into a single "Worked · 3 steps" panel.
    mockAuiState = createMockAuiState([
      { status: { type: 'complete' }, toolCallId: 'a', type: 'tool-call' },
      { status: { type: 'complete' }, toolCallId: 'b', type: 'tool-call' },
      { status: { type: 'complete' }, toolCallId: 'c', type: 'tool-call' },
    ]);

    renderCapturedChainOfThought();

    expect(screen.getByTestId('assistant-activity-group')).toBeInTheDocument();
    expect(screen.getByText(/3 steps/)).toBeInTheDocument();
    expect(screen.getAllByTestId('tool-fallback')).toHaveLength(3);
  });

  it('renders a single tool call as just the card, with no group wrapper', () => {
    mockAuiState = createMockAuiState([
      { status: { type: 'complete' }, toolCallId: 'a', type: 'tool-call' },
    ]);

    renderCapturedChainOfThought();

    expect(screen.queryByTestId('assistant-activity-group')).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-fallback')).toBeInTheDocument();
  });

  it('prepares per-run request data when the hosted runtime starts a request', async () => {
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        resourceId: 'workspace-1',
        runId: 'run-1',
        threadId: 'thread-1',
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
        memory: {
          resourceId: 'workspace-1',
          runId: 'run-1',
          threadId: 'thread-1',
        },
        model: 'gpt-5.2',
        provider: 'openai',
        tokenBudget: 123,
      },
    });
    expect(prepareRequestData).toHaveBeenCalledTimes(1);
  });

  it('completes hosted prepared requests from data stream terminal callbacks', async () => {
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        resourceId: 'workspace-1',
        runId: 'run-1',
        threadId: 'thread-1',
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
          resourceId: 'workspace-1',
          runId: 'run-1',
          threadId: 'thread-1',
        },
      },
      'completed',
      undefined
    );
  });

  it('uses the latest hosted completion callback when the panel rerenders mid-run', async () => {
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        resourceId: 'workspace-1',
        runId: 'run-1',
        threadId: 'thread-1',
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
          resourceId: 'workspace-1',
          runId: 'run-1',
          threadId: 'thread-1',
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
          resourceId: 'workspace-1',
          runId: 'run-1',
          threadId: 'thread-1',
        },
      })
      .mockResolvedValueOnce({
        memory: {
          resourceId: 'workspace-1',
          runId: 'run-2',
          threadId: 'thread-1',
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
          resourceId: 'workspace-1',
          runId: 'run-1',
          threadId: 'thread-1',
        },
      },
      'cancelled',
      undefined
    );
  });

  it('marks hosted prepared requests failed when the data stream errors', async () => {
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        resourceId: 'workspace-1',
        runId: 'run-1',
        threadId: 'thread-1',
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
          resourceId: 'workspace-1',
          runId: 'run-1',
          threadId: 'thread-1',
        },
      },
      'failed',
      'stream failed'
    );
  });

  it('forwards per-run request preparation and completion to local runtime runs', async () => {
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        resourceId: 'workspace-local',
        runId: 'run-local',
        threadId: 'thread-local',
      },
    }));
    const completePreparedRequest = vi.fn();
    const localGroups: ProviderGroupConfig[] = [
      {
        label: 'Local',
        providers: [
          {
            capabilities: {
              embeddings: false,
              llm: true,
              streaming: false,
              supportsStandardEmbeddingDimension: false,
            },
            id: 'local',
            models: [
              {
                default: true,
                enabled: true,
                id: 'onnx-community/gemma-4-E2B-it-ONNX',
                label: 'Gemma 4 E2B',
                type: 'llm',
              },
            ],
            name: 'Local',
            runtime: 'local',
          },
        ],
        runtime: 'local',
      },
    ];

    render(
      <AssistantUiPanel
        completePreparedRequest={completePreparedRequest}
        onModelChange={() => {}}
        pickerModels={[
          {
            capabilities: { streaming: false, type: 'llm' },
            description: null,
            id: 'onnx-community/gemma-4-E2B-it-ONNX',
            name: 'Gemma 4 E2B',
            providerId: 'local',
          },
        ]}
        pickerProviders={[{ icon: null, id: 'local', name: 'Local' }]}
        prepareRequestData={prepareRequestData}
        providerGroups={localGroups}
        requestData={{ tokenBudget: 456 }}
        selectedModel="local::onnx-community/gemma-4-E2B-it-ONNX"
        selectedProvider="local"
      />
    );

    await expect(capturedLocalAdapterOptions?.prepareRuntimeData?.()).resolves.toEqual({
      memory: {
        resourceId: 'workspace-local',
        runId: 'run-local',
        threadId: 'thread-local',
      },
      tokenBudget: 456,
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
        label: 'Local',
        providers: [
          {
            capabilities: {
              embeddings: false,
              llm: true,
              streaming: false,
              supportsStandardEmbeddingDimension: false,
            },
            id: 'local',
            models: [
              {
                default: true,
                enabled: true,
                id: 'onnx-community/gemma-4-E2B-it-ONNX',
                label: 'Gemma 4 E2B',
                type: 'llm',
              },
            ],
            name: 'Local',
            runtime: 'local',
          },
        ],
        runtime: 'local',
      },
    ];

    render(
      <AssistantUiPanel
        onModelChange={() => {}}
        pickerModels={[
          {
            capabilities: { streaming: false, type: 'llm' },
            description: null,
            id: 'onnx-community/gemma-4-E2B-it-ONNX',
            name: 'Gemma 4 E2B',
            providerId: 'local',
          },
        ]}
        pickerProviders={[{ icon: null, id: 'local', name: 'Local' }]}
        providerGroups={localGroups}
        selectedModel="local::onnx-community/gemma-4-E2B-it-ONNX"
        selectedProvider="local"
      />
    );

    act(() => {
      capturedLocalAdapterOptions?.onLoadingProgress?.({
        message: 'Warming up local model host...',
        progress: 42,
        stage: 'loading',
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
        message: 'Local model ready.',
        progress: 100,
        stage: 'ready',
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
        label: 'Local',
        providers: [
          {
            capabilities: {
              embeddings: false,
              llm: true,
              streaming: false,
              supportsStandardEmbeddingDimension: false,
            },
            id: 'local',
            models: [
              {
                default: true,
                enabled: true,
                id: 'onnx-community/gemma-4-E2B-it-ONNX',
                label: 'Gemma 4 E2B',
                type: 'llm',
              },
            ],
            name: 'Local',
            runtime: 'local',
          },
        ],
        runtime: 'local',
      },
    ];

    render(
      <AssistantUiPanel
        onModelChange={() => {}}
        pickerModels={[
          {
            capabilities: { streaming: false, type: 'llm' },
            description: null,
            id: 'onnx-community/gemma-4-E2B-it-ONNX',
            name: 'Gemma 4 E2B',
            providerId: 'local',
          },
        ]}
        pickerProviders={[{ icon: null, id: 'local', name: 'Local' }]}
        providerGroups={localGroups}
        selectedModel="local::onnx-community/gemma-4-E2B-it-ONNX"
        selectedProvider="local"
      />
    );

    act(() => {
      capturedLocalAdapterOptions?.onLoadingProgress?.({
        file: 'model.onnx',
        message: 'Downloading model weights...',
        progress: 33,
        stage: 'downloading',
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

  it('renders the model menu in the composer controls dock', async () => {
    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    // The selected model appears on the menu trigger.
    const modelTexts = screen.getAllByText('GPT-5.2');
    expect(modelTexts.length).toBeGreaterThan(0);

    // The dropdown container should be present
    const container = screen.getByTestId('assistant-model-dropdown');
    expect(container).toBeInTheDocument();

    // Verify the ComposerModelMenu trigger button exists
    const trigger = within(container).getByRole('button', { name: /Selected model/ });
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
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onModelChange = vi.fn();

    render(<AssistantUiPanel {...baseProps} onModelChange={onModelChange} />);

    // Open the composer model menu and drill into More models -> Anthropic.
    const container = screen.getByTestId('assistant-model-dropdown');
    await user.click(within(container).getByRole('button', { name: /Selected model/ }));

    const moreModels = await screen.findByTestId('composer-more-models-trigger');
    moreModels.focus();
    await user.keyboard('{ArrowRight}');

    const anthropicTrigger = await screen.findByRole('menuitem', { name: /Anthropic/ });
    anthropicTrigger.focus();
    await user.keyboard('{ArrowRight}');

    const option = await screen.findByRole('menuitemradio', { name: /Claude Sonnet 4\.6/ });
    await user.click(option);

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
    // The menu trigger should be disabled when no models are available
    const trigger = screen.getByTestId('composer-model-menu-trigger');
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
              enabled: true,
              group: 'Workspace',
              id: 'brainstrike.readWorkspaceFile',
              label: 'Read workspace file',
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

  it('renders only generic runtime limits for the local provider (thinking toggle lives in the model menu)', () => {
    render(
      <ProviderSettingsPanel
        onSettingsChange={vi.fn()}
        providerId="local"
        settings={{ localThinkingEnabled: true }}
      />
    );

    expect(screen.getByText('Agent context')).toBeInTheDocument();
    expect(screen.getByText('Output tokens / step')).toBeInTheDocument();
    expect(screen.queryByText('Gemma thinking')).not.toBeInTheDocument();
    expect(screen.queryByText('Enable thinking')).not.toBeInTheDocument();
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

  it('omits the effort select from Output & Limits (moved to the model menu) but keeps the summary', () => {
    render(
      <ProviderSettingsPanel
        modelName="moonshotai/kimi-k3"
        onSettingsChange={vi.fn()}
        providerId="openrouter"
        settings={{}}
      />
    );

    // Model-constrained effort (e.g. kimi-k3 max-only) now lives in the
    // composer model menu — see composer-model-menu.test.tsx.
    expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).not.toBeInTheDocument();
    expect(screen.queryByText('Effort')).not.toBeInTheDocument();
    expect(screen.getByText('Reasoning summary')).toBeInTheDocument();
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

describe('AssistantUiPanel composer attachments availability', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the attach affordance and registers the attachment adapter when enabled', () => {
    render(
      <AssistantUiPanel
        {...baseProps}
        attachmentsAvailability={{ state: 'enabled' }}
        onModelChange={() => {}}
      />
    );

    expect(screen.getByTestId('assistant-attach-image')).toBeEnabled();
    expect(useBrainstrikeDataStreamRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        adapters: expect.objectContaining({ attachments: expect.anything() }),
      })
    );
  });

  it('renders a visibly disabled attach button carrying the reason when the model lacks vision', () => {
    const { container } = render(
      <AssistantUiPanel
        {...baseProps}
        attachmentsAvailability={{
          reason: 'GPT-Text cannot read images. Switch to a vision-capable model to attach images.',
          state: 'disabled',
        }}
        onModelChange={() => {}}
      />
    );

    const attach = screen.getByTestId('assistant-attach-image');
    expect(attach).toBeDisabled();
    expect(attach).toHaveAttribute('title', expect.stringContaining('GPT-Text cannot read images'));
    // The adapter STAYS registered while disabled: an attachment staged before
    // a switch to a text-only model must remain removable/sendable (the
    // visible provider error is the net) — an adapter-less composer would
    // wipe the typed text + staged image with an unhandled "Attachments are
    // not supported" rejection on Send. New adds are blocked by the disabled
    // button and the absent paste frame instead.
    const lastRuntimeOptions = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as
      | { adapters?: { attachments?: unknown } }
      | undefined;
    expect(lastRuntimeOptions?.adapters?.attachments).toBeDefined();
    // The preview strip stays mounted so a staged image keeps its Remove button.
    expect(container.querySelector('.bs-composer-attachments')).not.toBeNull();
  });

  it('keeps the same adapter instance across an enabled-to-disabled model switch', () => {
    const { rerender } = render(
      <AssistantUiPanel
        {...baseProps}
        attachmentsAvailability={{ state: 'enabled' }}
        onModelChange={() => {}}
      />
    );
    const enabledOptions = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as
      | { adapters?: { attachments?: unknown } }
      | undefined;

    rerender(
      <AssistantUiPanel
        {...baseProps}
        attachmentsAvailability={{ reason: 'No vision.', state: 'disabled' }}
        onModelChange={() => {}}
      />
    );
    const disabledOptions = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as
      | { adapters?: { attachments?: unknown } }
      | undefined;

    // Same instance — a re-created (or torn-down) adapter would reset staged
    // composer attachments mid-thread on a model switch.
    expect(disabledOptions?.adapters?.attachments).toBe(enabledOptions?.adapters?.attachments);
  });

  it('renders no attachment affordance at all when availability is absent (provider-gated)', () => {
    const { container } = render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    expect(screen.queryByTestId('assistant-attach-image')).toBeNull();
    const lastRuntimeOptions = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as
      | { adapters?: { attachments?: unknown } }
      | undefined;
    expect(lastRuntimeOptions?.adapters?.attachments).toBeUndefined();
    expect(container.querySelector('.bs-composer-attachments')).toBeNull();
  });
});
