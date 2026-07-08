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
  ({ availableModels, providers }: { availableModels: unknown[]; providers: unknown[] }) => (
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
          capabilities: { chat: true },
          description: 'OpenAI GPT-4',
          id: 'model-1',
          isEnabled: true,
          name: 'GPT-4',
          providerId: 'openai',
        },
        {
          capabilities: { chat: true },
          description: 'OpenAI GPT-3.5',
          id: 'model-2',
          isEnabled: false,
          name: 'GPT-3.5',
          providerId: 'openai',
        },
        {
          capabilities: { chat: true },
          description: 'Anthropic Claude',
          id: 'model-3',
          isEnabled: true,
          name: 'Claude',
          providerId: 'anthropic',
        },
      ],
      providers: [
        { id: 'openai', isEnabled: true, name: 'OpenAI' },
        { id: 'anthropic', isEnabled: true, name: 'Anthropic' },
        { id: 'disabled-provider', isEnabled: false, name: 'Disabled' },
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
          capabilities: { chat: true },
          description: 'OpenAI GPT-4',
          extraField: 'should-not-be-passed',
          id: 'model-1',
          isEnabled: true,
          name: 'GPT-4',
          providerId: 'openai',
        },
      ],
      providers: [],
    });

    render(<ConnectedPromptManager />);

    expect(mockPromptManager).toHaveBeenCalledWith(
      expect.objectContaining({
        availableModels: [
          {
            capabilities: { chat: true },
            description: 'OpenAI GPT-4',
            id: 'model-1',
            name: 'GPT-4',
            providerId: 'openai',
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
