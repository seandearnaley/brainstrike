import { LayoutGrid, Plus, Search, Settings2, Star } from 'lucide-react';
import { Button } from '../../button';
import { Input } from '../../input';
import { cn } from '../../lib/utils';
import { ScrollArea } from '../../scroll-area';
import type { Category, PromptFilter } from '../types';

interface SidebarProps {
  categories: Category[];
  className?: string;
  filter: PromptFilter;
  onAddPrompt: () => void;
  onFilterChange: (updates: Partial<PromptFilter>) => void;
}

export function Sidebar({
  categories,
  filter,
  onFilterChange,
  onAddPrompt,
  className,
}: SidebarProps) {
  return (
    <div className={cn('flex h-full flex-col border-border/50 border-r bg-muted/10', className)}>
      <div className="space-y-4 p-4">
        <Button
          className="w-full bg-primary shadow-md shadow-primary/20 transition-all hover:scale-[1.02] hover:bg-primary/90"
          onClick={onAddPrompt}
        >
          <Plus className="mr-2 h-4 w-4" />
          New Prompt
        </Button>

        <div className="relative">
          <Search className="absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="border-border/50 bg-background/50 pl-9 transition-colors focus:bg-background"
            onChange={(e) => onFilterChange({ search: e.target.value })}
            placeholder="Search prompts..."
            value={filter.search}
          />
        </div>
      </div>

      <ScrollArea className="flex-1 px-2">
        <div className="space-y-1 p-2">
          <Button
            className="w-full justify-start font-normal"
            onClick={() => onFilterChange({ categoryId: null, favoritesOnly: false })}
            variant={filter.categoryId || filter.favoritesOnly ? 'ghost' : 'secondary'}
          >
            <LayoutGrid className="mr-2 h-4 w-4" />
            All Prompts
          </Button>

          <Button
            className="w-full justify-start font-normal"
            onClick={() => onFilterChange({ favoritesOnly: true, categoryId: null })}
            variant={filter.favoritesOnly ? 'secondary' : 'ghost'}
          >
            <Star className="mr-2 h-4 w-4 text-yellow-500" />
            Favorites
          </Button>
        </div>

        <div className="my-2 px-4">
          <div className="h-[1px] bg-border/50" />
        </div>

        <div className="px-4 py-2 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          Categories
        </div>

        <div className="space-y-1 p-2">
          {Array.isArray(categories) &&
            categories.map((category) => (
              <Button
                className="group w-full justify-start font-normal"
                key={category.id}
                onClick={() => onFilterChange({ categoryId: category.id, favoritesOnly: false })}
                variant={filter.categoryId === category.id ? 'secondary' : 'ghost'}
              >
                <span
                  className="mr-3 h-2 w-2 rounded-full transition-transform group-hover:scale-125"
                  style={{ backgroundColor: category.color }}
                />
                {category.name}
              </Button>
            ))}
        </div>

        <div className="my-2 px-4">
          <div className="h-[1px] bg-border/50" />
        </div>

        {/* Placeholder for tags or other filters */}
        <div className="flex items-center justify-between px-4 py-2 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          <span>Tags</span>
          <Button
            aria-label="Add tag"
            className="h-4 w-4"
            size="icon"
            title="Add tag"
            variant="ghost"
          >
            <Plus aria-hidden="true" className="h-3 w-3" />
          </Button>
        </div>

        <div className="p-2 text-center text-muted-foreground text-sm italic opacity-50">
          No tags yet
        </div>
      </ScrollArea>

      <div className="border-border/50 border-t p-4">
        <Button className="w-full justify-start text-muted-foreground" variant="ghost">
          <Settings2 className="mr-2 h-4 w-4" />
          Settings
        </Button>
      </div>
    </div>
  );
}
