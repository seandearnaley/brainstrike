import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePromptStore } from '../store';

const resetPromptStore = (): void => {
  const initial = usePromptStore.getState();
  usePromptStore.setState({
    prompts: [],
    categories: [...initial.categories],
    filter: { search: '', tags: [], favoritesOnly: false },
    selectedPromptId: null,
    isSidebarOpen: true,
  });
};

const createPromptInput = (categoryId = 'general') => ({
  title: 'Prompt title',
  content: 'Prompt content',
  categoryId,
  tags: ['test'],
  modelSettings: {
    model: 'openai:gpt-4o-mini',
    temperature: 0.2,
    topP: 1,
  },
  rating: 3,
  isFavorite: false,
  site: 'https://example.com',
});

const PROMPT_ID = '00000000-0000-0000-0000-000000000001';
const REVISION_ID = '00000000-0000-0000-0000-000000000002';
const CATEGORY_ID = '00000000-0000-0000-0000-000000000003';

describe('prompt-management store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetPromptStore();
  });

  it('adds, updates, rates, and favorites prompts', () => {
    const uuidSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(PROMPT_ID);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const store = usePromptStore.getState();

    store.addPrompt(createPromptInput());
    let prompt = usePromptStore.getState().prompts[0];
    expect(prompt?.id).toBe(PROMPT_ID);
    expect(prompt?.createdAt).toBe(1000);
    expect(prompt?.updatedAt).toBe(1000);
    expect(prompt?.revisions).toEqual([]);

    nowSpy.mockReturnValue(2000);
    store.updatePrompt(PROMPT_ID, { title: 'Updated title' });
    prompt = usePromptStore.getState().prompts[0];
    expect(prompt?.title).toBe('Updated title');
    expect(prompt?.updatedAt).toBe(2000);

    store.ratePrompt(PROMPT_ID, 5);
    prompt = usePromptStore.getState().prompts[0];
    expect(prompt?.rating).toBe(5);

    store.toggleFavorite(PROMPT_ID);
    expect(usePromptStore.getState().prompts[0]?.isFavorite).toBe(true);

    store.toggleFavorite('missing');
    expect(usePromptStore.getState().prompts).toHaveLength(1);

    uuidSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it('adds revisions and ignores unknown prompts', () => {
    const uuidSpy = vi.spyOn(crypto, 'randomUUID');
    uuidSpy.mockReturnValueOnce(PROMPT_ID).mockReturnValueOnce(REVISION_ID);
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValueOnce(3000);

    const store = usePromptStore.getState();
    store.addPrompt(createPromptInput());
    store.addRevision(PROMPT_ID, {
      content: 'Revised content',
      note: 'v2',
      modelSettings: {
        model: 'openai:gpt-4o-mini',
        temperature: 0.1,
        topP: 1,
      },
    });
    store.addRevision('missing', {
      content: 'Should not be added',
    });

    const revisions = usePromptStore.getState().prompts[0]?.revisions ?? [];
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toEqual(
      expect.objectContaining({
        id: REVISION_ID,
        content: 'Revised content',
        note: 'v2',
        timestamp: 3000,
      })
    );

    uuidSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it('deletes prompts and clears selection when needed', () => {
    const uuidSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(PROMPT_ID);
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const store = usePromptStore.getState();
    store.addPrompt(createPromptInput());
    store.setSelectedPromptId(PROMPT_ID);

    store.deletePrompt(PROMPT_ID);
    expect(usePromptStore.getState().prompts).toEqual([]);
    expect(usePromptStore.getState().selectedPromptId).toBeNull();

    uuidSpy.mockRestore();
  });

  it('manages categories and reassigns prompts when deleting a category', () => {
    const uuidSpy = vi.spyOn(crypto, 'randomUUID');
    uuidSpy.mockReturnValueOnce(CATEGORY_ID).mockReturnValueOnce(PROMPT_ID);
    vi.spyOn(Date, 'now').mockReturnValue(1000);

    const store = usePromptStore.getState();
    store.addCategory({
      name: 'Custom',
      color: '#123456',
      icon: 'Tag',
    });
    store.updateCategory(CATEGORY_ID, { name: 'Renamed' });
    expect(usePromptStore.getState().categories.find((c) => c.id === CATEGORY_ID)?.name).toBe(
      'Renamed'
    );

    store.addPrompt(createPromptInput(CATEGORY_ID));
    expect(usePromptStore.getState().prompts[0]?.categoryId).toBe(CATEGORY_ID);

    store.deleteCategory(CATEGORY_ID);
    expect(usePromptStore.getState().categories.find((c) => c.id === CATEGORY_ID)).toBeUndefined();
    expect(usePromptStore.getState().prompts[0]?.categoryId).toBe('general');

    uuidSpy.mockRestore();
  });

  it('updates filter, selection, and sidebar state', () => {
    const store = usePromptStore.getState();

    store.setFilter({ search: 'hello', tags: ['a'], favoritesOnly: true });
    expect(usePromptStore.getState().filter).toEqual({
      search: 'hello',
      tags: ['a'],
      favoritesOnly: true,
    });

    store.setFilter({ categoryId: 'coding' });
    expect(usePromptStore.getState().filter).toEqual({
      search: 'hello',
      tags: ['a'],
      favoritesOnly: true,
      categoryId: 'coding',
    });

    store.setSelectedPromptId('prompt-2');
    expect(usePromptStore.getState().selectedPromptId).toBe('prompt-2');

    store.toggleSidebar();
    expect(usePromptStore.getState().isSidebarOpen).toBe(false);
    store.toggleSidebar();
    expect(usePromptStore.getState().isSidebarOpen).toBe(true);
  });
});
