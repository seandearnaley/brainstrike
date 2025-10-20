import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderGroupConfig } from '../../src/assistant-ui-panel/assistant-ui-panel';
import { AssistantUiPanel } from '../../src/assistant-ui-panel/assistant-ui-panel';

vi.mock('@assistant-ui/styles/index.css', () => ({}));
vi.mock('@assistant-ui/styles/markdown.css', () => ({}));
vi.mock('@assistant-ui/react-markdown/styles/dot.css', () => ({}));

vi.mock('@assistant-ui/react-data-stream', () => ({
  useDataStreamRuntime: () => ({ runtime: 'test-runtime' }),
}));

vi.mock('../../src/assistant-ui-panel/markdown-text', () => ({
  MarkdownText: () => <div data-testid="markdown-text" />,
}));

vi.mock('../../src/assistant-ui-panel/tool-fallback', () => ({
  ToolFallback: () => <div data-testid="tool-fallback" />,
}));

vi.mock('@assistant-ui/react', () => {
  type PrimitiveProps = {
    children?: React.ReactNode;
    asChild?: boolean;
    [key: string]: unknown;
  };

  const Primitive = ({ children, asChild, ...props }: PrimitiveProps) => {
    const Component = asChild ? 'span' : 'div';
    return <Component {...props}>{children}</Component>;
  };

  type IfProps = {
    children?: React.ReactNode | ((props: Record<string, unknown>) => React.ReactNode);
  };

  const If = ({ children }: IfProps) =>
    typeof children === 'function' ? children({}) : (children ?? null);

  const TextStub = () => <div data-testid="assistant-text" />;

  type ProviderProps = {
    children?: React.ReactNode;
  };

  type CounterProps = {
    children?: React.ReactNode;
  };

  type InputProps = Record<string, unknown>;

  type PartsProps = {
    components?: {
      Text?: React.ComponentType;
    };
  };

  return {
    ActionBarPrimitive: {
      Root: Primitive,
      Edit: Primitive,
      Copy: Primitive,
      Reload: Primitive,
    },
    AssistantRuntimeProvider: ({ children }: ProviderProps) => <>{children}</>,
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
      Send: Primitive,
      Cancel: Primitive,
    },
    MessagePrimitive: {
      Root: Primitive,
      Parts: ({ components }: PartsProps) => {
        const Text = components?.Text ?? TextStub;
        return <Text />;
      },
      If,
    },
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
            id: 'gpt-4o-mini',
            label: 'GPT-4o Mini',
            type: 'llm',
            enabled: true,
            default: true,
            supportsStreaming: true,
          },
          {
            id: 'gpt-4o',
            label: 'GPT-4o',
            type: 'llm',
            enabled: false,
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
            id: 'claude-3-haiku',
            label: 'Claude 3 Haiku',
            type: 'llm',
            enabled: true,
            supportsStreaming: true,
          },
        ],
      },
    ],
  },
];

const baseProps = {
  providerGroups,
  selectedProvider: 'openai',
  selectedModel: 'gpt-4o-mini',
};

describe('AssistantUiPanel model picker', () => {
  beforeEach(() => {
    Object.assign(window, { assistant: undefined });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dropdown with enabled models and provider summary', async () => {
    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0);
    expect(screen.getAllByText('GPT-4o Mini').length).toBeGreaterThan(0);

    const trigger = screen.getByTestId('assistant-model-dropdown');
    fireEvent.pointerDown(trigger, {
      pointerId: 1,
      pointerType: 'mouse',
    });
    fireEvent.pointerUp(trigger, { pointerId: 1, pointerType: 'mouse' });

    expect(
      await screen.findByTestId('assistant-model-option-openai-gpt-4o-mini')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-model-option-openai-gpt-4o')).not.toBeInTheDocument();
    expect(
      await screen.findByTestId('assistant-model-option-anthropic-claude-3-haiku')
    ).toBeInTheDocument();
  });

  it('invokes model change handler with composite key when selecting a different provider model', async () => {
    const onModelChange = vi.fn();

    render(<AssistantUiPanel {...baseProps} onModelChange={onModelChange} />);

    const trigger = screen.getByTestId('assistant-model-dropdown');
    fireEvent.pointerDown(trigger, {
      pointerId: 1,
      pointerType: 'mouse',
    });
    fireEvent.pointerUp(trigger, { pointerId: 1, pointerType: 'mouse' });
    const option = await screen.findByTestId('assistant-model-option-anthropic-claude-3-haiku');
    fireEvent.pointerDown(option, { pointerId: 1, pointerType: 'mouse' });
    fireEvent.pointerUp(option, { pointerId: 1, pointerType: 'mouse' });

    expect(onModelChange).toHaveBeenCalledWith('anthropic::claude-3-haiku');
  });

  it('disables the dropdown when no models are enabled', () => {
    const noModelsGroups: ProviderGroupConfig[] = providerGroups.map((group) => ({
      ...group,
      providers: group.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, enabled: false })),
      })),
    }));

    render(
      <AssistantUiPanel
        providerGroups={noModelsGroups}
        selectedProvider={null}
        selectedModel={undefined}
      />
    );

    expect(screen.getByText('Select a provider and model to start chatting.')).toBeInTheDocument();
    const trigger = screen.getByTestId('assistant-model-dropdown');
    expect(trigger).toBeDisabled();
  });
});
