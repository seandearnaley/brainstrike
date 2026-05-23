import { Calendar, Copy, Edit2, Globe, MoreVertical, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Card, CardContent, CardFooter, CardHeader } from '../..';
import { Badge } from '../../badge';
import { Button } from '../../button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../dropdown-menu';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../tooltip';
import type { Category, Prompt } from '../types';

interface PromptCardProps {
  category?: Category | undefined;
  onCopy: (content: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  prompt: Prompt;
}

export function PromptCard({
  prompt,
  category,
  onEdit,
  onDelete,
  onToggleFavorite,
  onCopy,
}: PromptCardProps) {
  const updatedAt = new Date(prompt.updatedAt);
  const [isMoreOptionsOpen, setIsMoreOptionsOpen] = useState(false);
  const [isMoreOptionsTooltipOpen, setIsMoreOptionsTooltipOpen] = useState(false);
  // Keep the tooltip suppressed after menu close until the pointer leaves the trigger.
  const [isMoreOptionsTooltipSuppressed, setIsMoreOptionsTooltipSuppressed] = useState(false);
  const showMoreOptionsTooltip =
    isMoreOptionsTooltipOpen && !isMoreOptionsOpen && !isMoreOptionsTooltipSuppressed;

  const handleMoreOptionsOpenChange = (open: boolean) => {
    setIsMoreOptionsOpen(open);
    if (open) {
      setIsMoreOptionsTooltipOpen(false);
      setIsMoreOptionsTooltipSuppressed(true);
    }
  };

  return (
    <Card className="group relative overflow-hidden border-border/50 bg-card/50 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5">
      <div
        className="absolute top-0 left-0 h-full w-1 transition-colors duration-300"
        style={{ backgroundColor: category?.color || 'transparent' }}
      />

      <CardHeader className="p-4 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="mb-1 truncate font-semibold text-lg leading-tight">{prompt.title}</h3>
            <div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
              {category && (
                <span
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: category.color }}
                />
              )}
              <span className="font-medium">{category?.name || 'Uncategorized'}</span>
              <span>•</span>
              <Badge
                className="h-5 border-border/50 bg-background/50 px-1.5 font-normal text-[10px]"
                variant="outline"
              >
                {prompt.modelSettings.model}
              </Badge>
              {prompt.site && (
                <span className="flex max-w-[120px] items-center gap-1 truncate">
                  <Globe aria-hidden="true" className="h-3 w-3" />
                  {new URL(prompt.site).hostname}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={prompt.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                  className={cn(
                    'h-8 w-8 transition-colors',
                    prompt.isFavorite
                      ? 'text-yellow-400 opacity-100'
                      : 'text-muted-foreground hover:text-yellow-400'
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(prompt.id);
                  }}
                  size="icon"
                  variant="ghost"
                >
                  <Star
                    aria-hidden="true"
                    className={cn('h-4 w-4', prompt.isFavorite && 'fill-current')}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {prompt.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              </TooltipContent>
            </Tooltip>

            <Tooltip onOpenChange={setIsMoreOptionsTooltipOpen} open={showMoreOptionsTooltip}>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex"
                  onPointerLeave={() => {
                    setIsMoreOptionsTooltipSuppressed(false);
                  }}
                >
                  <DropdownMenu onOpenChange={handleMoreOptionsOpenChange} open={isMoreOptionsOpen}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label="More options"
                        className="h-8 w-8"
                        size="icon"
                        variant="ghost"
                      >
                        <MoreVertical aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onCopy(prompt.content)}>
                        <Copy aria-hidden="true" className="mr-2 h-4 w-4" />
                        Copy Content
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onEdit(prompt.id)}>
                        <Edit2 aria-hidden="true" className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => onDelete(prompt.id)}
                      >
                        <Trash2 aria-hidden="true" className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </TooltipTrigger>
              <TooltipContent>More options</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 py-2">
        <p className="line-clamp-3 rounded-md border border-border/30 bg-muted/30 p-2 font-mono text-muted-foreground text-sm">
          {prompt.content}
        </p>
      </CardContent>

      <CardFooter className="flex items-center justify-between p-4 pt-2 text-muted-foreground text-xs">
        <div className="flex gap-2 overflow-hidden">
          {prompt.tags.slice(0, 3).map((tag) => (
            <span
              className="max-w-[80px] truncate rounded-sm bg-secondary/50 px-1.5 py-0.5"
              key={tag}
            >
              #{tag}
            </span>
          ))}
          {prompt.tags.length > 3 && (
            <span className="px-1.5 py-0.5">+{prompt.tags.length - 3}</span>
          )}
        </div>

        <time
          className="ml-2 flex shrink-0 cursor-help items-center gap-1"
          dateTime={updatedAt.toISOString()}
          title={`Updated ${updatedAt.toLocaleString()}`}
        >
          <Calendar aria-hidden="true" className="h-3 w-3" />
          {updatedAt.toLocaleDateString()}
        </time>
      </CardFooter>
    </Card>
  );
}
