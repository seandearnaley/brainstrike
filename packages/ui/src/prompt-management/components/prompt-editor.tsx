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
    <Dialog onOpenChange={(open) => !open && onClose()} open={isOpen}>
      <DialogContent className="flex h-[80vh] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-border/50 border-b p-6 pb-2">
          <DialogTitle className="flex items-center gap-2 font-bold text-xl">
            {prompt ? 'Edit Prompt' : 'Create New Prompt'}
            {prompt && (
              <Badge className="ml-2 font-normal text-xs" variant="outline">
                v{prompt.revisions.length + 1}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* Main Editor Area */}
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                className="font-medium text-lg"
                id="title"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
                placeholder="e.g., Code Refactoring Assistant"
                value={title}
              />
            </div>

            <div className="flex min-h-[200px] flex-1 flex-col space-y-2">
              <Label htmlFor="content">Prompt Content</Label>
              <ExpandableTextarea
                className="flex-1 resize-none bg-muted/30 p-4 font-mono text-sm leading-relaxed"
                id="content"
                minRows={10}
                onChange={(e) => setContent(e as unknown as string)}
                placeholder="Enter your system prompt here..."
                value={content}
              />
            </div>
          </div>

          {/* Sidebar Settings */}
          <div className="flex w-80 flex-col gap-6 overflow-y-auto border-border/50 border-l bg-muted/10 p-6">
            <div className="space-y-2">
              <Label>Category</Label>
              <Select onValueChange={setCategoryId} value={categoryId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      <div className="flex items-center gap-2">
                        <div
                          className="h-2 w-2 rounded-full"
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
                mode="single"
                models={availableModels}
                modelType="llm"
                onChange={(id) => setModel(id as string)}
                placeholder="Select a model..."
                providers={providers}
                value={model}
              />
            </div>

            <div className="space-y-4">
              <div className="flex justify-between">
                <Label>Temperature</Label>
                <span className="text-muted-foreground text-xs">{temperature}</span>
              </div>
              <input
                className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-secondary accent-primary"
                max="2"
                min="0"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setTemperature(Number.parseFloat(e.target.value))
                }
                step="0.1"
                type="range"
                value={temperature}
              />
              <p className="text-muted-foreground text-xs">
                Lower values are more deterministic, higher values are more creative.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Tags</Label>
              <div className="mb-2 flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <Badge
                    className="flex h-6 items-center gap-1 py-0.5 pr-1 pl-2"
                    key={tag}
                    variant="secondary"
                  >
                    {tag}
                    <button
                      className="hover:text-destructive"
                      onClick={() => removeTag(tag)}
                      type="button"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  className="h-8 text-sm"
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTag()}
                  placeholder="Add tag..."
                  value={tagInput}
                />
                <Button
                  className="h-8 w-8 p-0"
                  onClick={addTag}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {prompt && prompt.revisions.length > 0 && (
              <div className="space-y-2 border-border/50 border-t pt-4">
                <Label className="flex items-center gap-2">
                  <History className="h-4 w-4" />
                  History
                </Label>
                <ScrollArea className="h-[150px]">
                  <div className="space-y-2">
                    {prompt.revisions.map((rev, i) => (
                      <div
                        className="flex items-center justify-between rounded border border-border/50 bg-background p-2 text-xs"
                        key={rev.id}
                      >
                        <div>
                          <div className="font-medium">v{prompt.revisions.length - i}</div>
                          <div className="text-muted-foreground">
                            {new Date(rev.timestamp).toLocaleString()}
                          </div>
                        </div>
                        <Button
                          className="h-6 w-6"
                          size="icon"
                          title="Restore"
                          type="button"
                          variant="ghost"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="border-border/50 border-t bg-muted/10 p-4">
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button className="gap-2" onClick={handleSave} type="button">
            <Save className="h-4 w-4" />
            Save Prompt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
