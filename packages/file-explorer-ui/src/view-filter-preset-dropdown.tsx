/**
 * View Filter Preset Dropdown
 *
 * A dropdown component for selecting and managing view filter presets.
 * Includes inline editing, creation, and deletion within the dropdown.
 *
 * Based on Skylark's Variant7Selection pattern with adaptations for Brainstrike.
 */

import type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
  ViewFilterPresetIcon,
} from '@brainstrike/types';
import { PRESET_ICON_OPTIONS } from '@brainstrike/types';
import { Button, cn, Input, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import {
  Box,
  Check,
  ChevronDown,
  Code,
  Database,
  File,
  FileCode,
  FileText,
  Filter,
  FlaskConical,
  FolderOpen,
  Globe,
  Palette,
  Plus,
  Settings,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Map icon names to Lucide components
const ICON_MAP: Record<ViewFilterPresetIcon, React.ElementType> = {
  file: File,
  'file-code': FileCode,
  'file-text': FileText,
  folder: FolderOpen,
  'folder-open': FolderOpen,
  code: Code,
  settings: Settings,
  database: Database,
  box: Box,
  user: File, // Fallback
  layout: File, // Fallback
  globe: Globe,
  cpu: File, // Fallback
  palette: Palette,
  'flask-conical': FlaskConical,
  'test-tube': FlaskConical,
};

const logger = createLogger('ViewFilterPresetDropdown');

interface ViewFilterPresetDropdownProps {
  /** Available presets */
  presets: ViewFilterPreset[];
  /** Currently selected preset */
  selectedPreset: ViewFilterPreset | null;
  /** Called when a preset is selected */
  onSelect: (preset: ViewFilterPreset) => void;
  /** Called to create a new preset */
  onCreate: (input: CreateViewFilterPresetInput) => Promise<ViewFilterPreset>;
  /** Called to update an existing preset */
  onUpdate: (id: string, input: UpdateViewFilterPresetInput) => Promise<ViewFilterPreset | null>;
  /** Called to delete a preset */
  onDelete: (id: string) => Promise<boolean>;
  /** Whether presets are loading */
  loading?: boolean;
  /** Optional class name */
  className?: string | undefined;
}

/**
 * View Filter Preset Dropdown Component
 *
 * Features:
 * - Preset selection with search filtering
 * - Inline preset editing (name, patterns, icon, regex toggle)
 * - Create new preset mode
 * - Delete presets (non-default only)
 */
export function ViewFilterPresetDropdown({
  presets,
  selectedPreset,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
  loading = false,
  className,
}: ViewFilterPresetDropdownProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Create form state
  const [newName, setNewName] = useState('');
  const [newIncludes, setNewIncludes] = useState('');
  const [newExcludes, setNewExcludes] = useState('');
  const [newUseRegex, setNewUseRegex] = useState(false);
  const [newIcon, setNewIcon] = useState<ViewFilterPresetIcon>('file');

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editIncludes, setEditIncludes] = useState('');
  const [editExcludes, setEditExcludes] = useState('');
  const [editUseRegex, setEditUseRegex] = useState(false);
  const [editIcon, setEditIcon] = useState<ViewFilterPresetIcon>('file');

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filter presets by search
  const filteredPresets = useMemo(() => {
    if (!searchFilter.trim()) {
      return presets;
    }
    const lower = searchFilter.toLowerCase();
    return presets.filter(
      (p) =>
        p.name.toLowerCase().includes(lower) ||
        p.includes.some((i) => i.toLowerCase().includes(lower))
    );
  }, [presets, searchFilter]);

  // Reset create form state
  const resetCreateForm = useCallback(() => {
    setNewName('');
    setNewIncludes('');
    setNewExcludes('');
    setNewUseRegex(false);
    setNewIcon('file');
  }, []);

  // Handle dropdown open/close - reset state when closing
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (!open) {
        // Reset all state when closing
        setSearchFilter('');
        setEditingId(null);
        setIsCreating(false);
        resetCreateForm();
      }
    },
    [resetCreateForm]
  );

  // Focus search input when dropdown opens (using useEffect to handle mount/unmount properly)
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    // Use requestAnimationFrame to ensure DOM is ready after render
    const rafId = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(rafId);
  }, [isOpen]);

  // Start editing a preset - initialize edit form with preset values
  const startEditing = useCallback((preset: ViewFilterPreset) => {
    setEditingId(preset.id);
    setEditName(preset.name);
    setEditIncludes(preset.includes.join(', '));
    setEditExcludes(preset.excludes.join(', '));
    setEditUseRegex(preset.useRegex);
    setEditIcon(preset.icon);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) {
      return;
    }

    const input: CreateViewFilterPresetInput = {
      name: newName.trim(),
      icon: newIcon,
      includes: newIncludes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      excludes: newExcludes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      useRegex: newUseRegex,
    };

    try {
      const created = await onCreate(input);
      onSelect(created);
      setIsCreating(false);
      setIsOpen(false);
      resetCreateForm();
    } catch (error) {
      logger.error('Failed to create preset', { error, name: input.name });
    }
  }, [
    newName,
    newIcon,
    newIncludes,
    newExcludes,
    newUseRegex,
    onCreate,
    onSelect,
    resetCreateForm,
  ]);

  const handleSaveEdit = useCallback(async () => {
    if (!(editingId && editName.trim())) {
      return;
    }

    const input: UpdateViewFilterPresetInput = {
      name: editName.trim(),
      icon: editIcon,
      includes: editIncludes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      excludes: editExcludes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      useRegex: editUseRegex,
    };

    try {
      const updated = await onUpdate(editingId, input);
      if (updated && selectedPreset?.id === editingId) {
        onSelect(updated);
      }
      setEditingId(null);
    } catch (error) {
      logger.error('Failed to update preset', { error, id: editingId });
    }
  }, [
    editingId,
    editName,
    editIcon,
    editIncludes,
    editExcludes,
    editUseRegex,
    onUpdate,
    selectedPreset,
    onSelect,
  ]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const deleted = await onDelete(id);
        if (deleted) {
          setEditingId(null);
          // If deleted preset was selected, select first available
          if (selectedPreset?.id === id && presets.length > 1) {
            const next = presets.find((p) => p.id !== id);
            if (next) {
              onSelect(next);
            }
          }
        }
      } catch (error) {
        logger.error('Failed to delete preset', { error, id });
      }
    },
    [onDelete, selectedPreset, presets, onSelect]
  );

  const getIcon = (iconName: ViewFilterPresetIcon): React.ElementType => ICON_MAP[iconName] || File;

  const SelectedIcon = selectedPreset ? getIcon(selectedPreset.icon) : Filter;

  return (
    <Popover onOpenChange={handleOpenChange} open={isOpen}>
      <PopoverTrigger asChild>
        <Button
          className={cn('justify-between gap-2', className)}
          disabled={loading}
          variant="outline"
        >
          <div className="flex items-center gap-2 overflow-hidden">
            <SelectedIcon className="size-4 shrink-0 text-primary" />
            <span className="truncate font-medium">
              {selectedPreset?.name ?? 'Select filter...'}
            </span>
          </div>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 opacity-50 transition-transform',
              isOpen && 'rotate-180'
            )}
          />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-80 p-0">
        {isCreating ? (
          /* Create Mode */
          <div className="space-y-3 bg-muted/10 p-3">
            <div className="flex items-center justify-between border-b pb-2">
              <span className="font-semibold text-muted-foreground text-xs uppercase">
                New Preset
              </span>
              <Button
                className="size-5"
                onClick={() => setIsCreating(false)}
                size="icon"
                variant="ghost"
              >
                <X className="size-3" />
              </Button>
            </div>

            <div className="space-y-2">
              {/* Name */}
              <div className="space-y-1">
                <label
                  className="font-medium text-[10px] text-muted-foreground"
                  htmlFor="preset-name"
                >
                  Name
                </label>
                <Input
                  autoFocus
                  className="h-7 text-xs"
                  id="preset-name"
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. My Custom Filter"
                  value={newName}
                />
              </div>

              {/* Icon Picker */}
              <fieldset className="m-0 space-y-1 border-0 p-0">
                <legend className="font-medium text-[10px] text-muted-foreground">Icon</legend>
                <div className="grid grid-cols-5 gap-2">
                  {PRESET_ICON_OPTIONS.map(({ name, label }) => {
                    const IconComponent = getIcon(name);
                    const isSelected = newIcon === name;
                    return (
                      <button
                        aria-label={`Select ${label} icon${isSelected ? ' (selected)' : ''}`}
                        aria-pressed={isSelected}
                        className={cn(
                          'flex h-7 w-full items-center justify-center rounded border transition-all',
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'bg-background hover:bg-muted'
                        )}
                        key={name}
                        onClick={() => setNewIcon(name)}
                        title={label}
                        type="button"
                      >
                        <IconComponent className="size-4" />
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              {/* Includes */}
              <div className="space-y-1">
                <label
                  className="font-medium text-[10px] text-muted-foreground"
                  htmlFor="preset-includes"
                >
                  Include Patterns (comma sep)
                </label>
                <Input
                  className="h-7 font-mono text-xs"
                  id="preset-includes"
                  onChange={(e) => setNewIncludes(e.target.value)}
                  placeholder="*.ts, src/**"
                  value={newIncludes}
                />
              </div>

              {/* Excludes */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label
                    className="font-medium text-[10px] text-muted-foreground"
                    htmlFor="preset-excludes"
                  >
                    Exclude Patterns
                  </label>
                  <button
                    className="flex cursor-pointer items-center gap-1.5"
                    onClick={() => setNewUseRegex(!newUseRegex)}
                    type="button"
                  >
                    <div
                      className={cn(
                        'flex size-3 items-center justify-center rounded border transition-colors',
                        newUseRegex ? 'border-primary bg-primary' : 'border-muted-foreground'
                      )}
                    >
                      {newUseRegex && <Check className="size-2 text-primary-foreground" />}
                    </div>
                    <span className="text-[10px] text-muted-foreground">Use Regex</span>
                  </button>
                </div>
                <Input
                  className="h-7 font-mono text-xs"
                  id="preset-excludes"
                  onChange={(e) => setNewExcludes(e.target.value)}
                  placeholder="node_modules, dist"
                  value={newExcludes}
                />
              </div>
            </div>

            <div className="pt-1">
              <Button
                className="h-7 w-full text-xs"
                disabled={!newName.trim()}
                onClick={handleCreate}
                size="sm"
              >
                Save & Select
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Search */}
            <div className="border-b bg-muted/30 p-2">
              <Input
                className="h-8"
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Filter presets..."
                ref={searchInputRef}
                value={searchFilter}
              />
            </div>

            {/* Preset List */}
            <div className="max-h-[300px] overflow-y-auto p-1">
              {filteredPresets.map((preset) => {
                const isEditing = editingId === preset.id;
                const PresetIcon = getIcon(preset.icon);

                if (isEditing) {
                  return (
                    <div
                      className="my-1 cursor-default space-y-2 rounded-md border bg-muted/20 p-2"
                      key={preset.id}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-muted-foreground text-xs uppercase">
                          Editing {preset.name}
                        </span>
                        <Button
                          className="size-6"
                          onClick={() => setEditingId(null)}
                          size="icon"
                          variant="ghost"
                        >
                          <X className="size-3" />
                        </Button>
                      </div>

                      {/* Icon Picker */}
                      <div className="grid grid-cols-5 gap-1">
                        {PRESET_ICON_OPTIONS.map(({ name, label }) => {
                          const IconComponent = getIcon(name);
                          const isSelected = editIcon === name;
                          return (
                            <button
                              aria-label={`Select ${label} icon${isSelected ? ' (selected)' : ''}`}
                              aria-pressed={isSelected}
                              className={cn(
                                'flex size-6 items-center justify-center rounded border transition-all',
                                isSelected
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'bg-background hover:bg-muted'
                              )}
                              key={name}
                              onClick={() => setEditIcon(name)}
                              title={label}
                              type="button"
                            >
                              <IconComponent className="size-3" />
                            </button>
                          );
                        })}
                      </div>

                      {/* Name */}
                      <Input
                        className="h-7 text-xs"
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Name"
                        value={editName}
                      />

                      {/* Includes */}
                      <Input
                        className="h-7 font-mono text-xs"
                        onChange={(e) => setEditIncludes(e.target.value)}
                        placeholder="Include patterns (comma sep)"
                        value={editIncludes}
                      />

                      {/* Excludes + Regex */}
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-7 flex-1 font-mono text-xs"
                          onChange={(e) => setEditExcludes(e.target.value)}
                          placeholder="Exclude patterns"
                          value={editExcludes}
                        />
                        <button
                          className="flex cursor-pointer items-center gap-1.5"
                          onClick={() => setEditUseRegex(!editUseRegex)}
                          type="button"
                        >
                          <div
                            className={cn(
                              'flex size-3 items-center justify-center rounded border transition-colors',
                              editUseRegex ? 'border-primary bg-primary' : 'border-muted-foreground'
                            )}
                          >
                            {editUseRegex && <Check className="size-2 text-primary-foreground" />}
                          </div>
                          <span className="text-[10px] text-muted-foreground">Regex</span>
                        </button>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2 pt-1">
                        <Button
                          className="h-7 w-full px-2 text-xs"
                          onClick={handleSaveEdit}
                          size="sm"
                        >
                          Save
                        </Button>
                        {!preset.isDefault && (
                          <Button
                            className="h-7 w-full px-2 text-xs"
                            onClick={() => handleDelete(preset.id)}
                            size="sm"
                            variant="destructive"
                          >
                            <Trash2 className="mr-1 size-3" /> Delete
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    className={cn(
                      'group flex items-center justify-between rounded-sm px-2 py-1 hover:bg-accent hover:text-accent-foreground',
                      selectedPreset?.id === preset.id && 'bg-accent/50 text-accent-foreground'
                    )}
                    key={preset.id}
                  >
                    <button
                      className="flex flex-1 items-center gap-2 overflow-hidden py-1 text-left"
                      onClick={() => {
                        onSelect(preset);
                        setIsOpen(false);
                      }}
                      type="button"
                    >
                      <PresetIcon className="size-4 shrink-0 opacity-70" />
                      <div className="flex flex-col truncate">
                        <span className="truncate font-medium text-sm">{preset.name}</span>
                        <span className="truncate font-mono text-[10px] text-muted-foreground opacity-80">
                          {preset.includes.join(', ')}
                        </span>
                      </div>
                    </button>
                    <div className="ml-2 flex items-center gap-1">
                      {selectedPreset?.id === preset.id && (
                        <Check className="size-4 shrink-0 text-primary" />
                      )}
                      <Button
                        className="size-6 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditing(preset);
                        }}
                        size="icon"
                        variant="ghost"
                      >
                        <Settings2 className="size-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}

              {filteredPresets.length === 0 && (
                <div className="py-4 text-center text-muted-foreground text-sm">
                  No presets found
                </div>
              )}
            </div>

            {/* Create New */}
            <div className="border-t bg-muted/30 p-1">
              <Button
                className="h-8 w-full justify-start text-xs"
                onClick={() => setIsCreating(true)}
                size="sm"
                variant="ghost"
              >
                <Plus className="mr-2 size-3" />
                Create New Preset
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

export type { ViewFilterPresetDropdownProps };
