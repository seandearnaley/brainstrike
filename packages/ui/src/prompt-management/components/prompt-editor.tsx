import { History, Plus, RotateCcw, Save, X } from 'lucide-react';
import { useEffect, useId, useReducer } from 'react';
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
import { hasModelSettingsChanged } from '../model-settings';
import type { Category, Prompt, PromptRevision } from '../types';

const DEFAULT_AVAILABLE_MODELS: ModelPickerModel[] = [];
const DEFAULT_PROVIDERS: ModelPickerProvider[] = [];

interface PromptEditorProps {
  availableModels?: ModelPickerModel[];
  categories: Category[];
  isOpen: boolean;
  onClose: () => void;
  onSave: (promptData: PromptEditorSaveData) => void;
  prompt?: Prompt | null;
  providers?: ModelPickerProvider[];
}

export interface PromptEditorSaveData extends Partial<Prompt> {
  revisionNote?: string;
}

interface FormState {
  categoryId: string;
  content: string;
  modelSettings: Prompt['modelSettings'];
  restorableDraftSource: 'prompt' | 'restore' | 'user';
  restoredRevisionId: string | null;
  tagInput: string;
  tags: string[];
  title: string;
}

type FormAction =
  | {
      type: 'SET_FIELD';
      field: keyof Pick<FormState, 'categoryId' | 'content' | 'tagInput' | 'title'>;
      value: string;
    }
  | { type: 'SET_MODEL'; model: string }
  | { type: 'RESTORE_REVISION'; revision: PromptRevision }
  | { type: 'SET_TEMPERATURE'; temperature: number }
  | { type: 'SET_TAGS'; tags: string[] }
  | { type: 'INIT'; prompt: Prompt | null | undefined };

function getInitialState(prompt: Prompt | null | undefined): FormState {
  if (prompt) {
    return {
      categoryId: prompt.categoryId,
      content: prompt.content,
      modelSettings: { ...prompt.modelSettings },
      restorableDraftSource: 'prompt',
      restoredRevisionId: null,
      tagInput: '',
      tags: prompt.tags,
      title: prompt.title,
    };
  }
  return {
    categoryId: 'general',
    content: '',
    modelSettings: { model: 'gpt-5.2', temperature: 0.7, topP: 1 },
    restorableDraftSource: 'prompt',
    restoredRevisionId: null,
    tagInput: '',
    tags: [],
    title: '',
  };
}

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SET_FIELD':
      return {
        ...state,
        [action.field]: action.value,
        restorableDraftSource: action.field === 'content' ? 'user' : state.restorableDraftSource,
        restoredRevisionId: action.field === 'content' ? null : state.restoredRevisionId,
      };
    case 'SET_MODEL':
      return {
        ...state,
        modelSettings: { ...state.modelSettings, model: action.model },
        restorableDraftSource: 'user',
        restoredRevisionId: null,
      };
    case 'RESTORE_REVISION':
      return {
        ...state,
        content: action.revision.content,
        modelSettings: action.revision.modelSettings
          ? { ...action.revision.modelSettings }
          : state.modelSettings,
        restorableDraftSource: 'restore',
        restoredRevisionId: action.revision.id,
      };
    case 'SET_TEMPERATURE':
      return {
        ...state,
        modelSettings: { ...state.modelSettings, temperature: action.temperature },
        restorableDraftSource: 'user',
        restoredRevisionId: null,
      };
    case 'SET_TAGS':
      return { ...state, tags: action.tags };
    case 'INIT':
      return getInitialState(action.prompt);
    default:
      return state;
  }
}

