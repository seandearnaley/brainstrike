// @vitest-environment jsdom
import type { Attachment } from '@assistant-ui/react';
import { HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES } from '@brainstrike/assistant-contract/assistant-request-body-limit';
import '@testing-library/jest-dom/vitest';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  CONTEXT_BREAKDOWN_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract';
import { COMPACTION_SUMMARY_METADATA_KEY } from '@brainstrike/assistant-contract/compaction-summary';
import { TooltipProvider } from '@brainstrike/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, Fragment } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantEndpointLogger } from '../assistant-endpoint';
import type {
  ModelPickerModel,
  ModelPickerProvider,
  ProviderGroupConfig,
} from '../assistant-ui-panel';
import { AssistantUiPanel, ProviderSettingsPanel } from '../assistant-ui-panel';
import { AssistantRequestPreparationTimeoutError } from '../data-stream-runtime';

const useBrainstrikeDataStreamRuntimeMock = vi.fn((_options?: unknown) => ({
  runtime: 'test-runtime',
}));
const useAssistantDataUIMock = vi.fn((_dataUI: unknown) => undefined);
const useLocalRuntimeMock = vi.fn((_adapter?: unknown) => ({ runtime: 'local-runtime' }));
interface MockAuiState {
  composer: {
    attachments: readonly Attachment[];
    text: string;
  };
  message: {
    metadata?: Record<string, unknown>;
    parts: unknown[];
    role?: string;
  };
  thread: {
    capabilities: { edit: boolean; reload: boolean };
    messages: Array<{ id: string }>;
  };
}

const completedReasoningPart = {
  status: { type: 'complete' },
  type: 'reasoning',
};

const createMockAuiState = (parts: unknown[]): MockAuiState => ({
  composer: { attachments: [], text: '' },
  message: { parts },
  thread: { capabilities: { edit: true, reload: true }, messages: [] },
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
// cmdk (composer model picker) scrolls the active option into view; happy-dom
// has no layout.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock('@assistant-ui/styles/index.css', () => ({}));
vi.mock('@assistant-ui/react-markdown/styles/dot.css', () => ({}));

vi.mock('../data-stream-runtime', () => ({
  AssistantRequestPreparationTimeoutError: class AssistantRequestPreparationTimeoutError extends Error {},
  AssistantStreamReplayUnavailableError: class AssistantStreamReplayUnavailableError extends Error {},
  useBrainstrikeDataStreamRuntime: (options: unknown) =>
    useBrainstrikeDataStreamRuntimeMock(options),
}));

vi.mock('../assistant-message-text', () => ({
  AssistantMessageText: () => <div data-testid="markdown-text" />,
  preloadMarkdownText: vi.fn().mockResolvedValue(undefined),
  UserMessageText: () => <div data-testid="markdown-text" />,
}));

// Stub the heavy ToolFallback card. (The summary helpers the Activity group
// uses live in tool-summaries.ts and stay real.)
vi.mock('../tool-fallback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tool-fallback')>();
  return {
    ...actual,
    ToolFallback: () => <div data-testid="tool-fallback" />,
  };
});

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  useTheme: () => ({ setTheme: vi.fn(), theme: 'light' }),
}));

