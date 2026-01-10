import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../model-picker';
import type { ModelPickerModel, ModelPickerProvider } from '../types';

// Mock ResizeObserver for Radix
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock scrollIntoView
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// Mock pointer capture methods
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();

let mockTheme = 'light';
const mockSetTheme = vi.fn();

vi.mock('../../theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: mockTheme, setTheme: mockSetTheme }),
}));

const providers: ModelPickerProvider[] = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
];

const models: ModelPickerModel[] = [
  { id: 'gpt-4', name: 'GPT-4', providerId: 'openai', capabilities: { type: 'llm' } },
  { id: 'gpt-3.5', name: 'GPT-3.5', providerId: 'openai', capabilities: { type: 'llm' } },
  {
    id: 'claude-3',
    name: 'Claude 3',
    providerId: 'anthropic',
    capabilities: { type: 'llm' },
  },
  {
    id: 'text-embedding',
    name: 'Text Embedding',
    providerId: 'openai',
    capabilities: { type: 'embedding' },
  },
];

describe('ModelPicker', () => {
  beforeEach(() => {
    mockTheme = 'light';
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('renders trigger with placeholder', () => {
      render(<ModelPicker models={models} providers={providers} />);
      expect(screen.getByText('Select a model...')).toBeInTheDocument();
    });

    it('renders with custom placeholder', () => {
      render(<ModelPicker models={models} placeholder="Choose your model" providers={providers} />);
      expect(screen.getByText('Choose your model')).toBeInTheDocument();
    });

    it('renders in disabled state', () => {
      render(<ModelPicker disabled models={models} providers={providers} />);
      const trigger = screen.getByRole('combobox');
      expect(trigger).toBeDisabled();
    });

    it('opens on click and shows options', () => {
      render(<ModelPicker models={models} providers={providers} />);
      fireEvent.click(screen.getByText('Select a model...'));
      expect(screen.getByText('GPT-4')).toBeInTheDocument();
      expect(screen.getByText('Claude 3')).toBeInTheDocument();
    });

    it('renders with custom className', () => {
      render(<ModelPicker className="custom-class" models={models} providers={providers} />);
      const trigger = screen.getByRole('combobox');
      expect(trigger).toHaveClass('custom-class');
    });
  });

  describe('selection', () => {
    it('selects an option in single mode', () => {
      const onChange = vi.fn();
      render(<ModelPicker models={models} onChange={onChange} providers={providers} />);
      fireEvent.click(screen.getByText('Select a model...'));
      fireEvent.click(screen.getByText('GPT-4'));
      expect(onChange).toHaveBeenCalledWith('gpt-4');
    });

    it('displays selected model in trigger', () => {
      render(<ModelPicker models={models} providers={providers} value="gpt-4" />);
      expect(screen.getByText('GPT-4')).toBeInTheDocument();
    });

    it('handles multi-select mode - adds selection', () => {
      const onChange = vi.fn();
      render(
        <ModelPicker mode="multi" models={models} onChange={onChange} providers={providers} />
      );
      fireEvent.click(screen.getByRole('combobox'));
      fireEvent.click(screen.getByText('GPT-4'));
      expect(onChange).toHaveBeenCalledWith(['gpt-4']);
    });

    it('handles multi-select with existing value', () => {
      render(<ModelPicker mode="multi" models={models} providers={providers} value={['gpt-4']} />);
      // Trigger should show the selected model
      expect(screen.getByText('GPT-4')).toBeInTheDocument();
    });

    it('handles multi-select with multiple selections', () => {
      const onChange = vi.fn();
      render(
        <ModelPicker
          mode="multi"
          models={models}
          onChange={onChange}
          providers={providers}
          value={['gpt-4']}
        />
      );
      fireEvent.click(screen.getByRole('combobox'));
      fireEvent.click(screen.getByText('Claude 3'));
      expect(onChange).toHaveBeenCalledWith(['gpt-4', 'claude-3']);
    });

    it('displays count for multiple selections', () => {
      render(
        <ModelPicker
          mode="multi"
          models={models}
          providers={providers}
          value={['gpt-4', 'claude-3']}
        />
      );
      expect(screen.getByText('GPT-4')).toBeInTheDocument();
      expect(screen.getByText('(+1)')).toBeInTheDocument();
    });
  });

  describe('filtering', () => {
    it('filters models by type when modelType is llm', () => {
      render(<ModelPicker models={models} modelType="llm" providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByText('GPT-4')).toBeInTheDocument();
      expect(screen.queryByText('Text Embedding')).not.toBeInTheDocument();
    });

    it('filters models by type when modelType is embedding', () => {
      render(<ModelPicker models={models} modelType="embedding" providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByText('Text Embedding')).toBeInTheDocument();
      expect(screen.queryByText('GPT-4')).not.toBeInTheDocument();
    });

    it('shows all models when modelType is all', () => {
      render(<ModelPicker models={models} modelType="all" providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByText('GPT-4')).toBeInTheDocument();
      expect(screen.getByText('Text Embedding')).toBeInTheDocument();
    });
  });

  describe('search', () => {
    it('renders search input when searchable is true', () => {
      render(<ModelPicker models={models} providers={providers} searchable />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByPlaceholderText('Search models...')).toBeInTheDocument();
    });

    it('does not render search input when searchable is false', () => {
      render(<ModelPicker models={models} providers={providers} searchable={false} />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.queryByPlaceholderText('Search models...')).not.toBeInTheDocument();
    });

    it('filters models based on search query', async () => {
      render(<ModelPicker models={models} providers={providers} searchable />);
      fireEvent.click(screen.getByRole('combobox'));

      const searchInput = screen.getByPlaceholderText('Search models...');
      fireEvent.change(searchInput, { target: { value: 'claude' } });

      await waitFor(() => {
        expect(screen.getByText('Claude 3')).toBeInTheDocument();
        expect(screen.queryByText('GPT-4')).not.toBeInTheDocument();
      });
    });
  });

  describe('theme handling', () => {
    it('handles light theme', () => {
      mockTheme = 'light';
      render(<ModelPicker models={models} providers={providers} value="gpt-4" />);
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('handles dark theme', () => {
      mockTheme = 'dark';
      render(<ModelPicker models={models} providers={providers} value="gpt-4" />);
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('handles system theme with light preference', () => {
      mockTheme = 'system';
      const matchMedia = vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      window.matchMedia = matchMedia;

      render(<ModelPicker models={models} providers={providers} value="gpt-4" />);
      expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    });

    it('handles system theme with dark preference', () => {
      mockTheme = 'system';
      const matchMedia = vi.fn().mockImplementation(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      window.matchMedia = matchMedia;

      render(<ModelPicker models={models} providers={providers} value="gpt-4" />);
      expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    });
  });

  describe('custom trigger', () => {
    it('renders custom trigger when renderTrigger is provided', () => {
      render(
        <ModelPicker
          models={models}
          providers={providers}
          renderTrigger={({ placeholder }) => (
            <button data-testid="custom-trigger" type="button">
              {placeholder}
            </button>
          )}
        />
      );
      expect(screen.getByTestId('custom-trigger')).toBeInTheDocument();
    });

    it('passes correct props to custom trigger', () => {
      const renderTrigger = vi.fn().mockReturnValue(<button type="button">Custom</button>);
      render(
        <ModelPicker
          disabled
          models={models}
          placeholder="Select"
          providers={providers}
          renderTrigger={renderTrigger}
          value="gpt-4"
        />
      );
      expect(renderTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          value: 'gpt-4',
          placeholder: 'Select',
          disabled: true,
          models,
          providers,
        })
      );
    });
  });

  describe('empty state', () => {
    it('shows empty state when no models match', () => {
      render(<ModelPicker models={[]} providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByText('No models found.')).toBeInTheDocument();
    });
  });

  describe('grouping', () => {
    it('groups models by provider', () => {
      render(<ModelPicker models={models} providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
      expect(screen.getByText('Anthropic')).toBeInTheDocument();
    });

    it('shows model count per provider', () => {
      render(<ModelPicker models={models} modelType="llm" providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));
      // OpenAI has 2 LLM models
      expect(screen.getByText('2')).toBeInTheDocument();
    });
  });

  describe('local embedding models (BST-299 regression)', () => {
    // Test data that mimics what ManageEmbeddingSetsDialog produces
    const localEmbeddingModels: ModelPickerModel[] = [
      {
        id: 'Xenova/all-MiniLM-L6-v2',
        name: 'all-MiniLM-L6-v2',
        providerId: 'local',
        capabilities: { type: 'embedding', defaultDimension: 384 },
      },
      {
        id: 'Xenova/bge-small-en-v1.5',
        name: 'BGE Small',
        providerId: 'local',
        capabilities: { type: 'embedding', defaultDimension: 384 },
      },
      {
        id: 'openai::text-embedding-3-small',
        name: 'Text Embedding 3 Small',
        providerId: 'openai',
        capabilities: { type: 'embedding', defaultDimension: 1536 },
      },
    ];

    const localProviders: ModelPickerProvider[] = [
      { id: 'local', name: 'Local' },
      { id: 'openai', name: 'OpenAI' },
    ];

    it('shows local embedding models in dropdown when modelType is embedding', () => {
      render(
        <ModelPicker
          models={localEmbeddingModels}
          modelType="embedding"
          providers={localProviders}
        />
      );
      fireEvent.click(screen.getByRole('combobox'));

      // Both local models should be visible
      expect(screen.getByText('all-MiniLM-L6-v2')).toBeInTheDocument();
      expect(screen.getByText('BGE Small')).toBeInTheDocument();
      // OpenAI model should also be visible
      expect(screen.getByText('Text Embedding 3 Small')).toBeInTheDocument();
    });

    it('shows Local provider group header when local embedding models exist', () => {
      render(
        <ModelPicker
          models={localEmbeddingModels}
          modelType="embedding"
          providers={localProviders}
        />
      );
      fireEvent.click(screen.getByRole('combobox'));

      // Both provider groups should be visible
      expect(screen.getByText('Local')).toBeInTheDocument();
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
    });

    it('correctly selects and displays a local embedding model', () => {
      const onChange = vi.fn();
      render(
        <ModelPicker
          models={localEmbeddingModels}
          modelType="embedding"
          onChange={onChange}
          providers={localProviders}
          value="Xenova/all-MiniLM-L6-v2"
        />
      );

      // Trigger should show the selected local model
      expect(screen.getByText('all-MiniLM-L6-v2')).toBeInTheDocument();

      // Open dropdown and verify models are visible
      fireEvent.click(screen.getByRole('combobox'));

      // All embedding models should be visible
      expect(screen.getByText('BGE Small')).toBeInTheDocument();
      expect(screen.getByText('Text Embedding 3 Small')).toBeInTheDocument();
    });

    it('does not filter out local models when filtering by embedding type', () => {
      render(
        <ModelPicker
          models={localEmbeddingModels}
          modelType="embedding"
          providers={localProviders}
        />
      );
      fireEvent.click(screen.getByRole('combobox'));

      // Count how many models are visible (should be 3)
      const localModels = screen.getAllByText(/MiniLM|BGE Small|Text Embedding/);
      expect(localModels).toHaveLength(3);
    });
  });
});
