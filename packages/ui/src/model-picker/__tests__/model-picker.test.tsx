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
      render(<ModelPicker models={models} providers={providers} placeholder="Choose your model" />);
      expect(screen.getByText('Choose your model')).toBeInTheDocument();
    });

    it('renders in disabled state', () => {
      render(<ModelPicker models={models} providers={providers} disabled />);
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
      render(<ModelPicker models={models} providers={providers} className="custom-class" />);
      const trigger = screen.getByRole('combobox');
      expect(trigger).toHaveClass('custom-class');
    });
  });

  describe('selection', () => {
    it('selects an option in single mode', () => {
      const onChange = vi.fn();
      render(<ModelPicker models={models} providers={providers} onChange={onChange} />);
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
        <ModelPicker models={models} providers={providers} mode="multi" onChange={onChange} />
      );
      fireEvent.click(screen.getByRole('combobox'));
      fireEvent.click(screen.getByText('GPT-4'));
      expect(onChange).toHaveBeenCalledWith(['gpt-4']);
    });

    it('handles multi-select with existing value', () => {
      render(<ModelPicker models={models} providers={providers} mode="multi" value={['gpt-4']} />);
      // Trigger should show the selected model
      expect(screen.getByText('GPT-4')).toBeInTheDocument();
    });

    it('handles multi-select with multiple selections', () => {
      const onChange = vi.fn();
      render(
        <ModelPicker
          models={models}
          providers={providers}
          mode="multi"
          value={['gpt-4']}
          onChange={onChange}
        />
      );
      fireEvent.click(screen.getByRole('combobox'));
      fireEvent.click(screen.getByText('Claude 3'));
      expect(onChange).toHaveBeenCalledWith(['gpt-4', 'claude-3']);
    });

    it('displays count for multiple selections', () => {
      render(
        <ModelPicker
          models={models}
          providers={providers}
          mode="multi"
          value={['gpt-4', 'claude-3']}
        />
      );
      expect(screen.getByText('GPT-4')).toBeInTheDocument();
      expect(screen.getByText('(+1)')).toBeInTheDocument();
    });
  });

  describe('filtering', () => {
    it('filters models by type when modelType is llm', () => {
      render(<ModelPicker models={models} providers={providers} modelType="llm" />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByText('GPT-4')).toBeInTheDocument();
      expect(screen.queryByText('Text Embedding')).not.toBeInTheDocument();
    });

    it('filters models by type when modelType is embedding', () => {
      render(<ModelPicker models={models} providers={providers} modelType="embedding" />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByText('Text Embedding')).toBeInTheDocument();
      expect(screen.queryByText('GPT-4')).not.toBeInTheDocument();
    });

    it('shows all models when modelType is all', () => {
      render(<ModelPicker models={models} providers={providers} modelType="all" />);
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
            <button type="button" data-testid="custom-trigger">
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
          models={models}
          providers={providers}
          value="gpt-4"
          placeholder="Select"
          disabled
          renderTrigger={renderTrigger}
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
      render(<ModelPicker models={models} providers={providers} modelType="llm" />);
      fireEvent.click(screen.getByRole('combobox'));
      // OpenAI has 2 LLM models
      expect(screen.getByText('2')).toBeInTheDocument();
    });
  });
});
