// @vitest-environment jsdom
import type { AssistantRuntime, Attachment } from '@assistant-ui/react';
import '@testing-library/jest-dom/vitest';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  CONTEXT_BREAKDOWN_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract';
import { COMPACTION_SUMMARY_METADATA_KEY } from '@brainstrike/assistant-contract/compaction-summary';
import { TooltipProvider } from '@brainstrike/ui';
import { cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Fragment } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantConversationPanel,
  type AssistantConversationPanelProps,
} from '../assistant-conversation-panel';
import type { ModelPickerModel, ProviderGroupConfig } from '../assistant-ui-panel';
import { ProviderSettingsPanel } from '../assistant-ui-panel';
import { useAssistantThreadRuntimeAdapters } from '../use-assistant-thread-runtime-adapters';

const useAssistantDataUIMock = vi.fn((_dataUI: unknown) => undefined);
interface MockAuiState {
  composer: {
    attachments: readonly Attachment[];
    queue: readonly unknown[];
    text: string;
  };
  message: {
    metadata?: Record<string, unknown>;
    parts: unknown[];
    role?: string;
  };
  thread: {
    capabilities: { edit: boolean; reload: boolean };
    isRunning?: boolean;
    messages: Array<{ id: string }>;
  };
}

const completedReasoningPart = {
  status: { type: 'complete' },
  type: 'reasoning',
};

const createMockAuiState = (parts: unknown[]): MockAuiState => ({
  composer: { attachments: [], queue: [], text: '' },
  message: { parts },
  thread: { capabilities: { edit: true, reload: true }, messages: [] },
});

let mockAuiState = createMockAuiState([completedReasoningPart]);

// cmdk (composer model picker) scrolls the active option into view; happy-dom
// has no layout.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

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
  useTheme: () => ({ mode: 'light', setMode: vi.fn(), setTheme: vi.fn(), theme: 'brainstrike' }),
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
      composer: () => ({
        addAttachment: async () => undefined,
        getState: () => mockAuiState.composer,
        setText: vi.fn(),
      }),
      subscribe: () => () => undefined,
      thread: () => ({
        getState: () => ({ messages: mockAuiState.thread.messages }),
      }),
    }),
    useAuiEvent: () => undefined,
    useAuiState: <T,>(selector: (state: MockAuiState) => T) => selector(mockAuiState),
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
          streaming: true,
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
          streaming: true,
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
  providerGroups,
  selectedModel: 'openai::gpt-5.2',
  selectedProvider: 'openai',
};

// `@assistant-ui/react` is mocked above, so the provider never reads it.
const TEST_RUNTIME = {} as AssistantRuntime;

/** The live thread surface (`CommittedAssistantConversation` renders it). */
function Panel(
  props: Omit<AssistantConversationPanelProps, 'label' | 'runtime' | 'threadKey'> & {
    readonly threadKey?: string;
  }
) {
  return (
    <AssistantConversationPanel
      label="Assistant chat"
      runtime={TEST_RUNTIME}
      threadKey="thread-1"
      {...props}
    />
  );
}

