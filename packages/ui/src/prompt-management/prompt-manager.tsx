import { useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import type { ModelPickerModel, ModelPickerProvider } from '../model-picker/types';
import { useToast } from '../use-toast';
import { PromptEditor } from './components/prompt-editor';
import { PromptList } from './components/prompt-list';
import { Sidebar } from './components/sidebar';
import { usePromptStore } from './store';
import type { Prompt } from './types';

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
    if (confirm('Are you sure you want to delete this prompt?')) {
      deletePrompt(id);
      toast({
        title: 'Prompt deleted',
        description: 'The prompt has been permanently removed.',
        variant: 'destructive',
      });
    }
  };

  const handleCopy = (content: string) => {
    navigator.clipboard.writeText(content);
    toast({
      title: 'Copied to clipboard',
      description: 'Prompt content copied successfully.',
    });
  };

  const handleSavePrompt = (promptData: Partial<Prompt>) => {
    if (editingPromptId) {
      updatePrompt(editingPromptId, promptData);
      toast({
        title: 'Prompt updated',
        description: 'Your changes have been saved.',
      });
    } else {
      // Ensure we have the required fields for a new prompt
      if (
        !promptData.title ||
        !promptData.content ||
        !promptData.categoryId ||
        !promptData.modelSettings
      ) {
        toast({
          title: 'Error',
          description: 'Please fill in all required fields.',
          variant: 'destructive',
        });
        return;
      }

      addPrompt({
        title: promptData.title,
        content: promptData.content,
        categoryId: promptData.categoryId,
        tags: promptData.tags || [],
        modelSettings: promptData.modelSettings,
        rating: 0,
        ...(promptData.site ? { site: promptData.site } : {}),
        isFavorite: false,
      });

      toast({
        title: 'Prompt created',
        description: 'New prompt has been added to your collection.',
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
    <div className="h-full w-full bg-background text-foreground overflow-hidden flex flex-col">
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          <Panel defaultSize={20} minSize={15} maxSize={30} className="min-w-[250px]">
            <Sidebar
              categories={categories}
              filter={filter}
              onFilterChange={setFilter}
              onAddPrompt={handleAddPrompt}
            />
          </Panel>

          <PanelResizeHandle className="w-1 bg-border/50 hover:bg-primary/50 transition-colors" />

          <Panel>
            <div className="h-full flex flex-col">
              <div className="p-6 pb-0">
                <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-primary to-purple-600 bg-clip-text text-transparent">
                  Prompt Library
                </h1>
                <p className="text-muted-foreground mt-1">
                  Manage, version, and organize your LLM prompts.
                </p>
              </div>

              <div className="flex-1 overflow-hidden">
                <PromptList
                  prompts={prompts}
                  categories={categories}
                  filter={filter}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onToggleFavorite={toggleFavorite}
                  onCopy={handleCopy}
                />
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <PromptEditor
        isOpen={isEditorOpen}
        onClose={handleCloseEditor}
        prompt={
          editingPromptId ? (prompts.find((p: Prompt) => p.id === editingPromptId) ?? null) : null
        }
        categories={categories}
        availableModels={availableModels ?? []}
        providers={providers ?? []}
        onSave={handleSavePrompt}
      />
    </div>
  );
}