export function PromptEditor({
  isOpen: _isOpen,
  onClose,
  prompt,
  categories,
  availableModels = DEFAULT_AVAILABLE_MODELS,
  providers = DEFAULT_PROVIDERS,
  onSave,
}: PromptEditorProps) {
  const [formState, dispatch] = useReducer(formReducer, getInitialState(prompt));
  const { title, content, categoryId, tags, tagInput, modelSettings, restoredRevisionId } =
    formState;
  const { model, temperature } = modelSettings;
  const temperatureId = useId();
  const tagInputId = useId();
  const promptId = prompt?.id ?? null;

  useEffect(() => {
    // Key initialization to dialog sessions and prompt identity; same-prompt updates while open must not overwrite draft edits.
    dispatch({ prompt, type: 'INIT' });
  }, [promptId, _isOpen]);

  const handleSave = () => {
    const promptData: PromptEditorSaveData = {
      categoryId,
      content,
      modelSettings,
      tags,
      title,
      // If editing, we might want to create a revision, but that logic can be in the store/parent
    };

    if (restoredRevisionId) {
      promptData.revisionNote = 'Before restore';
    }

    onSave(promptData);
    onClose();
  };

  const addTag = () => {
    if (tagInput.trim() && !tags.includes(tagInput.trim())) {
      dispatch({ tags: [...tags, tagInput.trim()], type: 'SET_TAGS' });
      dispatch({ field: 'tagInput', type: 'SET_FIELD', value: '' });
    }
  };

  const removeTag = (tagToRemove: string) => {
    dispatch({ tags: tags.filter((tag) => tag !== tagToRemove), type: 'SET_TAGS' });
  };

  const restoreRevision = (revision: PromptRevision) => {
    if (hasRestorableDraftChanges(prompt, formState)) {
      // biome-ignore lint/suspicious/noAlert: Restore must explicitly guard unsaved draft loss.
      const confirmed = confirm(
        "Restore this version's content and model settings? Unsaved draft edits will be replaced. Title, category, and tags stay unchanged."
      );
      if (!confirmed) {
        return;
      }
    }

    dispatch({ revision, type: 'RESTORE_REVISION' });
  };

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={_isOpen}>
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
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  dispatch({ field: 'title', type: 'SET_FIELD', value: e.target.value })
                }
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
                onChange={(e) =>
                  dispatch({ field: 'content', type: 'SET_FIELD', value: e as unknown as string })
                }
                placeholder="Enter your system prompt here..."
                value={content}
              />
            </div>
          </div>

          {/* Sidebar Settings */}
          <div className="flex w-80 flex-col gap-6 overflow-y-auto border-border/50 border-l bg-muted/10 p-6">
            <div className="space-y-2">
              <Label>Category</Label>
              <Select
                onValueChange={(v) =>
                  dispatch({ field: 'categoryId', type: 'SET_FIELD', value: v })
                }
                value={categoryId}
              >
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
                onChange={(id) => dispatch({ model: id as string, type: 'SET_MODEL' })}
                placeholder="Select a model..."
                providers={providers}
                value={model}
              />
            </div>

            <div className="space-y-4">
              <div className="flex justify-between">
                <Label htmlFor={temperatureId}>Temperature</Label>
                <span className="text-muted-foreground text-xs">{temperature}</span>
              </div>
              <input
                className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-secondary accent-primary"
                id={temperatureId}
                max="2"
                min="0"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  dispatch({
                    temperature: Number.parseFloat(e.target.value),
                    type: 'SET_TEMPERATURE',
                  })
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
              <Label htmlFor={tagInputId}>Tags</Label>
              <div className="mb-2 flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <Badge
                    className="flex h-6 items-center gap-1 py-0.5 pr-1 pl-2"
                    key={tag}
                    variant="secondary"
                  >
                    {tag}
                    <button
                      aria-label={`Remove ${tag} tag`}
                      className="hover:text-destructive"
                      onClick={() => removeTag(tag)}
                      title={`Remove ${tag} tag`}
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
                  id={tagInputId}
                  onChange={(e) =>
                    dispatch({ field: 'tagInput', type: 'SET_FIELD', value: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      addTag();
                    }
                  }}
                  placeholder="Add tag..."
                  value={tagInput}
                />
                <Button
                  aria-label="Add tag"
                  className="h-8 w-8 p-0"
                  onClick={addTag}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
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
                          aria-label="Restore content and model settings"
                          className="h-6 w-6"
                          onClick={() => restoreRevision(rev)}
                          size="icon"
                          title="Restore content and model settings"
                          type="button"
                          variant="ghost"
                        >
                          <RotateCcw aria-hidden="true" className="h-3 w-3" />
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

function hasRestorableDraftChanges(
  prompt: Prompt | null | undefined,
  formState: FormState
): boolean {
  if (!prompt) {
    return false;
  }
  if (formState.restorableDraftSource !== 'user') {
    return false;
  }

  return (
    formState.content !== prompt.content ||
    hasModelSettingsChanged(formState.modelSettings, prompt.modelSettings)
  );
}
