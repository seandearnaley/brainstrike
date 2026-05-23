import { Inbox } from 'lucide-react';
import { useMemo } from 'react';
import { ScrollArea } from '../../scroll-area';
import { TooltipProvider } from '../../tooltip';
import type { Category, Prompt, PromptFilter } from '../types';
import { PromptCard } from './prompt-card';

interface PromptListProps {
  categories: Category[];
  filter: PromptFilter;
  onCopy: (content: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  prompts: Prompt[];
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
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground opacity-50">
        <Inbox className="mb-4 h-16 w-16 stroke-1" />
        <p className="font-medium text-lg">No prompts found</p>
        <p className="text-sm">Try adjusting your filters or create a new prompt.</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <TooltipProvider delayDuration={300}>
        <div className="grid grid-cols-1 gap-6 p-6 pb-20 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredPrompts.map((prompt) => (
            <PromptCard
              category={categories.find((c) => c.id === prompt.categoryId) ?? categories[0]}
              key={prompt.id}
              onCopy={onCopy} // Fallback to first category (General)
              onDelete={onDelete}
              onEdit={onEdit}
              onToggleFavorite={onToggleFavorite}
              prompt={prompt}
            />
          ))}
        </div>
      </TooltipProvider>
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

      if (!matchesSearch) {
        return false;
      }
    }

    // Filter by category
    if (filter.categoryId && prompt.categoryId !== filter.categoryId) {
      return false;
    }

    // Filter by favorites
    if (filter.favoritesOnly && !prompt.isFavorite) {
      return false;
    }

    // Filter by tags
    if (filter.tags.length > 0 && !filter.tags.every((tag) => prompt.tags.includes(tag))) {
      return false;
    }

    return true;
  });
}
