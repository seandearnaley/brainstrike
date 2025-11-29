import { History, Plus, RotateCcw, Save, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '../../badge';
import { Button } from '../../button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../dialog';
import { ExpandableTextarea } from '../../expandable-textarea';
import { Input } from '../../input';
import { Label } from '../../label';
import { ModelPicker } from '../../model-picker';
import type { ModelPickerModel, ModelPickerProvider } from '../../model-picker/types';
import { ScrollArea } from '../../scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../select';
import type { Category, Prompt } from '../types';

interface PromptEditorProps {
  isOpen: boolean;
  onClose: () => void;
  prompt?: Prompt | null;
  categories: Category[];
  availableModels?: ModelPickerModel[];
  providers?: ModelPickerProvider[];
  onSave: (promptData: Partial<Prompt>) => void;
}

export function PromptEditor({
  isOpen,
  onClose,
  prompt,
  categories,
  availableModels = [],
  providers = [],
  onSave,
}: PromptEditorProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [categoryId, setCategoryId] = useState('general');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [model, setModel] = useState('gpt-4o');
  const [temperature, setTemperature] = useState(0.7);

  // Reset form when prompt changes
  useEffect(() => {
    if (prompt) {
      setTitle(prompt.title);
      setContent(prompt.content);
      setCategoryId(prompt.categoryId);
      setTags(prompt.tags);
      setModel(prompt.modelSettings.model);
      setTemperature(prompt.modelSettings.temperature);
    } else {
      setTitle('');
      setContent('');
      setCategoryId('general');
      setTags([]);
      setModel('gpt-4o');
      setTemperature(0.7);
    }
  }, [prompt, isOpen]);

  const handleSave = () => {
    onSave({
      title,
      content,
      categoryId,
      tags,
      modelSettings: {
        model,
        temperature,
        topP: 1, // Default
      },
      // If editing, we might want to create a revision, but that logic can be in the store/parent
    });
    onClose();
  };

  const addTag = () => {
    if (tagInput.trim() && !tags.includes(tagInput.trim())) {
      setTags([...tags, tagInput.trim()]);
      setTagInput('');
    }
  };

  const removeTag = (tagToRemove: string) => {
    setTags(tags.filter((tag) => tag !== tagToRemove));
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-6 pb-2 border-b border-border/50">
          <DialogTitle className="text-xl font-bold flex items-center gap-2">
            {prompt ? 'Edit Prompt' : 'Create New Prompt'}
            {prompt && (
              <Badge variant="outline" className="ml-2 font-normal text-xs">
                v{prompt.revisions.length + 1}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 flex overflow-hidden">
          {/* Main Editor Area */}
          <div className="flex-1 flex flex-col p-6 gap-4 overflow-y-auto">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
                placeholder="e.g., Code Refactoring Assistant"
                className="text-lg font-medium"
              />
            </div>

            <div className="space-y-2 flex-1 flex flex-col min-h-[200px]">
              <Label htmlFor="content">Prompt Content</Label>
              <ExpandableTextarea
                id="content"
                value={content}
                onChange={(e) => setContent(e as unknown as string)}
                placeholder="Enter your system prompt here..."
                className="flex-1 font-mono text-sm leading-relaxed resize-none p-4 bg-muted/30"
                minRows={10}
              />
            </div>
          </div>

          {/* Sidebar Settings */}
          <div className="w-80 border-l border-border/50 bg-muted/10 p-6 flex flex-col gap-6 overflow-y-auto">
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: category.color }}
                        />
                        {category.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Model</Label>
              <ModelPicker
                models={availableModels}
                providers={providers}
                value={model}
                onChange={(id) => setModel(id as string)}
                modelType="llm"
                mode="single"
                placeholder="Select a model..."
              />
            </div>

            <div className="space-y-4">
              <div className="flex justify-between">
                <Label>Temperature</Label>
                <span className="text-xs text-muted-foreground">{temperature}</span>
              </div>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={temperature}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setTemperature(Number.parseFloat(e.target.value))
                }
                className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
              />
              <p className="text-xs text-muted-foreground">
                Lower values are more deterministic, higher values are more creative.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-2 mb-2">
                {tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="pl-2 pr-1 py-0.5 h-6 flex items-center gap-1"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      className="hover:text-destructive"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTag()}
                  placeholder="Add tag..."
                  className="h-8 text-sm"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addTag}
                  className="h-8 w-8 p-0"
                >
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {prompt && prompt.revisions.length > 0 && (
              <div className="space-y-2 pt-4 border-t border-border/50">
                <Label className="flex items-center gap-2">
                  <History className="w-4 h-4" />
                  History
                </Label>
                <ScrollArea className="h-[150px]">
                  <div className="space-y-2">
                    {prompt.revisions.map((rev, i) => (
                      <div
                        key={rev.id}
                        className="text-xs p-2 rounded bg-background border border-border/50 flex justify-between items-center"
                      >
                        <div>
                          <div className="font-medium">v{prompt.revisions.length - i}</div>
                          <div className="text-muted-foreground">
                            {new Date(rev.timestamp).toLocaleString()}
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          title="Restore"
                        >
                          <RotateCcw className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="p-4 border-t border-border/50 bg-muted/10">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} className="gap-2">
            <Save className="w-4 h-4" />
            Save Prompt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