describe('assistant thread surface', () => {
  beforeEach(() => {
    mockAuiState = createMockAuiState([completedReasoningPart]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // `capabilityNotice` must not live in `aui-thread-viewport`: that element
  // scrolls, and a long thread opens pinned to its newest message, so a notice
  // placed there is off-screen exactly when the composer is usable. Asserting
  // the ANCESTOR, not just the text, is the point — the first version of this
  // feature rendered the right words in the wrong container.
  it('keeps a capability notice out of the scrolling transcript', () => {
    render(<Panel {...baseProps} capabilityNotice="Memory is unavailable here." />);

    const notice = screen.getByTestId('assistant-capability-notice');
    expect(notice).toHaveTextContent('Memory is unavailable here.');
    expect(notice.closest('[data-testid="assistant-composer-shell"]')).not.toBeNull();
    expect(notice.closest('[data-testid="assistant-ui-viewport"]')).toBeNull();
  });

  // The two channels are independent. `disabledReason` keeps its place above
  // the transcript even with no `disabled`, because a caller may set it alone
  // and still mean blocked — committed-assistant-conversation.tsx does that for
  // host-unavailable, and the reading-position browser test depends on the
  // notice landing inside the viewport so scroll anchoring can hold a reader.
  it('leaves a disabled reason above the transcript, with no capability notice', () => {
    render(<Panel {...baseProps} disabledReason="The agent host is unavailable." />);

    expect(screen.queryByTestId('assistant-capability-notice')).toBeNull();
    const reason = screen.getByText('The agent host is unavailable.');
    expect(reason.closest('[data-testid="assistant-ui-viewport"]')).not.toBeNull();
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

      const { container } = render(<Panel {...baseProps} onModelChange={() => {}} />);

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

      const { container } = render(<Panel {...baseProps} onModelChange={() => {}} />);

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
      const { unmount } = render(<Panel {...baseProps} onModelChange={() => {}} />);

      expect(screen.getByText(/no summarization model ran/iu)).toBeVisible();

      unmount();
      setAssistantMessage(summaryPayload);
      render(<Panel {...baseProps} onModelChange={() => {}} />);

      expect(screen.queryByText(/no summarization model ran/iu)).not.toBeInTheDocument();
    });
  });

  it('registers assistant data renderers through assistant-ui data UI', () => {
    render(<Panel {...baseProps} onModelChange={() => {}} />);

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
    render(<Panel {...baseProps} onModelChange={() => {}} />);

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
    render(<Panel {...baseProps} onModelChange={() => {}} />);

    const dataUi = useAssistantDataUIMock.mock.calls
      .map((call) => call[0] as { name?: string; render?: React.ComponentType<{ data: unknown }> })
      .find((entry) => entry.name === ASSISTANT_RUN_EVENT_DATA_NAME);
    const RunEventPart = dataUi?.render;
    if (!RunEventPart) {
      throw new Error('Expected a run-event data renderer to be registered.');
    }

    // Detail level untouched → standard default → background hidden.
    render(
      <RunEventPart
        data={{
          id: 'evt-1',
          kind: 'memory.reflection.completed',
          label: 'Reflected memory',
          status: 'completed',
          timestamp: '2026-06-16T10:00:00.000Z',
        }}
      />
    );

    expect(screen.queryByTestId('assistant-run-timeline')).not.toBeInTheDocument();
  });

  it('still surfaces run.failed/run.cancelled at default detail (failures never silently hidden)', () => {
    render(<Panel {...baseProps} onModelChange={() => {}} />);

    const dataUi = useAssistantDataUIMock.mock.calls
      .map((call) => call[0] as { name?: string; render?: React.ComponentType<{ data: unknown }> })
      .find((entry) => entry.name === ASSISTANT_RUN_EVENT_DATA_NAME);
    const RunEventPart = dataUi?.render;
    if (!RunEventPart) {
      throw new Error('Expected a run-event data renderer to be registered.');
    }

    // Detail level untouched → standard default → background hidden,
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

  it('renders the model menu in the composer controls dock', async () => {
    render(<Panel {...baseProps} onModelChange={() => {}} />);

    // The selected model appears on the menu trigger.
    const modelTexts = screen.getAllByText('GPT-5.2');
    expect(modelTexts.length).toBeGreaterThan(0);

    // The dropdown container should be present
    const container = screen.getByTestId('assistant-model-dropdown');
    expect(container).toBeInTheDocument();

    // Verify the ComposerModelPicker trigger button exists
    const trigger = within(container).getByRole('button', { name: /Selected model/u });
    expect(trigger).toBeInTheDocument();
    expect(screen.queryByText(/OpenAI \/ GPT-5\.2/u)).not.toBeInTheDocument();
  });

  it('keeps the model picker operable when message submission is disabled', () => {
    render(<Panel {...baseProps} isComposerDisabled onModelChange={() => {}} />);

    const input = screen.getByTestId('composer-input');
    expect(input).toBeDisabled();
    expect(input.closest('.aui-composer-root')).not.toHaveAttribute('aria-disabled');
    expect(screen.getByTestId('composer-model-menu-trigger')).toBeEnabled();
  });

  it('renders the always-visible effort readout beside the model menu (BST-948)', () => {
    render(
      <Panel
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
    expect(trigger).toHaveAccessibleName(/Reasoning\s*Effort\s*High/u);
    // And it sits in the same dock as the model menu.
    expect(within(controls).getByTestId('assistant-model-dropdown')).toBeInTheDocument();
  });

  it('keeps model and controls inside the composer surface with icon send controls', () => {
    render(<Panel {...baseProps} onModelChange={() => {}} />);

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

    render(<Panel {...baseProps} onModelChange={onModelChange} />);

    // Open the composer model picker and search for the model.
    const container = screen.getByTestId('assistant-model-dropdown');
    await user.click(within(container).getByRole('button', { name: /Selected model/u }));

    const picker = await screen.findByRole('dialog');
    await user.type(within(picker).getByRole('combobox'), 'sonnet 4.6');
    const option = await within(picker).findByRole('option', { name: /Claude Sonnet 4\.6/u });
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
    render(<Panel pickerModels={[]} providerGroups={noModelsGroups} />);

    expect(screen.getByText('No models enabled')).toBeInTheDocument();
    const trigger = screen.getByTestId('assistant-model-dropdown');
    expect(trigger).toBeInTheDocument();
  });

  it('hints at the "/" menu in the idle placeholder only when there are commands', () => {
    const { unmount } = render(<Panel {...baseProps} />);
    expect(screen.getByRole('textbox', { name: 'Message input' })).toHaveAttribute(
      'placeholder',
      'Ask Brainstrike anything…'
    );
    unmount();

    render(
      <Panel
        {...baseProps}
        slashCommands={[{ execute: () => {}, id: 'thread.new', label: 'New thread' }]}
      />
    );
    expect(screen.getByRole('textbox', { name: 'Message input' })).toHaveAttribute(
      'placeholder',
      'Ask anything, or type / for commands'
    );
  });

  it('keeps the model picker openable when no models are enabled, so it can lead to a fix', () => {
    const noModelsGroups: ProviderGroupConfig[] = providerGroups.map((group) => ({
      ...group,
      providers: group.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, enabled: false })),
      })),
    }));

    render(
      <Panel
        onManageModels={() => {}}
        onModelChange={() => {}}
        pickerModels={[]}
        providerGroups={noModelsGroups}
      />
    );

    expect(screen.getByText('No models enabled')).toBeInTheDocument();
    expect(screen.getByTestId('composer-model-menu-trigger')).toBeEnabled();
  });

  it('omits context summary and context controls while keeping tool controls visible', () => {
    render(
      <Panel
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
    expect(screen.getByText(/400,000 context.*128,000 max output/u)).toBeInTheDocument();
    expect(screen.getByText(/Auto requests 32,000.*348,000 effective input/u)).toBeInTheDocument();
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

    expect(screen.getByText(/Auto requests 131,072.*865,075 effective input/u)).toBeInTheDocument();
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

    expect(screen.getByText(/Auto requests 131,072.*865,075 effective input/u)).toBeInTheDocument();
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

    expect(screen.getByText(/Auto requests 32,000.*964,147 effective input/u)).toBeInTheDocument();
  });

  it('caps the output control at the room the window leaves for input (BST-1810)', () => {
    // MiniMax M3 publishes a 512,000 maximum output in a 524,288 window, whose
    // 26,215 safety margin leaves room for at most 498,072 output tokens.
    const onSettingsChange = vi.fn();
    const onValidationChange = vi.fn();
    render(
      <ProviderSettingsPanel
        modelName="minimax/minimax-m3"
        onSettingsChange={onSettingsChange}
        onValidationChange={onValidationChange}
        providerId="openrouter"
        settings={{ maxOutputTokens: 4096 }}
      />
    );

    expect(screen.getByRole('slider', { name: 'Max output tokens' })).toHaveAttribute(
      'max',
      '498072'
    );
    const input = screen.getByRole('spinbutton', { name: 'Output token limit' });
    expect(input).toHaveAttribute('max', '498072');
    fireEvent.change(input, { target: { value: '512000' } });
    fireEvent.blur(input);

    const refusal =
      "Output limit exceeds the 498,072 maximum from this model's 524,288-token context window.";
    expect(screen.getByRole('alert')).toHaveTextContent(refusal);
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(onValidationChange).toHaveBeenLastCalledWith(refusal);
  });

  it('keeps the model maximum when its window has room for it (Kimi K3, BST-1810)', () => {
    render(
      <ProviderSettingsPanel
        modelName="moonshotai/kimi-k3"
        onSettingsChange={vi.fn()}
        providerId="openrouter"
        settings={{ maxOutputTokens: 4096 }}
      />
    );

    expect(screen.getByRole('slider', { name: 'Max output tokens' })).toHaveAttribute(
      'max',
      '943718'
    );
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

    expect(screen.getByText(/Auto requests 32,000.*964,147 effective input/u)).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Max output tokens' })).toHaveValue('32000');
    expect(
      screen.getByRole('spinbutton', { name: 'Output token limit' })
    ).toHaveAccessibleDescription(/Auto requests 32,000 tokens for this model/u);
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
    ).toHaveAccessibleDescription(/Auto requests 32,000 tokens for this model/u);
    expect(screen.getByText(/1,024 configured output/u)).toBeInTheDocument();
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

    expect(screen.getByText(/1,000,000 context.*128,000 max output/u)).toBeInTheDocument();
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
    expect(screen.getByRole('alert')).toHaveTextContent(/enter an output limit/iu);
    expect(onSettingsChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '127' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(127);
    expect(screen.getByRole('alert')).toHaveTextContent(/at least 128/iu);
    expect(onSettingsChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '128.5' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number/iu);
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
      screen.getByText(/effective input unavailable until the output limit is fixed/iu)
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
      screen.getByText(/configured output 200,000 exceeds the OpenRouter live maximum 128,000/iu)
    ).toBeVisible();
    expect(screen.getByRole('slider', { name: 'Max output tokens' })).toHaveValue('128000');
  });

  it('makes a live metadata failure visible while labeling the static limits in use', () => {
    render(
      <ProviderSettingsPanel
        modelName="anthropic/claude-sonnet-4.6"
        onSettingsChange={vi.fn()}
        openRouterModelMetadataLookup={{
          message: 'OpenRouter request failed. Check your connection.',
          state: 'error',
        }}
        providerId="openrouter"
        settings={{}}
      />
    );

    expect(screen.getByText(/1,000,000 context.*128,000 max output/u)).toBeInTheDocument();
    expect(screen.getByText('Source: built-in model catalog')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Live metadata unavailable, so the built-in catalog is in use. OpenRouter request failed. Check your connection.'
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
    expect(status).toHaveTextContent(/Checking live OpenRouter metadata/u);
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

    expect(screen.getByText(/limits unavailable.*built-in catalog/iu)).toBeInTheDocument();
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

    const memory = screen.getByRole('spinbutton', { name: 'Recent messages' });
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
    const steps = screen.getByRole('spinbutton', { name: 'Max steps' });
    fireEvent.change(steps, { target: { value: '0' } });
    fireEvent.blur(steps);
    const limit = screen.getByRole('spinbutton', { name: 'Input tokens' });
    fireEvent.change(limit, { target: { value: '1' } });
    fireEvent.blur(limit);
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(onSettingsChange).not.toHaveBeenCalled();

    const memory = screen.getByRole('spinbutton', { name: 'Recent messages' });
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

describe('composer attachments availability', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the attach affordance and registers the attachment adapter when enabled', () => {
    render(
      <Panel
        {...baseProps}
        attachmentsAvailability={{ state: 'enabled' }}
        onModelChange={() => {}}
      />
    );

    expect(screen.getByTestId('assistant-attach-image')).toBeEnabled();
  });

  it('renders a visibly disabled attach button carrying the reason when the model lacks vision', () => {
    const { container } = render(
      <Panel
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
    // The preview strip stays mounted so a staged image keeps its Remove button.
    expect(container.querySelector('.bs-composer-attachments')).not.toBeNull();
  });

  // An attachment staged before a switch to a text-only model must remain
  // removable/sendable (the visible provider error is the net): an
  // adapter-less composer would wipe the typed text + staged image with an
  // unhandled "Attachments are not supported" rejection on Send. The adapter
  // therefore follows availability PRESENCE, so an enabled-to-disabled model
  // switch keeps the same instance and its staged attachments.
  it('keeps the same adapter instance while attachments stay offered', () => {
    const { result, rerender } = renderHook(
      ({ present }: { present: boolean }) => useAssistantThreadRuntimeAdapters(present),
      { initialProps: { present: true } }
    );
    const offered = result.current.adapters?.attachments;
    expect(offered).toBeDefined();

    rerender({ present: true });
    expect(result.current.adapters?.attachments).toBe(offered);

    rerender({ present: false });
    expect(result.current.adapters).toBeUndefined();
  });

  it('renders no attachment affordance at all when availability is absent (provider-gated)', () => {
    const { container } = render(<Panel {...baseProps} onModelChange={() => {}} />);

    expect(screen.queryByTestId('assistant-attach-image')).toBeNull();
    expect(container.querySelector('.bs-composer-attachments')).toBeNull();
  });
});

describe('thread run state reporting (BST-1844)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('reports the run state of its thread, and false when it unmounts', () => {
    const onRunningChange = vi.fn();
    mockAuiState = createMockAuiState([completedReasoningPart]);
    mockAuiState.thread.isRunning = true;
    const { unmount } = render(
      <Panel
        {...baseProps}
        onModelChange={() => {}}
        onRunningChange={onRunningChange}
        threadKey="thread-1"
      />
    );

    expect(onRunningChange.mock.calls).toEqual([['thread-1', true]]);

    unmount();

    expect(onRunningChange.mock.calls).toEqual([
      ['thread-1', true],
      ['thread-1', false],
    ]);
  });
});
