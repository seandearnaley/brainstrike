import { createClipboardService } from '@brainstrike/context-actions';
import { createLogger } from '@brainstrike/utils/logger';
import { useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { ModelPickerModel, ModelPickerProvider } from '../model-picker/types';
import { useToast } from '../use-toast';
import { PromptEditor, type PromptEditorSaveData } from './components/prompt-editor';
import { PromptList } from './components/prompt-list';
import { Sidebar } from './components/sidebar';
import { hasModelSettingsChanged } from './model-settings';
import { usePromptStore } from './store';
import type { Prompt } from './types';

const logger = createLogger('PromptManager');
const clipboard = createClipboardService();

interface PromptManagerProps {
  availableModels?: ModelPickerModel[];
  providers?: ModelPickerProvider[];
}

export function PromptManager({ availableModels, providers }: PromptManagerProps) {
  const {
    prompts = [],
    categories = [],
    filter,
    setFilter,
    addPrompt,
    addRevision,
    updatePrompt,
    deletePrompt,
    toggleFavorite,
  } = usePromptStore();

  const { toast } = useToast();
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);

  const handleEdit = (id: string) => {
    setEditingPromptId(id);
    setIsEditorOpen(true);
  };

  const handleDelete = (id: string) => {
    // biome-ignore lint/suspicious/noAlert: Intentional use of confirm for delete action
    if (confirm('Are you sure you want to delete this prompt?')) {
      deletePrompt(id);
      toast({
        description: 'The prompt has been permanently removed.',
        title: 'Prompt deleted',
        variant: 'destructive',
      });
    }
  };

  const handleCopy = (content: string) => {
    void clipboard.writeText(content).then((outcome) => {
      if (outcome.ok) {
        toast({
          description: 'Prompt content copied successfully.',
          title: 'Copied to clipboard',
        });
        return;
      }
      logger.warn('Failed to copy prompt content to clipboard', { error: outcome.error });
      toast({
        description: outcome.error,
        title: 'Copy failed',
        variant: 'destructive',
      });
    });
  };

  const handleSavePrompt = (promptData: PromptEditorSaveData) => {
    const { revisionNote, ...promptUpdate } = promptData;

    if (editingPromptId) {
      const currentPrompt = prompts.find((prompt: Prompt) => prompt.id === editingPromptId);
      const changesVersionedFields =
        currentPrompt &&
        ((promptUpdate.content !== undefined && promptUpdate.content !== currentPrompt.content) ||
          (promptUpdate.modelSettings !== undefined &&
            hasModelSettingsChanged(promptUpdate.modelSettings, currentPrompt.modelSettings)));

      if (currentPrompt && changesVersionedFields) {
        addRevision(editingPromptId, {
          content: currentPrompt.content,
          modelSettings: currentPrompt.modelSettings,
          note: revisionNote ?? 'Before edit',
        });
      }

      updatePrompt(editingPromptId, promptUpdate);
      toast({
        description: 'Your changes have been saved.',
        title: 'Prompt updated',
      });
    } else {
      // Ensure we have the required fields for a new prompt
      if (
        !(
          promptUpdate.title &&
          promptUpdate.content &&
          promptUpdate.categoryId &&
          promptUpdate.modelSettings
        )
      ) {
        toast({
          description: 'Please fill in all required fields.',
          title: 'Error',
          variant: 'destructive',
        });
        return;
      }

      addPrompt({
        categoryId: promptUpdate.categoryId,
        content: promptUpdate.content,
        modelSettings: promptUpdate.modelSettings,
        rating: 0,
        tags: promptUpdate.tags || [],
        title: promptUpdate.title,
        ...(promptUpdate.site ? { site: promptUpdate.site } : {}),
        isFavorite: false,
      });

      toast({
        description: 'New prompt has been added to your collection.',
        title: 'Prompt created',
      });
    }
    setEditingPromptId(null);
  };

  const handleCloseEditor = () => {
    setIsEditorOpen(false);
    setEditingPromptId(null);
  };

  const handleAddPrompt = () => {
    setEditingPromptId(null);
    setIsEditorOpen(true);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <div className="flex-1 overflow-hidden">
        <Group orientation="horizontal">
          <Panel className="min-w-[250px]" defaultSize="20%" maxSize="30%" minSize="15%">
            <Sidebar
              categories={categories}
              filter={filter}
              onAddPrompt={handleAddPrompt}
              onFilterChange={setFilter}
            />
          </Panel>

          <Separator className="w-1 bg-border/50 transition-colors hover:bg-primary/50" />

          <Panel>
            <div className="flex h-full flex-col">
              <div className="p-6 pb-0">
                <h1 className="bg-gradient-to-r from-primary to-purple-600 bg-clip-text font-bold text-3xl text-transparent tracking-tight">
                  Prompt Library
                </h1>
                <p className="mt-1 text-muted-foreground">
                  Manage, version, and organize your LLM prompts.
                </p>
              </div>

              <div className="flex-1 overflow-hidden">
                <PromptList
                  categories={categories}
                  filter={filter}
                  onCopy={handleCopy}
                  onDelete={handleDelete}
                  onEdit={handleEdit}
                  onToggleFavorite={toggleFavorite}
                  prompts={prompts}
                />
              </div>
            </div>
          </Panel>
        </Group>
      </div>

      <PromptEditor
        availableModels={availableModels ?? []}
        categories={categories}
        isOpen={isEditorOpen}
        onClose={handleCloseEditor}
        onSave={handleSavePrompt}
        prompt={
          editingPromptId ? (prompts.find((p: Prompt) => p.id === editingPromptId) ?? null) : null
        }
        providers={providers ?? []}
      />
    </div>
  );
}
