import { Calendar, Copy, Edit2, Globe, MoreVertical, Star, Trash2 } from 'lucide-react';
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
import type { Category, Prompt } from '../types';

interface PromptCardProps {
  prompt: Prompt;
  category?: Category | undefined;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onCopy: (content: string) => void;
}

export function PromptCard({
  prompt,
  category,
  onEdit,
  onDelete,
  onToggleFavorite,
  onCopy,
}: PromptCardProps) {
  return (
    <Card className="group relative overflow-hidden border-border/50 bg-card/50 backdrop-blur-sm transition-all duration-300 hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 hover:-translate-y-1">
      <div
        className="absolute top-0 left-0 w-1 h-full transition-colors duration-300"
        style={{ backgroundColor: category?.color || 'transparent' }}
      />

      <CardHeader className="p-4 pb-2">
        <div className="flex justify-between items-start gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg truncate leading-tight mb-1">{prompt.title}</h3>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              {category && (
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: category.color }}
                  title={category.name}
                />
              )}
              <span className="font-medium">{category?.name || 'Uncategorized'}</span>
              <span>•</span>
              <Badge
                variant="outline"
                className="text-[10px] h-5 px-1.5 font-normal border-border/50 bg-background/50"
              >
                {prompt.modelSettings.model}
              </Badge>
              {prompt.site && (
                <span className="flex items-center gap-1 truncate max-w-[120px]">
                  <Globe className="w-3 h-3" />
                  {new URL(prompt.site).hostname}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <Button
              variant="ghost"
              size="icon"
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
            >
              <Star className={cn('w-4 h-4', prompt.isFavorite && 'fill-current')} />
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onCopy(prompt.content)}>
                  <Copy className="w-4 h-4 mr-2" />
                  Copy Content
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onEdit(prompt.id)}>
                  <Edit2 className="w-4 h-4 mr-2" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => onDelete(prompt.id)}
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 py-2">
        <p className="text-sm text-muted-foreground line-clamp-3 font-mono bg-muted/30 p-2 rounded-md border border-border/30">
          {prompt.content}
        </p>
      </CardContent>

      <CardFooter className="p-4 pt-2 flex justify-between items-center text-xs text-muted-foreground">
        <div className="flex gap-2 overflow-hidden">
          {prompt.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="bg-secondary/50 px-1.5 py-0.5 rounded-sm truncate max-w-[80px]"
            >
              #{tag}
            </span>
          ))}
          {prompt.tags.length > 3 && (
            <span className="px-1.5 py-0.5">+{prompt.tags.length - 3}</span>
          )}
        </div>

        <div
          className="flex items-center gap-1 shrink-0 ml-2"
          title={`Updated ${new Date(prompt.updatedAt).toLocaleString()}`}
        >
          <Calendar className="w-3 h-3" />
          {new Date(prompt.updatedAt).toLocaleDateString()}
        </div>
      </CardFooter>
    </Card>
  );
}
