import type { IEmbeddingSetsRepository } from '@brainstrike/db';
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
    findAll: vi.fn().mockResolvedValue([]),
  } as unknown as IEmbeddingSetsRepository;

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

  it(
    'calls onSetCreated with correct data when form is submitted',
    { timeout: 15_000 },
    async () => {
      const user = userEvent.setup({ delay: null }); // Disable delay for faster tests
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

      // Wait for async initialization to complete (auto-fills name from model)
      const nameInput = screen.getByLabelText(/Name/i);
      await waitFor(() => {
        expect(nameInput).toHaveValue('text-embedding-3-small');
      });

      // Clear auto-filled name and type custom name
      await user.clear(nameInput);
      await user.type(nameInput, 'My Collection');

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
    }
  );

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

    // Wait for async initialization to complete (auto-fills name from model)
    const nameInput = screen.getByLabelText(/Name/i);
    await waitFor(() => {
      expect(nameInput).toHaveValue('text-embedding-3-small');
    });

    // Clear the auto-filled name to test validation
    await user.clear(nameInput);

    // Verify the name is now empty
    expect(nameInput).toHaveValue('');

    // Try to submit without name - button should be disabled
    const submitButton = screen.getByText('Create Collection');
    expect(submitButton).toBeDisabled();

    // Even if we try to click, it shouldn't call the repository
    expect(mockRepository.getOrCreateSet).not.toHaveBeenCalled();
  });

  it('auto-generates unique name when existing collection has same name', async () => {
    // Mock repository returns an existing collection with the same name as the first model
    const mockRepositoryWithExisting = {
      getOrCreateSet: vi.fn(),
      findAll: vi.fn().mockResolvedValue([
        { name: 'text-embedding-3-small' }, // Same as first model's name
      ]),
    } as unknown as IEmbeddingSetsRepository;

    render(
      <>
        <Toaster />
        <CreateEmbeddingSetDialog
          models={mockModels}
          onOpenChange={mockOnOpenChange}
          onSetCreated={mockOnSetCreated}
          open={true}
          providers={mockProviders}
          repository={mockRepositoryWithExisting}
        />
      </>
    );

    // Wait for async initialization - should auto-fill with "(2)" suffix due to collision
    const nameInput = screen.getByLabelText(/Name/i);
    await waitFor(() => {
      expect(nameInput).toHaveValue('text-embedding-3-small (2)');
    });
  });

  it('auto-generates incremented unique name with multiple collisions', async () => {
    // Mock repository returns multiple existing collections with incrementing names
    const mockRepositoryWithMultiple = {
      getOrCreateSet: vi.fn(),
      findAll: vi
        .fn()
        .mockResolvedValue([
          { name: 'text-embedding-3-small' },
          { name: 'text-embedding-3-small (2)' },
          { name: 'text-embedding-3-small (3)' },
        ]),
    } as unknown as IEmbeddingSetsRepository;

    render(
      <>
        <Toaster />
        <CreateEmbeddingSetDialog
          models={mockModels}
          onOpenChange={mockOnOpenChange}
          onSetCreated={mockOnSetCreated}
          open={true}
          providers={mockProviders}
          repository={mockRepositoryWithMultiple}
        />
      </>
    );

    // Wait for async initialization - should auto-fill with "(4)" suffix
    const nameInput = screen.getByLabelText(/Name/i);
    await waitFor(() => {
      expect(nameInput).toHaveValue('text-embedding-3-small (4)');
    });
  });
});