vi.mock('../local-runtime-adapter', () => ({
  createLocalModelAdapter: (options: unknown) => {
    capturedLocalAdapterOptions = options as typeof capturedLocalAdapterOptions;
    return { run: vi.fn() };
  },
  disposeLocalBackend: vi.fn().mockResolvedValue(undefined),
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
      GroupedParts: ({
        children,
      }: {
        children: (info: { children: React.ReactNode; part: { type: string } }) => React.ReactNode;
      }) => (
        <>
          {mockAuiState.message.parts.map((part, index) => {
            const typed = part as { type?: string } | null;
            if (typed?.type !== 'text') {
              return null;
            }
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable part positions in the isolated primitive mock.
              <Fragment key={index}>
                {children({ children: null, part: { type: 'text' } })}
              </Fragment>
            );
          })}
        </>
      ),
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
      // Jump-to-latest (BST-896): the real primitive renders a button that is
      // DISABLED whenever the viewport sits at the bottom — which is the
      // resting state of these render-shape tests.
      ScrollToBottom: ({ children, asChild: _asChild, ...props }: ButtonPrimitiveProps) => (
        <button disabled type="button" {...props}>
          {children}
        </button>
      ),
      // Virtualized tier (BST-897) escape hatch. These render-shape tests use a
      // handful of messages, so the renderer always resolves to the static tier
      // and this branch never mounts — it exists so the module surface matches.
      Unstable_MessageById: ({ components }: MessagesProps) => {
        const Assistant = components?.AssistantMessage;
        return Assistant ? <Assistant /> : null;
      },
      Viewport: Primitive,
    },
    unstable_useSlashCommandAdapter: () => ({
      categories: () => [],
      categoryItems: () => [],
      search: () => [],
    }),
    // Drives the render-tier choice (BST-897); an empty thread stays static.
    unstable_useThreadMessageIds: () => [],
    useAssistantDataUI: (dataUI: unknown) => useAssistantDataUIMock(dataUI),
    useAui: () => ({
      composer: () => ({ addAttachment: async () => undefined, setText: vi.fn() }),
      subscribe: () => () => undefined,
      thread: () => ({
        getState: () => ({ messages: mockAuiState.thread.messages }),
      }),
    }),
    useAuiEvent: () => undefined,
    useAuiState: <T,>(selector: (state: MockAuiState) => T) => selector(mockAuiState),
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

describe('AssistantUiPanel model picker', () => {
  beforeEach(() => {
    Object.assign(window, { assistant: undefined });
    capturedLocalAdapterOptions = null;
    mockAuiState = createMockAuiState([completedReasoningPart]);
  });

  afterEach(() => {
    Object.assign(window, { assistant: undefined });
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('registers its owning runtime and releases the registration when the panel closes', () => {
    const release = vi.fn();
    const onRuntimeReady = vi.fn(() => release);
    const { unmount } = render(<AssistantUiPanel {...baseProps} onRuntimeReady={onRuntimeReady} />);
    expect(onRuntimeReady).toHaveBeenCalledWith({ runtime: 'test-runtime' });
    expect(release).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('uses the Brainstrike data-stream runtime for hosted providers', () => {
    render(
      <AssistantUiPanel
        {...baseProps}
        onModelChange={() => {}}
        requestBodyLimitBytes={HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES}
      />
    );

    expect(useBrainstrikeDataStreamRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        api: '/api/assistant',
        requestBodyLimitBytes: HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
      })
    );
  });

  it('does not turn a malformed desktop bridge URL into an assistant endpoint', () => {
    Object.assign(window, { assistant: { url: {} } });

    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    expect(useBrainstrikeDataStreamRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ api: '/api/assistant' })
    );
  });

  describe('compaction summary dispatch', () => {
    const summaryPayload = {
      createdAt: '2026-08-09T12:00:00.000Z',
      fallbackKind: 'agentic' as const,
      firstCompactedMessageId: 'message-1',
      lastCompactedMessageId: 'message-8',
      rewriteId: 'rewrite-1',
    };

    function setAssistantMessage(marker: unknown, role = 'assistant'): void {
      mockAuiState = {
        ...createMockAuiState([{ text: 'Goal\nKeep the renderer honest.', type: 'text' }]),
        message: {
          metadata: { custom: { [COMPACTION_SUMMARY_METADATA_KEY]: marker } },
          parts: [{ text: 'Goal\nKeep the renderer honest.', type: 'text' }],
          role,
        },
      };
    }

    it('renders a valid compaction summary as a card instead of the normal assistant bubble', () => {
      setAssistantMessage(summaryPayload);

      const { container } = render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

      expect(screen.getByTestId('compaction-summary-card')).toBeVisible();
      expect(container.querySelector('.aui-assistant-message-content')).not.toBeInTheDocument();
    });

    it.each([
      ['missing marker', undefined, 'assistant'],
      ['wrong role', summaryPayload, 'user'],
      ['malformed payload', { ...summaryPayload, rewriteId: '' }, 'assistant'],
    ])('falls through to the normal bubble for a %s', (_case, marker, role) => {
      if (marker === undefined) {
        mockAuiState = createMockAuiState([{ text: 'Ordinary reply.', type: 'text' }]);
        mockAuiState.message.role = role;
      } else {
        setAssistantMessage(marker, role);
      }

      const { container } = render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

      expect(screen.queryByTestId('compaction-summary-card')).not.toBeInTheDocument();
      expect(container.querySelector('.aui-assistant-message-content')).toBeInTheDocument();
      expect(screen.getByTestId('markdown-text')).toBeInTheDocument();
    });

    it('labels deterministic fallback honestly and keeps that warning off agentic summaries', () => {
      setAssistantMessage({
        ...summaryPayload,
        droppedSummaryLine: 'Dropped 8 messages from August 1–2.',
        fallbackKind: 'deterministic',
      });
      const { rerender } = render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

      expect(screen.getByText(/no summarization model ran/i)).toBeVisible();

      setAssistantMessage(summaryPayload);
      rerender(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

      expect(screen.queryByText(/no summarization model ran/i)).not.toBeInTheDocument();
    });
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
  });

  it('registers a null renderer for the context-breakdown data part (never a stray element)', () => {
    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    expect(useAssistantDataUIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: CONTEXT_BREAKDOWN_DATA_NAME,
        render: expect.any(Function),
      })
    );

    const dataUi = useAssistantDataUIMock.mock.calls
      .map((call) => call[0] as { name?: string; render?: React.ComponentType<{ data: unknown }> })
      .find((entry) => entry.name === CONTEXT_BREAKDOWN_DATA_NAME);
    const ContextBreakdownPart = dataUi?.render;
    if (!ContextBreakdownPart) {
      throw new Error('Expected a context-breakdown data renderer to be registered.');
    }

    const { container } = render(
      <ContextBreakdownPart
        data={{
          attachmentsCount: 0,
          provenance: 'heuristic',
          systemInstructionsTokens: 100,
        }}
      />
    );
    expect(container).toBeEmptyDOMElement();
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

  it('persists the desktop replay cursor and supplies it after a renderer reload', async () => {
    window.sessionStorage.clear();
    Object.assign(window, {
      assistant: {
        getAuth: vi.fn(async () => ({
          token: 'desktop-token',
          url: 'http://127.0.0.1:9999',
        })),
      },
    });
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        resourceId: 'workspace-1',
        runId: 'run-1',
        threadId: 'thread-1',
      },
    }));

    const firstRender = render(
      <AssistantUiPanel
        {...baseProps}
        onModelChange={() => {}}
        prepareRequestData={prepareRequestData}
        threadKey="thread-1"
      />
    );
    await waitFor(() =>
      expect(useBrainstrikeDataStreamRuntimeMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          api: 'http://127.0.0.1:9999/assistant',
          resumeApi: 'http://127.0.0.1:9999/assistant/resume',
        })
      )
    );
    const firstOptions = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
      body?: () => Promise<Record<string, unknown> | undefined>;
      onResponse?: (response: Response) => void;
    };
    await firstOptions.body?.();
    firstOptions.onResponse?.(
      new Response(null, {
        headers: {
          'X-Brainstrike-Assistant-Event-Id': 'session-1:-1',
          'X-Brainstrike-Assistant-Message-Id': 'assistant-1',
        },
      })
    );
    expect(
      JSON.parse(
        window.sessionStorage.getItem('brainstrike.assistant.active-run:thread-1') ?? 'null'
      )
    ).toEqual({
      assistantMessageId: 'assistant-1',
      eventId: 'session-1:-1',
      runId: 'run-1',
    });

    firstRender.unmount();
    render(
      <AssistantUiPanel
        {...baseProps}
        onModelChange={() => {}}
        prepareRequestData={prepareRequestData}
        threadKey="thread-1"
      />
    );
    await waitFor(() =>
      expect(useBrainstrikeDataStreamRuntimeMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeRunSession: {
            assistantMessageId: 'assistant-1',
            eventId: 'session-1:-1',
            runId: 'run-1',
          },
          resumeApi: 'http://127.0.0.1:9999/assistant/resume',
        })
      )
    );
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
      onCancel?: (cancelled: { readonly messages: readonly unknown[] }) => void;
      onError?: (error: Error) => void;
      onFinish?: () => void;
    };

    const preparedBody = await options.body?.();
    options.onFinish?.();
    options.onError?.(new Error('late stream error'));
    options.onCancel?.({ messages: [] });

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
      undefined,
      false
    );
  });

  it('protects desktop Stop from abort errors until server cancellation settles', async () => {
    Object.assign(window, {
      assistant: {
        getAuth: vi.fn(async () => ({
          token: 'desktop-token',
          url: 'http://127.0.0.1:43123',
        })),
      },
    });
    const cancellation = Promise.withResolvers<Response>();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(cancellation.promise);
    const prepareRequestData = vi.fn(async () => ({
      memory: {
        resourceId: 'workspace-1',
        runId: 'run-cancel-1',
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

    await waitFor(() =>
      expect(useBrainstrikeDataStreamRuntimeMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ api: 'http://127.0.0.1:43123/assistant' })
      )
    );
    const options = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
      body?: () => Promise<Record<string, unknown> | undefined>;
      onCancel?: (cancelled: { readonly messages: readonly unknown[] }) => void;
      onError?: (error: Error) => void;
    };
    await options.body?.();
    options.onCancel?.({ messages: [] });
    options.onError?.(new Error('Assistant request was aborted.'));

    expect(completePreparedRequest).not.toHaveBeenCalled();
    cancellation.resolve(new Response(null, { status: 200 }));
    await waitFor(() =>
      expect(completePreparedRequest).toHaveBeenCalledWith(
        expect.any(Object),
        'cancelled',
        undefined,
        true
      )
    );
    expect(completePreparedRequest).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:43123/assistant/cancel'),
        expect.objectContaining({
          body: JSON.stringify({ runId: 'run-cancel-1' }),
          method: 'POST',
        })
      )
    );
    fetchMock.mockRestore();
  });

  it('cancels a prepared run that resolves after Stop aborts preparation', async () => {
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    const prepareRequestData = vi.fn(() => deferred.promise);
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
      body?: (abortSignal: AbortSignal) => Promise<Record<string, unknown> | undefined>;
    };
    const abortController = new AbortController();
    const bodyPromise = options.body?.(abortController.signal);
    await waitFor(() => expect(prepareRequestData).toHaveBeenCalledOnce());

    const abortError = new DOMException('The user aborted a request.', 'AbortError');
    abortController.abort(abortError);
    deferred.resolve({
      memory: {
        resourceId: 'workspace-1',
        runId: 'run-cancel-late',
        threadId: 'thread-1',
      },
    });

    await expect(bodyPromise).rejects.toBe(abortError);
    expect(completePreparedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        memory: expect.objectContaining({ runId: 'run-cancel-late' }),
      }),
      'cancelled',
      undefined
    );
  });

  it('fails a prepared run that resolves after its preparation watchdog expires', async () => {
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    const prepareRequestData = vi.fn(() => deferred.promise);
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
      body?: (abortSignal: AbortSignal) => Promise<Record<string, unknown> | undefined>;
    };
    const abortController = new AbortController();
    const bodyPromise = options.body?.(abortController.signal);
    await waitFor(() => expect(prepareRequestData).toHaveBeenCalledOnce());

    const timeoutError = new AssistantRequestPreparationTimeoutError(
      'Assistant request preparation timed out after 30000ms.'
    );
    abortController.abort(timeoutError);
    deferred.resolve({
      memory: {
        resourceId: 'workspace-1',
        runId: 'run-timeout-late',
        threadId: 'thread-1',
      },
    });

    await expect(bodyPromise).rejects.toBe(timeoutError);
    expect(completePreparedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        memory: expect.objectContaining({ runId: 'run-timeout-late' }),
      }),
      'failed',
      timeoutError.message
    );
  });

  it('preserves and logs a terminal preparation reason when run completion fails', async () => {
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    const prepareRequestData = vi.fn(() => deferred.promise);
    const completionError = new Error('failed to persist terminal run state');
    const completePreparedRequest = vi.fn().mockRejectedValue(completionError);
    const logger = vi.spyOn(assistantEndpointLogger, 'error').mockImplementation(() => undefined);

    render(
      <AssistantUiPanel
        {...baseProps}
        completePreparedRequest={completePreparedRequest}
        onModelChange={() => {}}
        prepareRequestData={prepareRequestData}
      />
    );

    const options = useBrainstrikeDataStreamRuntimeMock.mock.calls.at(-1)?.[0] as {
      body?: (abortSignal: AbortSignal) => Promise<Record<string, unknown> | undefined>;
    };
    const abortController = new AbortController();
    const bodyPromise = options.body?.(abortController.signal);
    await waitFor(() => expect(prepareRequestData).toHaveBeenCalledOnce());

    const timeoutError = new AssistantRequestPreparationTimeoutError(
      'Assistant request preparation timed out after 30000ms.'
    );
    abortController.abort(timeoutError);
    deferred.resolve({
      memory: {
        resourceId: 'workspace-1',
        runId: 'run-timeout-completion-failed',
        threadId: 'thread-1',
      },
    });

    await expect(bodyPromise).rejects.toBe(timeoutError);
    expect(logger).toHaveBeenCalledWith('Failed to complete abandoned assistant preparation', {
      error: completionError,
      reason: timeoutError,
    });
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
      undefined,
      false
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
    await waitFor(() => {
      expect(completePreparedRequest).toHaveBeenCalledTimes(1);
    });
    expect(completePreparedRequest).toHaveBeenCalledWith(
      {
        memory: {
          resourceId: 'workspace-1',
          runId: 'run-1',
          threadId: 'thread-1',
        },
      },
      'cancelled',
      undefined,
      false
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
      'stream failed',
      false
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

    // Verify the ComposerModelPicker trigger button exists
    const trigger = within(container).getByRole('button', { name: /Selected model/ });
    expect(trigger).toBeInTheDocument();
    expect(screen.queryByText(/OpenAI \/ GPT-5\.2/)).not.toBeInTheDocument();
  });

  it('keeps the model picker operable when message submission is disabled', () => {
    render(<AssistantUiPanel {...baseProps} disabled onModelChange={() => {}} />);

    const input = screen.getByTestId('composer-input');
    expect(input).toBeDisabled();
    expect(input.closest('.aui-composer-root')).not.toHaveAttribute('aria-disabled');
    expect(screen.getByTestId('composer-model-menu-trigger')).toBeEnabled();
  });

  it('renders the always-visible effort readout beside the model menu (BST-948)', () => {
    render(
      <AssistantUiPanel
        {...baseProps}
        onModelChange={() => {}}
        onProviderSettingsChange={() => {}}
        providerSettings={{ openai: { reasoningEffort: 'high' } }}
      />
    );

    const controls = screen.getByTestId('assistant-composer-controls');
    const trigger = within(controls).getByTestId('composer-effort-trigger');
    expect(trigger).toBeEnabled();
    // The active effort is legible without opening any menu. (Accessible-name
    // whitespace joining differs between jsdom setups, so match tolerantly.)
    expect(trigger).toHaveAccessibleName(/Reasoning\s*Effort\s*High/);
    // And it sits in the same dock as the model menu.
    expect(within(controls).getByTestId('assistant-model-dropdown')).toBeInTheDocument();
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

    // Open the composer model picker and search for the model.
    const container = screen.getByTestId('assistant-model-dropdown');
    await user.click(within(container).getByRole('button', { name: /Selected model/ }));

    const picker = await screen.findByRole('dialog');
    await user.type(within(picker).getByRole('combobox'), 'sonnet 4.6');
    const option = await within(picker).findByRole('option', { name: /Claude Sonnet 4\.6/ });
    await user.click(option);

    // Should be called with composite key format: "provider::model"
    expect(onModelChange).toHaveBeenCalledWith('anthropic::claude-sonnet-4-6');
    // Full panel render + typing into the picker search via userEvent can
    // exceed vitest's 5s default on loaded runners.
  }, 20_000);

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
    expect(screen.getByText('Output tokens per step')).toBeInTheDocument();
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
    // composer effort control — see composer-effort-control.test.tsx.
    expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).not.toBeInTheDocument();
    expect(screen.queryByText('Effort')).not.toBeInTheDocument();
    expect(screen.getByText('Reasoning summary')).toBeInTheDocument();
  });

  it('shows OpenRouter model limits and the effective Auto output reservation', () => {
    render(
      <ProviderSettingsPanel
        modelName="openai/gpt-5.4-mini"
        onSettingsChange={vi.fn()}
        providerId="openrouter"
        settings={{}}
      />
    );

    expect(screen.getByText('GPT-5.4 Mini (OpenRouter)')).toBeInTheDocument();
    expect(screen.getByText(/400,000 context.*128,000 max output/)).toBeInTheDocument();
    expect(screen.getByText(/Auto requests 32,000.*348,000 effective input/)).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Max output tokens' })).toHaveAttribute(
      'max',
      '128000'
    );
    expect(screen.getByRole('slider', { name: 'Max output tokens' })).toHaveValue('32000');
  });

  it('reserves the vendor window for Kimi K3 whose reasoning is on by default (BST-1170)', () => {
    // The displayed Auto reservation must match what the run actually sends:
    // K3 reasons by default and reasoning tokens stream into the output
    // window, so Auto reserves Moonshot's documented 131,072 — not the 32K
    // coding ceiling that starved thinking+answer.
    render(
      <ProviderSettingsPanel
        modelName="moonshotai/kimi-k3"
        onSettingsChange={vi.fn()}
        providerId="openrouter"
        settings={{}}
      />
    );

    expect(screen.getByText(/Auto requests 131,072.*865,075 effective input/)).toBeInTheDocument();
    const slider = screen.getByRole('slider', { name: 'Max output tokens' });
    // BST-1804: the slider bound is the route's top_provider max output.
    expect(slider).toHaveAttribute('max', '943718');
    expect(slider).toHaveValue('131072');
  });

  it('keeps the Kimi K3 vendor window when live metadata cannot carry the catalog facts', () => {
    // Live metadata never carries the catalog-only vendor window; it must
    // survive the live merge here exactly as it does in the request builder.
    // BST-1804: the fixture mirrors the live route, which now publishes a
    // 943,718 top-provider max completion.
    render(
      <ProviderSettingsPanel
        modelName="moonshotai/kimi-k3"
        onSettingsChange={vi.fn()}
        openRouterModelMetadataLookup={{
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 1_048_576,
              id: 'moonshotai/kimi-k3',
              maxOutputTokens: 943_718,
              reasoning: {
                defaultEffort: 'max',
                defaultEnabled: true,
                mandatory: false,
                supportedEfforts: ['max', 'high', 'low'],
                supportsMaxTokens: false,
              },
              source: 'openrouter-models-api',
              supportedParameters: ['reasoning', 'max_tokens'],
            },
          },
          state: 'resolved',
        }}
        providerId="openrouter"
        settings={{}}
      />
    );

    expect(screen.getByText(/Auto requests 131,072.*865,075 effective input/)).toBeInTheDocument();
  });

  it('drops Kimi K3 back to the coding ceiling when reasoning is switched off', () => {
    render(
      <ProviderSettingsPanel
        modelName="moonshotai/kimi-k3"
        onSettingsChange={vi.fn()}
        providerId="openrouter"
        settings={{ reasoningEffort: 'none' }}
      />
    );

    expect(screen.getByText(/Auto requests 32,000.*964,147 effective input/)).toBeInTheDocument();
  });

  it('uses the coding default when OpenRouter does not declare a model output maximum', () => {
    render(
      <ProviderSettingsPanel
        modelName="moonshotai/kimi-k3"
        onSettingsChange={vi.fn()}
        openRouterModelMetadataLookup={{
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 1_048_576,
              id: 'moonshotai/kimi-k3',
              source: 'openrouter-models-api',
              supportedParameters: ['tools'],
            },
          },
          state: 'resolved',
        }}
        providerId="openrouter"
        settings={{}}
      />
    );

    expect(screen.getByText(/Auto requests 32,000.*964,147 effective input/)).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Max output tokens' })).toHaveValue('32000');
    expect(
      screen.getByRole('spinbutton', { name: 'Output token limit' })
    ).toHaveAccessibleDescription(/Auto requests 32,000 tokens for this model/);
  });

  it('describes the actual OpenRouter Auto reservation while a custom output cap is selected', () => {
    render(
      <ProviderSettingsPanel
        modelName="moonshotai/kimi-k3"
        onSettingsChange={vi.fn()}
        providerId="openrouter"
        settings={{ maxOutputTokens: 1024, reasoningEffort: 'none' }}
      />
    );

    expect(
      screen.getByRole('spinbutton', { name: 'Output token limit' })
    ).toHaveAccessibleDescription(/Auto requests 32,000 tokens for this model/);
    expect(screen.getByText(/1,024 configured output/)).toBeInTheDocument();
  });

  it('shows and applies live OpenRouter model limits with provenance', () => {
    render(
      <ProviderSettingsPanel
        modelName="anthropic/claude-sonnet-4.6"
        onSettingsChange={vi.fn()}
        openRouterModelMetadataLookup={{
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 1_000_000,
              id: 'anthropic/claude-sonnet-4.6',
              maxOutputTokens: 128_000,
              source: 'openrouter-models-api',
              supportedParameters: ['tools'],
            },
          },
          state: 'resolved',
        }}
        providerId="openrouter"
        settings={{}}
      />
    );

    expect(screen.getByText(/1,000,000 context.*128,000 max output/)).toBeInTheDocument();
    expect(screen.getByText('Source: OpenRouter live')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Max output tokens' })).toHaveAttribute(
      'max',
      '128000'
    );
  });

  it('keeps an above-maximum output draft visible and does not persist it', () => {
    const onSettingsChange = vi.fn();
    const onValidationChange = vi.fn();
    render(
      <ProviderSettingsPanel
        modelName="google/gemini-2.5-flash"
        onSettingsChange={onSettingsChange}
        onValidationChange={onValidationChange}
        openRouterModelMetadataLookup={{
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 1_048_576,
              id: 'google/gemini-2.5-flash',
              maxOutputTokens: 65_535,
              source: 'openrouter-models-api',
              supportedParameters: [],
            },
          },
          state: 'resolved',
        }}
        providerId="openrouter"
        settings={{ maxOutputTokens: 4096 }}
      />
    );

    const input = screen.getByRole('spinbutton', { name: 'Output token limit' });
    fireEvent.change(input, { target: { value: '65536' } });
    fireEvent.blur(input);

    expect(input).toHaveValue(65_536);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('65,535 maximum from OpenRouter live');
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(onValidationChange).toHaveBeenLastCalledWith(
      expect.stringContaining('65,535 maximum from OpenRouter live')
    );
  });

  it('rejects empty, below-minimum, and fractional output drafts before recovering', () => {
    const onSettingsChange = vi.fn();
    const onValidationChange = vi.fn();
    const renderPanel = (maxOutputTokens: number) => (
      <ProviderSettingsPanel
        modelName="openai/gpt-5.4-mini"
        onSettingsChange={onSettingsChange}
        onValidationChange={onValidationChange}
        providerId="openrouter"
        settings={{ maxOutputTokens }}
      />
    );
    const { rerender } = render(renderPanel(4096));

    const input = screen.getByRole('spinbutton', { name: 'Output token limit' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent(/enter an output limit/i);
    expect(onSettingsChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '127' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(127);
    expect(screen.getByRole('alert')).toHaveTextContent(/at least 128/i);
    expect(onSettingsChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '128.5' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number/i);
    expect(onSettingsChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '512' } });
    fireEvent.blur(input);
    rerender(renderPanel(512));
    expect(screen.getByRole('spinbutton', { name: 'Output token limit' })).toHaveValue(512);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onSettingsChange).toHaveBeenLastCalledWith('openrouter', {
      maxOutputTokens: 512,
    });
    expect(onValidationChange).toHaveBeenLastCalledWith(undefined);
  });

  it('surfaces an impossible persisted output reservation without crashing the panel', () => {
    render(
      <ProviderSettingsPanel
        modelName="openai/gpt-5.4-mini"
        onSettingsChange={vi.fn()}
        openRouterModelMetadataLookup={{
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 400_000,
              id: 'openai/gpt-5.4-mini',
              maxOutputTokens: 128_000,
              source: 'openrouter-models-api',
              supportedParameters: [],
            },
          },
          state: 'resolved',
        }}
        providerId="openrouter"
        settings={{ maxOutputTokens: 500_000 }}
      />
    );

    expect(
      screen.getByText(/effective input unavailable until the output limit is fixed/i)
    ).toBeVisible();
  });

  it('shows the persisted OpenRouter output value when the slider display is clamped', () => {
    render(
      <ProviderSettingsPanel
        modelName="anthropic/claude-sonnet-4.6"
        onSettingsChange={vi.fn()}
        openRouterModelMetadataLookup={{
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 1_000_000,
              id: 'anthropic/claude-sonnet-4.6',
              maxOutputTokens: 128_000,
              source: 'openrouter-models-api',
              supportedParameters: [],
            },
          },
          state: 'resolved',
        }}
        providerId="openrouter"
        settings={{ maxOutputTokens: 200_000 }}
      />
    );

    expect(
      screen.getByText(/configured output 200,000 exceeds the OpenRouter live maximum 128,000/i)
    ).toBeVisible();
    expect(screen.getByRole('slider', { name: 'Max output tokens' })).toHaveValue('128000');
  });

  it('makes a live metadata failure visible while labeling the static limits in use', () => {
    render(
      <ProviderSettingsPanel
        modelName="anthropic/claude-sonnet-4.6"
        onSettingsChange={vi.fn()}
        openRouterModelMetadataLookup={{
          message: 'OpenRouter request failed',
          state: 'error',
        }}
        providerId="openrouter"
        settings={{}}
      />
    );

    expect(screen.getByText(/1,000,000 context.*128,000 max output/)).toBeInTheDocument();
    expect(screen.getByText('Source: built-in model catalog')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      /Live metadata unavailable.*OpenRouter request failed/
    );
    expect(screen.getByRole('status')).toHaveClass('text-destructive');
  });

  it('renders live metadata loading as neutral status', () => {
    render(
      <ProviderSettingsPanel
        modelName="anthropic/claude-sonnet-4.6"
        onSettingsChange={vi.fn()}
        openRouterModelMetadataLookup={{ state: 'loading' }}
        providerId="openrouter"
        settings={{}}
      />
    );

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/Checking live OpenRouter metadata/);
    expect(status).toHaveClass('text-muted-foreground');
    expect(status).not.toHaveClass('text-destructive');
  });

  it('surfaces missing built-in OpenRouter limits instead of silently guessing', () => {
    render(
      <ProviderSettingsPanel
        modelName="vendor/new-model"
        onSettingsChange={vi.fn()}
        providerId="openrouter"
        settings={{}}
      />
    );

    expect(screen.getByText(/limits unavailable.*built-in catalog/i)).toBeInTheDocument();
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
    const budget = screen.getByRole('spinbutton', { name: 'Anthropic thinking budget input' });
    fireEvent.change(budget, { target: { value: '2048' } });
    fireEvent.blur(budget);

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
    expect(onSettingsChange).toHaveBeenCalledWith('openai', { agentMaxSteps: 100 });

    fireEvent.click(screen.getByRole('switch', { name: 'Limit input tokens' }));
    expect(onSettingsChange).toHaveBeenCalledWith('openai', {
      agentInputTokenLimit: 64_000,
    });

    const memory = screen.getByRole('spinbutton', { name: 'Memory messages' });
    fireEvent.change(memory, { target: { value: '12' } });
    fireEvent.blur(memory);
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

  it('refuses out-of-range provider numeric drafts and clears a blank memory edit', () => {
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

    expect(screen.getByText('Reasoning output')).toBeInTheDocument();

    // A value outside the range is refused with a message, never clamped.
    const steps = screen.getByRole('spinbutton', { name: 'Max agent steps' });
    fireEvent.change(steps, { target: { value: '0' } });
    fireEvent.blur(steps);
    const limit = screen.getByRole('spinbutton', { name: 'Input token limit' });
    fireEvent.change(limit, { target: { value: '1' } });
    fireEvent.blur(limit);
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(onSettingsChange).not.toHaveBeenCalled();

    const memory = screen.getByRole('spinbutton', { name: 'Memory messages' });
    fireEvent.change(memory, { target: { value: '' } });
    fireEvent.blur(memory);
    expect(onSettingsChange).toHaveBeenCalledWith('OpenRouter', {
      memoryLastMessages: undefined,
    });

    fireEvent.change(screen.getByRole('slider', { name: 'Max output tokens' }), {
      target: { value: '999999' },
    });
    expect(onSettingsChange).toHaveBeenCalledWith('OpenRouter', { maxOutputTokens: 32_000 });
  });

  it('caps the OpenRouter output control at the selected model maximum', () => {
    const onSettingsChange = vi.fn();

    render(
      <ProviderSettingsPanel
        modelName="openai/gpt-5.4-mini"
        onSettingsChange={onSettingsChange}
        providerId="openrouter"
        settings={{ maxOutputTokens: 8192 }}
      />
    );

    fireEvent.change(screen.getByRole('slider', { name: 'Max output tokens' }), {
      target: { value: '999999' },
    });
    expect(onSettingsChange).toHaveBeenCalledWith('openrouter', {
      maxOutputTokens: 128_000,
    });
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
    cleanup();
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
