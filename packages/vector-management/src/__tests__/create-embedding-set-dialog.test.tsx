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
      modelId: 'text-embedding-3-small',
      providerId: 'openai',
      name: 'Text Embedding 3 Small',
      description: 'Efficient embedding model',
      capabilities: {
        type: 'embedding',
        defaultDimension: 1536,
      },
    },
    {
      id: 'local::Xenova/all-MiniLM-L6-v2',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      providerId: 'local',
      name: 'all-MiniLM-L6-v2',
      description: 'Local embedding model',
      capabilities: {
        type: 'embedding',
        defaultDimension: 384,
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

  it('renders correctly when open', async () => {
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
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByTestId('model-picker')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByLabelText(/Name/i)).toHaveValue('Text Embedding 3 Small');
    });
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

  it('calls onSetCreated with correct data when form is submitted', {
    timeout: 15_000,
  }, async () => {
    const user = userEvent.setup({ delay: null }); // Disable delay for faster tests
    const createdSet = { id: 'new-set-id' };
    (mockRepository.getOrCreateSet as Mock).mockResolvedValue(createdSet);

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
      expect(nameInput).toHaveValue('Text Embedding 3 Small');
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
      expect(mockOnSetCreated).toHaveBeenCalledWith('new-set-id', createdSet);
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

    // Wait for async initialization to complete (auto-fills name from model)
    const nameInput = screen.getByLabelText(/Name/i);
    await waitFor(() => {
      expect(nameInput).toHaveValue('Text Embedding 3 Small');
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
        { name: 'Text Embedding 3 Small' }, // Same as first model's display name
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
      expect(nameInput).toHaveValue('Text Embedding 3 Small (2)');
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
          { name: 'Text Embedding 3 Small' },
          { name: 'Text Embedding 3 Small (2)' },
          { name: 'Text Embedding 3 Small (3)' },
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
      expect(nameInput).toHaveValue('Text Embedding 3 Small (4)');
    });
  });

  it('submits the form when the user presses Enter inside an input', async () => {
    const user = userEvent.setup({ delay: null });
    (mockRepository.getOrCreateSet as Mock).mockResolvedValue({ id: 'enter-set-id' });

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

    const nameInput = screen.getByLabelText(/Name/i);
    await waitFor(() => {
      expect(nameInput).toHaveValue('Text Embedding 3 Small');
    });

    nameInput.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(mockRepository.getOrCreateSet).toHaveBeenCalled();
    });
  });

  it('renders the dialog with a constrained max-width so it never spans the full screen on desktop', () => {
    render(
      <CreateEmbeddingSetDialog
        models={mockModels}
        onOpenChange={mockOnOpenChange}
        onSetCreated={mockOnSetCreated}
        open={true}
        providers={mockProviders}
        repository={mockRepository}
      />
    );

    // Find the dialog content by role; it should have a sm:max-w utility that
    // caps the panel below 600px so it never renders edge-to-edge on a wide viewport.
    const dialogContent = screen.getByRole('dialog');
    const className = dialogContent.className;
    expect(className).toMatch(/sm:max-w-\[(?:[1-5]\d{2})px\]|sm:max-w-(?:sm|md|lg)/);
  });

  // Layout-shift guard: the model description below the picker is conditional and used to
  // change the form's height when the user picked a local model. The slot must reserve
  // vertical space (min-h) so swapping models can never push subsequent fields down.
  it('reserves a fixed-height slot beneath the model picker so changing models does not shift layout', async () => {
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

    // The slot should be present even when no model description is rendered;
    // identifiable via a stable test id and carry a min-h utility.
    const slot = await screen.findByTestId('model-picker-description-slot');
    expect(slot.className).toMatch(/min-h-\[/);
  });

  it('seeds the name input synchronously on open (no empty-then-populate flash)', () => {
    // Render with the dialog already open. Do NOT use async findBy/waitFor —
    // if there's a flash, the name will be empty on the first paint and this
    // test will fail. The first-paint value must already be the model name.
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

    // Synchronous query: the name should already be filled from the first model.
    const nameInput = screen.getByLabelText(/Name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Text Embedding 3 Small');
  });

  it('updates the auto-generated name when the user changes models without having typed', async () => {
    const user = userEvent.setup({ delay: null });
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

    const nameInput = screen.getByLabelText(/Name/i) as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe('Text Embedding 3 Small'));

    // User changes the model BEFORE typing — name should track the new model.
    await user.selectOptions(
      screen.getByTestId('model-picker-select'),
      'local::Xenova/all-MiniLM-L6-v2'
    );
    expect(nameInput.value).toBe('all-MiniLM-L6-v2');
  });

  // P1 regression: when findAll() is slow, the async refinement used to capture
  // `nameDirty: false` and `models[0]` at open-time, then dispatch later. If the
  // user typed a custom name (or switched models) in that window, the late
  // dispatch would clobber their input. Reducer must check live state instead.
  it('does not overwrite a name the user typed during a slow findAll()', async () => {
    let resolveFindAll: (collections: { name: string }[]) => void = () => {};
    const slowFindAll = new Promise<{ name: string }[]>((resolve) => {
      resolveFindAll = resolve;
    });
    const slowRepository = {
      getOrCreateSet: vi.fn(),
      findAll: vi.fn().mockReturnValue(slowFindAll),
    } as unknown as IEmbeddingSetsRepository;

    const user = userEvent.setup({ delay: null });
    render(
      <>
        <Toaster />
        <CreateEmbeddingSetDialog
          models={mockModels}
          onOpenChange={mockOnOpenChange}
          onSetCreated={mockOnSetCreated}
          open={true}
          providers={mockProviders}
          repository={slowRepository}
        />
      </>
    );

    // Phase-1 sync seed gives us the initial auto-name immediately.
    const nameInput = screen.getByLabelText(/Name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Text Embedding 3 Small');

    // User types a custom name BEFORE findAll() resolves.
    await user.clear(nameInput);
    await user.type(nameInput, 'My Custom Collection');
    expect(nameInput.value).toBe('My Custom Collection');

    // findAll() resolves with names that would normally bump the auto-name to "(2)".
    // The late refinement must NOT clobber the user's typed value.
    resolveFindAll([{ name: 'Text Embedding 3 Small' }]);
    // Drain the microtask queue so the effect's async resumes and any (buggy)
    // refine dispatch lands. Then assert the user's input survived.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(nameInput.value).toBe('My Custom Collection');
  });

  // P1 sibling case: same race, but user changes the model instead of typing.
  // The refinement was computed against the original models[0] but should not
  // apply if the currently-selected model has changed.
  it('does not overwrite the auto-name with a different model when findAll() lands late', async () => {
    let resolveFindAll: (collections: { name: string }[]) => void = () => {};
    const slowFindAll = new Promise<{ name: string }[]>((resolve) => {
      resolveFindAll = resolve;
    });
    const slowRepository = {
      getOrCreateSet: vi.fn(),
      findAll: vi.fn().mockReturnValue(slowFindAll),
    } as unknown as IEmbeddingSetsRepository;

    const user = userEvent.setup({ delay: null });
    render(
      <>
        <Toaster />
        <CreateEmbeddingSetDialog
          models={mockModels}
          onOpenChange={mockOnOpenChange}
          onSetCreated={mockOnSetCreated}
          open={true}
          providers={mockProviders}
          repository={slowRepository}
        />
      </>
    );

    const nameInput = screen.getByLabelText(/Name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Text Embedding 3 Small');

    // User switches models BEFORE findAll() resolves. The auto-name follows.
    await user.selectOptions(
      screen.getByTestId('model-picker-select'),
      'local::Xenova/all-MiniLM-L6-v2'
    );
    expect(nameInput.value).toBe('all-MiniLM-L6-v2');

    // The captured "first model" was openai. findAll() resolves and returns a
    // collision against that name. The refinement must NOT roll the picker
    // back to "Text Embedding 3 Small (2)".
    resolveFindAll([{ name: 'Text Embedding 3 Small' }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(nameInput.value).toBe('all-MiniLM-L6-v2');
  });

  it('preserves a manually-edited name when the user changes models', async () => {
    const user = userEvent.setup({ delay: null });
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

    const nameInput = screen.getByLabelText(/Name/i) as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe('Text Embedding 3 Small'));

    // User types — flips isDirty.
    await user.clear(nameInput);
    await user.type(nameInput, 'My Custom Collection');
    expect(nameInput.value).toBe('My Custom Collection');

    // Switching models must NOT clobber the user's name.
    await user.selectOptions(
      screen.getByTestId('model-picker-select'),
      'local::Xenova/all-MiniLM-L6-v2'
    );
    expect(nameInput.value).toBe('My Custom Collection');
  });

  it('does not render the padlock / cost badge under the model picker for any model', async () => {
    // Models cover both cases: a hosted model with a price AND a local model.
    // The slot must never render the badge prefix in either case.
    const modelsWithPrice: ModelPickerModel[] = [
      {
        id: 'openai::text-embedding-3-small',
        modelId: 'text-embedding-3-small',
        providerId: 'openai',
        name: 'Text Embedding 3 Small',
        description: 'Efficient embedding model',
        pricePer1MTokensInput: 0.02,
        capabilities: { type: 'embedding', defaultDimension: 1536 },
      },
      {
        id: 'local::Xenova/all-MiniLM-L6-v2',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        providerId: 'local',
        name: 'all-MiniLM-L6-v2',
        description: 'Local embedding model',
        capabilities: { type: 'embedding', defaultDimension: 384 },
      },
    ];

    const user = userEvent.setup({ delay: null });
    render(
      <>
        <Toaster />
        <CreateEmbeddingSetDialog
          models={modelsWithPrice}
          onOpenChange={mockOnOpenChange}
          onSetCreated={mockOnSetCreated}
          open={true}
          providers={mockProviders}
          repository={mockRepository}
        />
      </>
    );

    await screen.findByDisplayValue('Text Embedding 3 Small');
    const slot = screen.getByTestId('model-picker-description-slot');

    // Hosted model with a price: must NOT show the cost badge.
    expect(slot.textContent ?? '').not.toMatch(/🔒|💰|Free \(local\)|\/1M tokens/);

    // Switch to the local model — must NOT show the padlock badge either.
    await user.selectOptions(
      screen.getByTestId('model-picker-select'),
      'local::Xenova/all-MiniLM-L6-v2'
    );
    expect(slot.textContent ?? '').not.toMatch(/🔒|💰|Free \(local\)|\/1M tokens/);
  });

  it('gives the dialog header right-side gutter so the close X cannot overlap the title', () => {
    render(
      <CreateEmbeddingSetDialog
        models={mockModels}
        onOpenChange={mockOnOpenChange}
        onSetCreated={mockOnSetCreated}
        open={true}
        providers={mockProviders}
        repository={mockRepository}
      />
    );

    // shadcn/ui's DialogPrimitive.Close is positioned `top-4 right-4`. The
    // dialog title needs its own right padding so long titles never collide
    // with the close button.
    const title = screen.getByText('Create Search Collection');
    const header = title.closest('[data-slot="dialog-header"]') as HTMLElement | null;
    expect(header).not.toBeNull();
    expect((header as HTMLElement).className).toMatch(/pr-(?:8|9|10|12)/);
  });

  it('persists the raw provider model id for local registry models', async () => {
    const user = userEvent.setup({ delay: null });
    (mockRepository.getOrCreateSet as Mock).mockResolvedValue({ id: 'new-local-set-id' });

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

    await waitFor(() => {
      expect(screen.getByLabelText(/Name/i)).toHaveValue('Text Embedding 3 Small');
    });

    await user.selectOptions(
      screen.getByTestId('model-picker-select'),
      'local::Xenova/all-MiniLM-L6-v2'
    );
    await user.click(screen.getByText('Create Collection'));

    expect(mockRepository.getOrCreateSet).toHaveBeenCalledWith(
      'local::Xenova/all-MiniLM-L6-v2',
      'Xenova/all-MiniLM-L6-v2',
      384,
      'cosine',
      // The user did not type in the name field, so the auto-name follows the
      // newly selected local model.
      expect.objectContaining({
        name: 'all-MiniLM-L6-v2',
      })
    );
  });
});
