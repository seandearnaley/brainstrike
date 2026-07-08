import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  useTheme: () => ({ setTheme: mockSetTheme, theme: mockTheme }),
}));

const providers: ModelPickerProvider[] = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
];

const models: ModelPickerModel[] = [
  { capabilities: { type: 'llm' }, id: 'gpt-5.2', name: 'GPT-5.2', providerId: 'openai' },
  {
    capabilities: { type: 'llm' },
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    providerId: 'anthropic',
  },
  {
    capabilities: { type: 'embedding' },
    id: 'text-embedding',
    name: 'Text Embedding',
    providerId: 'openai',
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
      expect(screen.getByText('GPT-5.2')).toBeInTheDocument();
      expect(screen.getByText('Claude Sonnet 4.6')).toBeInTheDocument();
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
      fireEvent.click(screen.getByText('GPT-5.2'));
      expect(onChange).toHaveBeenCalledWith('gpt-5.2');
    });

    it('displays selected model in trigger', () => {
      render(<ModelPicker models={models} providers={providers} value="gpt-5.2" />);
      expect(screen.getByText('GPT-5.2')).toBeInTheDocument();
    });

    it('handles multi-select mode - adds selection', () => {
      const onChange = vi.fn();
      render(
        <ModelPicker mode="multi" models={models} onChange={onChange} providers={providers} />
      );
      fireEvent.click(screen.getByRole('combobox'));
      fireEvent.click(screen.getByText('GPT-5.2'));
      expect(onChange).toHaveBeenCalledWith(['gpt-5.2']);
    });

    it('handles multi-select with existing value', () => {
      render(
        <ModelPicker mode="multi" models={models} providers={providers} value={['gpt-5.2']} />
      );
      // Trigger should show the selected model
      expect(screen.getByText('GPT-5.2')).toBeInTheDocument();
    });

    it('handles multi-select with multiple selections', () => {
      const onChange = vi.fn();
      render(
        <ModelPicker
          mode="multi"
          models={models}
          onChange={onChange}
          providers={providers}
          value={['gpt-5.2']}
        />
      );
      fireEvent.click(screen.getByRole('combobox'));
      fireEvent.click(screen.getByText('Claude Sonnet 4.6'));
      expect(onChange).toHaveBeenCalledWith(['gpt-5.2', 'claude-sonnet-4-6']);
    });

    it('displays count for multiple selections', () => {
      render(
        <ModelPicker
          mode="multi"
          models={models}
          providers={providers}
          value={['gpt-5.2', 'claude-sonnet-4-6']}
        />
      );
      expect(screen.getByText('GPT-5.2')).toBeInTheDocument();
      expect(screen.getByText('(+1)')).toBeInTheDocument();
    });
  });

  describe('filtering', () => {
    it('filters models by type when modelType is llm', () => {
      render(<ModelPicker models={models} modelType="llm" providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByText('GPT-5.2')).toBeInTheDocument();
      expect(screen.queryByText('Text Embedding')).not.toBeInTheDocument();
    });

    it('filters models by type when modelType is embedding', () => {
      render(<ModelPicker models={models} modelType="embedding" providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByText('Text Embedding')).toBeInTheDocument();
      expect(screen.queryByText('GPT-5.2')).not.toBeInTheDocument();
    });

    it('shows all models when modelType is all', () => {
      render(<ModelPicker models={models} modelType="all" providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByText('GPT-5.2')).toBeInTheDocument();
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
        expect(screen.getByText('Claude Sonnet 4.6')).toBeInTheDocument();
        expect(screen.queryByText('GPT-5.2')).not.toBeInTheDocument();
      });
    });
  });

  describe('theme handling', () => {
    it('handles light theme', () => {
      mockTheme = 'light';
      render(<ModelPicker models={models} providers={providers} value="gpt-5.2" />);
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('handles dark theme', () => {
      mockTheme = 'dark';
      render(<ModelPicker models={models} providers={providers} value="gpt-5.2" />);
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('handles system theme with light preference', () => {
      mockTheme = 'system';
      const matchMedia = vi.fn().mockImplementation(() => ({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      }));
      window.matchMedia = matchMedia;

      render(<ModelPicker models={models} providers={providers} value="gpt-5.2" />);
      expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    });

    it('handles system theme with dark preference', () => {
      mockTheme = 'system';
      const matchMedia = vi.fn().mockImplementation(() => ({
        addEventListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
      }));
      window.matchMedia = matchMedia;

      render(<ModelPicker models={models} providers={providers} value="gpt-5.2" />);
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
          value="gpt-5.2"
        />
      );
      expect(renderTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          disabled: true,
          models,
          placeholder: 'Select',
          providers,
          value: 'gpt-5.2',
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
      // OpenAI has 1 LLM model
      const openAiHeading = screen.getByText('OpenAI').closest('div');
      expect(openAiHeading).not.toBeNull();
      expect(within(openAiHeading as HTMLElement).getByText('1')).toBeInTheDocument();
    });
  });

  describe('local embedding models (BST-299 regression)', () => {
    // Test data that mimics what ManageEmbeddingSetsDialog produces
    const localEmbeddingModels: ModelPickerModel[] = [
      {
        capabilities: { defaultDimension: 384, type: 'embedding' },
        id: 'Xenova/all-MiniLM-L6-v2',
        name: 'all-MiniLM-L6-v2',
        providerId: 'local',
      },
      {
        capabilities: { defaultDimension: 384, type: 'embedding' },
        id: 'Xenova/bge-small-en-v1.5',
        name: 'BGE Small',
        providerId: 'local',
      },
      {
        capabilities: { defaultDimension: 1536, type: 'embedding' },
        id: 'openai::text-embedding-3-small',
        name: 'Text Embedding 3 Small',
        providerId: 'openai',
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

  describe('layering and responsiveness (dialog regression)', () => {
    // The model picker is opened from inside Radix Dialogs (e.g. CreateSearchCollection).
    // Dialog content sits at z-[51] above its z-50 overlay, so the popover must stack
    // above z-[51] or its items render behind the dialog and become unclickable in real browsers.
    it('renders popover content above the dialog content stacking floor', () => {
      render(<ModelPicker models={models} providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));

      const popover = document.querySelector('[data-slot="popover-content"]');
      expect(popover).not.toBeNull();
      const className = (popover as HTMLElement).className;

      // Must explicitly opt out of the default z-50 (which is below dialog content z-[51])
      expect(className).toMatch(/z-\[(5[2-9]|[6-9]\d|1\d{2,})\]/);
    });

    // The popover is fixed at w-[400px] which overflows narrow viewports (mobile/tablet portrait).
    // It must cap to viewport width so the dropdown never extends off-screen.
    it('caps popover width to the viewport on narrow screens', () => {
      render(<ModelPicker models={models} providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));

      const popover = document.querySelector('[data-slot="popover-content"]');
      expect(popover).not.toBeNull();
      const className = (popover as HTMLElement).className;

      // The popover must be bounded by the viewport — either via max-w-[...vw...]
      // or via a w-[...] expression that includes a viewport unit (e.g. min(400px,calc(100vw-2rem))).
      expect(className).toMatch(/(?:max-w|w)-\[(?:[^\]]*v[wh]|calc\([^\]]*v[wh])/);
    });

    // Popover modal=true conflicts with parent Dialog modal=true (FocusScope fights).
    // The picker should run its popover non-modally so the dialog owns focus.
    it('renders popover non-modal so it composes inside parent Dialogs', () => {
      render(<ModelPicker models={models} providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));

      // When Radix Popover is non-modal, it does NOT mark sibling content with aria-hidden,
      // and it does NOT add a body scroll lock. Easiest check: the popover content does
      // not get the data-aria-hidden attribute that modal popovers apply.
      const popover = document.querySelector('[data-slot="popover-content"]');
      expect(popover).not.toBeNull();
      // Modal Radix popovers add a `data-aria-hidden` attribute on outside elements; non-modal does not.
      // Use a more robust check: the popover content should be focusable but body should not have
      // pointer-events:none locked by Radix's RemoveScroll wrapper.
      expect(document.body.style.pointerEvents).not.toBe('none');
    });

    // The popover MUST NOT render inside Radix's body-level Portal when used
    // under a modal Dialog. The dialog's RemoveScroll wraps a fixed DOM target
    // and discards wheel events on anything portaled outside that target,
    // which made the dropdown impossible to scroll. Rendering in-tree (with
    // floating-ui position:fixed) keeps the popover inside the dialog's
    // RemoveScroll allow-list so the wheel works.
    it('does not portal popover content to document.body (so it inherits Dialog scroll allowance)', () => {
      const { container } = render(<ModelPicker models={models} providers={providers} />);
      fireEvent.click(screen.getByRole('combobox'));

      const popover = document.querySelector('[data-slot="popover-content"]');
      expect(popover).not.toBeNull();

      // The render's container is detached from document.body in JSDOM only as a
      // descendant. If the popover is portaled to body, it's a sibling of the
      // render container, not a descendant. We assert it's a descendant.
      expect(container.contains(popover)).toBe(true);
    });
  });
});
