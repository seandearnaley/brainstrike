import type { EmbeddingSetsRepository } from '@brainstrike/db';
import { type ModelPickerModel, type ModelPickerProvider, Toaster } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { CreateEmbeddingSetDialog } from '../embedding-set-management/create-embedding-set-dialog';

// Mock dependencies
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    // Mock ModelPicker to make it easier to test interactions
    ModelPicker: ({
      models,
      onChange,
      disabled,
      placeholder,
    }: {
      models: ModelPickerModel[];
      onChange: (val: string) => void;
      disabled: boolean;
      placeholder: string;
    }) => (
      <div data-testid="model-picker">
        <div data-testid="model-picker-placeholder">{placeholder}</div>
        <select
          data-testid="model-picker-select"
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Select a model</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
    ),
  };
});

describe('CreateEmbeddingSetDialog', () => {
  const mockOnOpenChange = vi.fn();
  const mockOnSetCreated = vi.fn();
  const mockRepository = {
    getOrCreateSet: vi.fn(),
  } as unknown as EmbeddingSetsRepository;

  const mockModels: ModelPickerModel[] = [
    {
      id: 'openai::text-embedding-3-small',
      providerId: 'openai',
      name: 'text-embedding-3-small',
      description: 'Efficient embedding model',
      capabilities: {
        type: 'embedding',
        defaultDimension: 1536,
      },
    },
    {
      id: 'local::jina-embeddings-v2-base-en',
      providerId: 'local',
      name: 'jina-embeddings-v2-base-en',
      description: 'Local embedding model',
      capabilities: {
        type: 'embedding',
        defaultDimension: 768,
      },
    },
  ];

  const mockProviders: ModelPickerProvider[] = [
    { id: 'openai', name: 'OpenAI' },
    { id: 'local', name: 'Local' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders correctly when open', () => {
    render(
      <>
        <Toaster />
        <CreateEmbeddingSetDialog
          models={mockModels}
          onOpenChange={mockOnOpenChange}
          onSetCreated={mockOnSetCreated}
          open={true}
          providers={mockProviders}
          repository={mockRepository}
        />
      </>
    );

    expect(screen.getByText('Create Search Collection')).toBeInTheDocument();
    expect(screen.getByText('Model Configuration')).toBeInTheDocument();
    expect(screen.getByTestId('model-picker')).toBeInTheDocument();
  });

  it('shows loading state when isLoading is true', () => {
    render(
      <CreateEmbeddingSetDialog
        isLoading={true}
        models={[]}
        onOpenChange={mockOnOpenChange}
        onSetCreated={mockOnSetCreated}
        open={true}
        providers={[]}
        repository={mockRepository}
      />
    );

    expect(screen.getByTestId('model-picker-placeholder')).toHaveTextContent('Loading models...');
    expect(screen.getByTestId('model-picker-select')).toBeDisabled();
  });

  it('calls onSetCreated with correct data when form is submitted', async () => {
    const user = userEvent.setup();
    (mockRepository.getOrCreateSet as Mock).mockResolvedValue({ id: 'new-set-id' });

    render(
      <>
        <Toaster />
        <CreateEmbeddingSetDialog
          models={mockModels}
          onOpenChange={mockOnOpenChange}
          onSetCreated={mockOnSetCreated}
          open={true}
          providers={mockProviders}
          repository={mockRepository}
        />
      </>
    );

    // Fill out form
    await user.type(screen.getByLabelText(/Name/i), 'My Collection');

    // Select model (using our mock select)
    await user.selectOptions(
      screen.getByTestId('model-picker-select'),
      'openai::text-embedding-3-small'
    );

    // Submit
    await user.click(screen.getByText('Create Collection'));

    // Verify repository call
    expect(mockRepository.getOrCreateSet).toHaveBeenCalledWith(
      'openai::text-embedding-3-small',
      'text-embedding-3-small',
      1536,
      'cosine',
      expect.objectContaining({
        name: 'My Collection',
      })
    );

    // Verify callback
    await waitFor(() => {
      expect(mockOnSetCreated).toHaveBeenCalledWith('new-set-id');
    });
  });

  it('validates required fields', async () => {
    const user = userEvent.setup();

    render(
      <>
        <Toaster />
        <CreateEmbeddingSetDialog
          models={mockModels}
          onOpenChange={mockOnOpenChange}
          onSetCreated={mockOnSetCreated}
          open={true}
          providers={mockProviders}
          repository={mockRepository}
        />
      </>
    );

    // Try to submit without name
    await user.click(screen.getByText('Create Collection'));

    expect(mockRepository.getOrCreateSet).not.toHaveBeenCalled();
    // Toast should appear (difficult to test exact toast content without more setup, but we verify no call)
  });
});
