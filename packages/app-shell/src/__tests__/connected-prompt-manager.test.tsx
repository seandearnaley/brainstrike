import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectedPromptManager } from '../connected-prompt-manager';

// Mock the model registry hook
const mockUseEnsureModelRegistry = vi.fn();
vi.mock('@brainstrike/preferences/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: () => mockUseEnsureModelRegistry(),
}));

// Mock the model registry store
const mockUseModelRegistryStore = vi.fn();
vi.mock('@brainstrike/preferences/stores/model-registry-store', () => ({
  useModelRegistryStore: () => mockUseModelRegistryStore(),
}));

// Mock the PromptManager component
const mockPromptManager = vi.fn(
  ({
    availableModels,
    providers,
  }: {
    availableModels: unknown[];
    providers: unknown[];
  }) => (
    <div data-testid="prompt-manager">
      <span data-testid="model-count">{availableModels.length}</span>
      <span data-testid="provider-count">{providers.length}</span>
    </div>
  )
);

vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual<object>('@brainstrike/ui');
  return {
    ...actual,
    PromptManager: (props: { availableModels: unknown[]; providers: unknown[] }) =>
      mockPromptManager(props),
  };
});

describe('ConnectedPromptManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseEnsureModelRegistry.mockReturnValue(undefined);
  });

  it('renders PromptManager with filtered enabled models', () => {
    mockUseModelRegistryStore.mockReturnValue({
      models: [
        {
          id: 'model-1',
          providerId: 'openai',
          name: 'GPT-4',
          description: 'OpenAI GPT-4',
          capabilities: { chat: true },
          isEnabled: true,
        },
        {
          id: 'model-2',
          providerId: 'openai',
          name: 'GPT-3.5',
          description: 'OpenAI GPT-3.5',
          capabilities: { chat: true },
          isEnabled: false,
        },
        {
          id: 'model-3',
          providerId: 'anthropic',
          name: 'Claude',
          description: 'Anthropic Claude',
          capabilities: { chat: true },
          isEnabled: true,
        },
      ],
      providers: [
        { id: 'openai', name: 'OpenAI', isEnabled: true },
        { id: 'anthropic', name: 'Anthropic', isEnabled: true },
        { id: 'disabled-provider', name: 'Disabled', isEnabled: false },
      ],
    });

    render(<ConnectedPromptManager />);

    expect(screen.getByTestId('prompt-manager')).toBeInTheDocument();
    // Only 2 enabled models should be passed (model-2 is disabled)
    expect(screen.getByTestId('model-count')).toHaveTextContent('2');
    // Only 2 enabled providers should be passed (disabled-provider is filtered out)
    expect(screen.getByTestId('provider-count')).toHaveTextContent('2');
  });

  it('calls useEnsureModelRegistry on mount', () => {
    mockUseModelRegistryStore.mockReturnValue({
      models: [],
      providers: [],
    });

    render(<ConnectedPromptManager />);

    expect(mockUseEnsureModelRegistry).toHaveBeenCalled();
  });

  it('passes only id, providerId, name, description, and capabilities for models', () => {
    mockUseModelRegistryStore.mockReturnValue({
      models: [
        {
          id: 'model-1',
          providerId: 'openai',
          name: 'GPT-4',
          description: 'OpenAI GPT-4',
          capabilities: { chat: true },
          isEnabled: true,
          extraField: 'should-not-be-passed',
        },
      ],
      providers: [],
    });

    render(<ConnectedPromptManager />);

    expect(mockPromptManager).toHaveBeenCalledWith(
      expect.objectContaining({
        availableModels: [
          {
            id: 'model-1',
            providerId: 'openai',
            name: 'GPT-4',
            description: 'OpenAI GPT-4',
            capabilities: { chat: true },
          },
        ],
      })
    );
  });

  it('renders with empty models and providers', () => {
    mockUseModelRegistryStore.mockReturnValue({
      models: [],
      providers: [],
    });

    render(<ConnectedPromptManager />);

    expect(screen.getByTestId('prompt-manager')).toBeInTheDocument();
    expect(screen.getByTestId('model-count')).toHaveTextContent('0');
    expect(screen.getByTestId('provider-count')).toHaveTextContent('0');
  });
});
