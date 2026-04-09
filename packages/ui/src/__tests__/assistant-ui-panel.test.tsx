import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelPickerModel,
  ModelPickerProvider,
  ProviderGroupConfig,
} from '../../src/assistant-ui-panel/assistant-ui-panel';
import { AssistantUiPanel } from '../../src/assistant-ui-panel/assistant-ui-panel';

const useDataStreamRuntimeMock = vi.fn((_options?: unknown) => ({ runtime: 'test-runtime' }));

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
  });

  afterEach(() => {
    vi.clearAllMocks();
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

  it('renders the model picker with provider summary', async () => {
    render(<AssistantUiPanel {...baseProps} onModelChange={() => {}} />);

    // Provider summary should show OpenAI
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0);

    // The model name appears in both the summary badge and the ModelPicker trigger
    const modelTexts = screen.getAllByText('GPT-5.2');
    expect(modelTexts.length).toBeGreaterThan(0);

    // The dropdown container should be present
    const container = screen.getByTestId('assistant-model-dropdown');
    expect(container).toBeInTheDocument();

    // Verify the ModelPicker trigger (combobox) exists
    const trigger = within(container).getByRole('combobox');
    expect(trigger).toBeInTheDocument();
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

    expect(screen.getByText('Select a provider and model to start chatting.')).toBeInTheDocument();
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

    expect(screen.getByText('Select a provider and model to start chatting.')).toBeInTheDocument();
    // The ModelPicker combobox should be disabled when no models available
    const trigger = screen.getByRole('combobox');
    expect(trigger).toBeDisabled();
  });
});
