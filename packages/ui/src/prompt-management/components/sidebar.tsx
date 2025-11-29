import { LayoutGrid, Plus, Search, Settings2, Star } from 'lucide-react';
import { Button } from '../../button';
import { Input } from '../../input';
import { cn } from '../../lib/utils';
import { ScrollArea } from '../../scroll-area';
import type { Category, PromptFilter } from '../types';

interface SidebarProps {
  categories: Category[];
  filter: PromptFilter;
  onFilterChange: (updates: Partial<PromptFilter>) => void;
  onAddPrompt: () => void;
  className?: string;
}

export function Sidebar({
  categories,
  filter,
  onFilterChange,
  onAddPrompt,
  className,
}: SidebarProps) {
  return (
    <div className={cn('flex flex-col h-full bg-muted/10 border-r border-border/50', className)}>
      <div className="p-4 space-y-4">
        <Button
          onClick={onAddPrompt}
          className="w-full bg-primary hover:bg-primary/90 shadow-md shadow-primary/20 transition-all hover:scale-[1.02]"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Prompt
        </Button>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search prompts..."
            className="pl-9 bg-background/50 border-border/50 focus:bg-background transition-colors"
            value={filter.search}
            onChange={(e) => onFilterChange({ search: e.target.value })}
          />
        </div>
      </div>

      <ScrollArea className="flex-1 px-2">
        <div className="space-y-1 p-2">
          <Button
            variant={!filter.categoryId && !filter.favoritesOnly ? 'secondary' : 'ghost'}
            className="w-full justify-start font-normal"
            onClick={() => onFilterChange({ categoryId: null, favoritesOnly: false })}
          >
            <LayoutGrid className="w-4 h-4 mr-2" />
            All Prompts
          </Button>

          <Button
            variant={filter.favoritesOnly ? 'secondary' : 'ghost'}
            className="w-full justify-start font-normal"
            onClick={() => onFilterChange({ favoritesOnly: true, categoryId: null })}
          >
            <Star className="w-4 h-4 mr-2 text-yellow-500" />
            Favorites
          </Button>
        </div>

        <div className="my-2 px-4">
          <div className="h-[1px] bg-border/50" />
        </div>

        <div className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Categories
        </div>

        <div className="space-y-1 p-2">
          {Array.isArray(categories) &&
            categories.map((category) => (
              <Button
                key={category.id}
                variant={filter.categoryId === category.id ? 'secondary' : 'ghost'}
                className="w-full justify-start font-normal group"
                onClick={() => onFilterChange({ categoryId: category.id, favoritesOnly: false })}
              >
                <span
                  className="w-2 h-2 rounded-full mr-3 transition-transform group-hover:scale-125"
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
        <div className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex justify-between items-center">
          <span>Tags</span>
          <Button variant="ghost" size="icon" className="h-4 w-4">
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        <div className="p-2 text-sm text-muted-foreground text-center italic opacity-50">
          No tags yet
        </div>
      </ScrollArea>

      <div className="p-4 border-t border-border/50">
        <Button variant="ghost" className="w-full justify-start text-muted-foreground">
          <Settings2 className="w-4 h-4 mr-2" />
          Settings
        </Button>
      </div>
    </div>
  );
}
