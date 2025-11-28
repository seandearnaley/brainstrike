import { Inbox } from 'lucide-react';
import { useMemo } from 'react';
import { ScrollArea } from '../../scroll-area';
import type { Category, Prompt, PromptFilter } from '../types';
import { PromptCard } from './prompt-card';

interface PromptListProps {
  prompts: Prompt[];
  categories: Category[];
  filter: PromptFilter;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onCopy: (content: string) => void;
}

export function PromptList({
  prompts,
  categories,
  filter,
  onEdit,
  onDelete,
  onToggleFavorite,
  onCopy,
}: PromptListProps) {
  const safePrompts = Array.isArray(prompts) ? prompts : [];
  const filteredPrompts = useMemo(() => filterPrompts(safePrompts, filter), [safePrompts, filter]);

  if (filteredPrompts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground opacity-50">
        <Inbox className="w-16 h-16 mb-4 stroke-1" />
        <p className="text-lg font-medium">No prompts found</p>
        <p className="text-sm">Try adjusting your filters or create a new prompt.</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 pb-20">
        {filteredPrompts.map((prompt) => (
          <PromptCard
            key={prompt.id}
            prompt={prompt}
            category={categories.find((c) => c.id === prompt.categoryId) ?? categories[0]} // Fallback to first category (General)
            onEdit={onEdit}
            onDelete={onDelete}
            onToggleFavorite={onToggleFavorite}
            onCopy={onCopy}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function filterPrompts(prompts: Prompt[], filter: PromptFilter): Prompt[] {
  return prompts.filter((prompt) => {
    // Filter by search
    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      const matchesSearch =
        prompt.title.toLowerCase().includes(searchLower) ||
        prompt.content.toLowerCase().includes(searchLower) ||
        prompt.tags.some((tag) => tag.toLowerCase().includes(searchLower));

      if (!matchesSearch) return false;
    }

    // Filter by category
    if (filter.categoryId && prompt.categoryId !== filter.categoryId) return false;

    // Filter by favorites
    if (filter.favoritesOnly && !prompt.isFavorite) return false;

    // Filter by tags
    if (filter.tags.length > 0 && !filter.tags.every((tag) => prompt.tags.includes(tag))) {
      return false;
    }

    return true;
  });
}
