/**
 * View Filter Preset Dropdown
 *
 * A dropdown component for selecting and managing view filter presets.
 * Includes inline editing, creation, and deletion within the dropdown.
 *
 * Based on Skylark's Variant7Selection pattern with adaptations for Brainstrike.
 */

import { createLogger } from '@brainstrike/logging';
import type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
  ViewFilterPresetIcon,
} from '@brainstrike/types';
import { PRESET_ICON_OPTIONS } from '@brainstrike/types';
import { Button, cn, Input, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import {
  Box,
  Check,
  ChevronDown,
  Code,
  Cpu,
  Database,
  File,
  FileCode,
  FileText,
  Filter,
  FlaskConical,
  FolderOpen,
  Globe,
  LayoutGrid,
  Palette,
  Plus,
  Settings,
  Settings2,
  Trash2,
  User,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

interface FormState {
  excludes: string;
  icon: ViewFilterPresetIcon;
  includes: string;
  name: string;
  useRegex: boolean;
}

type FormAction =
  | { type: 'SET_NAME'; value: string }
  | { type: 'SET_INCLUDES'; value: string }
  | { type: 'SET_EXCLUDES'; value: string }
  | { type: 'SET_USE_REGEX'; value: boolean }
  | { type: 'SET_ICON'; value: ViewFilterPresetIcon }
  | { type: 'RESET' }
  | { type: 'LOAD'; preset: ViewFilterPreset };

const EMPTY_FORM: FormState = {
  excludes: '',
  icon: 'file',
  includes: '',
  name: '',
  useRegex: false,
};

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SET_NAME':
      return { ...state, name: action.value };
    case 'SET_INCLUDES':
      return { ...state, includes: action.value };
    case 'SET_EXCLUDES':
      return { ...state, excludes: action.value };
    case 'SET_USE_REGEX':
      return { ...state, useRegex: action.value };
    case 'SET_ICON':
      return { ...state, icon: action.value };
    case 'RESET':
      return EMPTY_FORM;
    case 'LOAD':
      return {
        excludes: action.preset.excludes.join(', '),
        icon: action.preset.icon,
        includes: action.preset.includes.join(', '),
        name: action.preset.name,
        useRegex: action.preset.useRegex,
      };
    default:
      return state;
  }
}

// Map icon names to Lucide components
const ICON_MAP: Record<ViewFilterPresetIcon, React.ElementType> = {
  box: Box,
  code: Code,
  cpu: Cpu,
  database: Database,
  file: File,
  'file-code': FileCode,
  'file-text': FileText,
  'flask-conical': FlaskConical,
  folder: FolderOpen,
  'folder-open': FolderOpen,
  globe: Globe,
  layout: LayoutGrid,
  palette: Palette,
  settings: Settings,
  'test-tube': FlaskConical,
  user: User,
};

/** Look up the Lucide icon component for a given preset icon name. Falls back to Filter. */
const getIcon = (name: ViewFilterPresetIcon): React.ElementType => ICON_MAP[name] ?? Filter;

const logger = createLogger('ViewFilterPresetDropdown');

// ─── Subcomponents ────────────────────────────────────────────────────────────

interface IconPickerProps {
  onSelect: (name: ViewFilterPresetIcon) => void;
  selectedIcon: ViewFilterPresetIcon;
  size?: 'sm' | 'md';
}

function IconPicker({ selectedIcon, size = 'md', onSelect }: IconPickerProps) {
  return (
    <div className={`grid grid-cols-5 ${size === 'sm' ? 'gap-1' : 'gap-2'}`}>
      {PRESET_ICON_OPTIONS.map(({ name, label }) => {
        const IconComponent = getIcon(name);
        const isSelected = selectedIcon === name;
        const btnSize = size === 'sm' ? 'size-6' : 'h-7 w-full';
        const iconSize = size === 'sm' ? 'size-3' : 'size-4';
        return (
          <button
            aria-label={`Select ${label} icon${isSelected ? ' (selected)' : ''}`}
            aria-pressed={isSelected}
            className={cn(
              `flex ${btnSize} items-center justify-center rounded border transition-all`,
              isSelected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-background hover:bg-muted'
            )}
            key={name}
            onClick={() => onSelect(name)}
            title={label}
            type="button"
          >
            <IconComponent className={iconSize} />
          </button>
        );
      })}
    </div>
  );
}

interface PresetCreateFormProps {
  dispatch: React.Dispatch<FormAction>;
  form: FormState;
  onCancel: () => void;
  onCreate: () => void;
}

function PresetCreateForm({ form, dispatch, onCancel, onCreate }: PresetCreateFormProps) {
  return (
    <div className="space-y-3 bg-muted/10 p-3">
      <div className="flex items-center justify-between border-b pb-2">
        <span className="font-semibold text-muted-foreground text-xs uppercase">New Preset</span>
        <Button
          aria-label="Cancel preset creation"
          className="size-5"
          onClick={onCancel}
          size="icon"
          title="Cancel preset creation"
          variant="ghost"
        >
          <X className="size-3" />
        </Button>
      </div>
      <div className="space-y-2">
        <div className="space-y-1">
          <label className="font-medium text-[10px] text-muted-foreground" htmlFor="preset-name">
            Name
          </label>
          <Input
            className="h-7 text-xs"
            id="preset-name"
            onChange={(e) => dispatch({ type: 'SET_NAME', value: e.target.value })}
            placeholder="e.g. My Custom Filter"
            value={form.name}
          />
        </div>
        <fieldset className="m-0 space-y-1 border-0 p-0">
          <legend className="font-medium text-[10px] text-muted-foreground">Icon</legend>
          <IconPicker
            onSelect={(name) => dispatch({ type: 'SET_ICON', value: name })}
            selectedIcon={form.icon}
          />
        </fieldset>
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
            onChange={(e) => dispatch({ type: 'SET_INCLUDES', value: e.target.value })}
            placeholder="*.ts, src/**"
            value={form.includes}
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label
              className="font-medium text-[10px] text-muted-foreground"
              htmlFor="preset-excludes"
            >
              Exclude Patterns
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                checked={form.useRegex}
                className="sr-only"
                onChange={(e) => dispatch({ type: 'SET_USE_REGEX', value: e.target.checked })}
                type="checkbox"
              />
              <div
                aria-hidden="true"
                className={cn(
                  'flex size-3 items-center justify-center rounded border transition-colors',
                  form.useRegex ? 'border-primary bg-primary' : 'border-muted-foreground'
                )}
              >
                {form.useRegex && <Check className="size-2 text-primary-foreground" />}
              </div>
              <span className="text-[10px] text-muted-foreground">Use Regex</span>
            </label>
          </div>
          <Input
            className="h-7 font-mono text-xs"
            id="preset-excludes"
            onChange={(e) => dispatch({ type: 'SET_EXCLUDES', value: e.target.value })}
            placeholder="node_modules, dist"
            value={form.excludes}
          />
        </div>
      </div>
      <div className="pt-1">
        <Button
          className="h-7 w-full text-xs"
          disabled={!form.name.trim()}
          onClick={onCreate}
          size="sm"
        >
          Save & Select
        </Button>
      </div>
    </div>
  );
}

interface PresetEditFormProps {
  dispatch: React.Dispatch<FormAction>;
  form: FormState;
  onCancel: () => void;
  onDelete: (id: string) => void;
  onSave: () => void;
  preset: ViewFilterPreset;
}

function PresetEditForm({
  preset,
  form,
  dispatch,
  onCancel,
  onSave,
  onDelete,
}: PresetEditFormProps) {
  return (
    <div className="my-1 cursor-default space-y-2 rounded-md border bg-muted/20 p-2">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-muted-foreground text-xs uppercase">
          Editing {preset.name}
        </span>
        <Button
          aria-label="Cancel editing preset"
          className="size-6"
          onClick={onCancel}
          size="icon"
          title="Cancel editing preset"
          variant="ghost"
        >
          <X className="size-3" />
        </Button>
      </div>
      <IconPicker
        onSelect={(name) => dispatch({ type: 'SET_ICON', value: name })}
        selectedIcon={form.icon}
        size="sm"
      />
      <Input
        className="h-7 text-xs"
        onChange={(e) => dispatch({ type: 'SET_NAME', value: e.target.value })}
        placeholder="Name"
        value={form.name}
      />
      <Input
        className="h-7 font-mono text-xs"
        onChange={(e) => dispatch({ type: 'SET_INCLUDES', value: e.target.value })}
        placeholder="Include patterns (comma sep)"
        value={form.includes}
      />
      <div className="flex items-center gap-2">
        <Input
          className="h-7 flex-1 font-mono text-xs"
          onChange={(e) => dispatch({ type: 'SET_EXCLUDES', value: e.target.value })}
          placeholder="Exclude patterns"
          value={form.excludes}
        />
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            checked={form.useRegex}
            className="sr-only"
            onChange={(e) => dispatch({ type: 'SET_USE_REGEX', value: e.target.checked })}
            type="checkbox"
          />
          <div
            aria-hidden="true"
            className={cn(
              'flex size-3 items-center justify-center rounded border transition-colors',
              form.useRegex ? 'border-primary bg-primary' : 'border-muted-foreground'
            )}
          >
            {form.useRegex && <Check className="size-2 text-primary-foreground" />}
          </div>
          <span className="text-[10px] text-muted-foreground">Regex</span>
        </label>
      </div>
      <div className="flex gap-2 pt-1">
        <Button className="h-7 w-full px-2 text-xs" onClick={onSave} size="sm">
          Save
        </Button>
        {!preset.isDefault && (
          <Button
            className="h-7 w-full px-2 text-xs"
            onClick={() => onDelete(preset.id)}
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

interface ViewFilterPresetDropdownProps {
  /** Optional class name */
  className?: string | undefined;
  /**
   * True when filters are active but match NO preset. The trigger then says
   * "Custom filters" — it must never read as if nothing is filtered while
   * something is ("a filter was applied but the dropdown said All Files").
   */
  hasCustomFilters?: boolean;
  /** Whether presets are loading */
  loading?: boolean;
  /** Called to create a new preset */
  onCreate: (input: CreateViewFilterPresetInput) => Promise<ViewFilterPreset>;
  /** Called to delete a preset */
  onDelete: (id: string) => Promise<boolean>;
  /** Called when a preset is selected */
  onSelect: (preset: ViewFilterPreset) => void;
  /** Called to update an existing preset */
  onUpdate: (id: string, input: UpdateViewFilterPresetInput) => Promise<ViewFilterPreset | null>;
  /** Available presets */
  presets: ViewFilterPreset[];
  /** Currently selected preset */
  selectedPreset: ViewFilterPreset | null;
  /**
   * "Touched in this thread" (ADR-0021): built from the active thread, not
   * stored, so it is listed apart and can be neither edited nor deleted.
   */
  threadPreset?: ViewFilterPreset | null;
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
  hasCustomFilters = false,
  loading = false,
  className,
  threadPreset = null,
}: ViewFilterPresetDropdownProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Create form state (consolidated into useReducer)
  const [newForm, dispatchNew] = useReducer(formReducer, EMPTY_FORM);

  // Edit form state (consolidated into useReducer)
  const [editForm, dispatchEdit] = useReducer(formReducer, EMPTY_FORM);

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

  const shownThreadPreset =
    threadPreset &&
    (!searchFilter.trim() || threadPreset.name.toLowerCase().includes(searchFilter.toLowerCase()))
      ? threadPreset
      : null;

  // Reset create form state
  const resetCreateForm = useCallback(() => {
    dispatchNew({ type: 'RESET' });
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
    dispatchEdit({ preset, type: 'LOAD' });
  }, []);

  const handleCreate = useCallback(async () => {
    if (!newForm.name.trim()) {
      return;
    }

    const input: CreateViewFilterPresetInput = {
      excludes: newForm.excludes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      icon: newForm.icon,
      includes: newForm.includes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      name: newForm.name.trim(),
      useRegex: newForm.useRegex,
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
  }, [newForm, onCreate, onSelect, resetCreateForm]);

  const handleSaveEdit = useCallback(async () => {
    if (!(editingId && editForm.name.trim())) {
      return;
    }

    const input: UpdateViewFilterPresetInput = {
      excludes: editForm.excludes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      icon: editForm.icon,
      includes: editForm.includes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      name: editForm.name.trim(),
      useRegex: editForm.useRegex,
    };

    const currentEditingId = editingId;
    const selectedPresetId = selectedPreset?.id;

    let updated: Awaited<ReturnType<typeof onUpdate>> | null = null;
    try {
      updated = await onUpdate(currentEditingId, input);
    } catch (error) {
      logger.error('Failed to update preset', { error, id: currentEditingId });
      return;
    }
    if (updated && selectedPresetId === currentEditingId) {
      onSelect(updated);
    }
    setEditingId(null);
  }, [editingId, editForm, onUpdate, selectedPreset, onSelect]);

  const handleDelete = useCallback(
    async (id: string) => {
      const selectedId = selectedPreset?.id;
      let deleted = false;
      try {
        deleted = await onDelete(id);
      } catch (error) {
        logger.error('Failed to delete preset', { error, id });
      }
      if (deleted) {
        setEditingId(null);
        // If deleted preset was selected, select first available
        if (selectedId === id) {
          const next = presets.find((p) => p.id !== id);
          if (next) {
            onSelect(next);
          }
        }
      }
    },
    [onDelete, selectedPreset, presets, onSelect]
  );

  const selectPreset = useCallback(
    (preset: ViewFilterPreset) => {
      onSelect(preset);
      setIsOpen(false);
    },
    [onSelect]
  );

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsOpen(false);
        return;
      }

      if (event.key !== 'Enter') {
        return;
      }

      const [onlyPreset] = filteredPresets;
      if (filteredPresets.length !== 1 || !onlyPreset) {
        return;
      }

      event.preventDefault();
      selectPreset(onlyPreset);
    },
    [filteredPresets, selectPreset]
  );

  const selectedIconType: React.ElementType = selectedPreset
    ? (ICON_MAP[selectedPreset.icon] ?? File)
    : Filter;

  return (
    <Popover onOpenChange={handleOpenChange} open={isOpen}>
      <PopoverTrigger asChild>
        <Button className={cn('justify-between gap-2', className)} variant="outline">
          <div className="flex items-center gap-2 overflow-hidden">
            {React.createElement(selectedIconType, { className: 'size-4 shrink-0 text-primary' })}
            <span className="truncate font-medium">
              {selectedPreset?.name ?? (hasCustomFilters ? 'Custom filters' : 'Select filter...')}
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
          <PresetCreateForm
            dispatch={dispatchNew}
            form={newForm}
            onCancel={() => setIsCreating(false)}
            onCreate={handleCreate}
          />
        ) : (
          <>
            {/* Search */}
            <div className="border-b bg-muted/30 p-2">
              <Input
                aria-label="Filter presets"
                className="h-8"
                onChange={(e) => setSearchFilter(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Filter presets..."
                ref={searchInputRef}
                value={searchFilter}
              />
            </div>

            {/* Preset List */}
            <div className="max-h-[300px] overflow-y-auto p-1">
              {shownThreadPreset ? (
                <div className="border-b pb-1" data-testid="thread-touched-preset">
                  <div className="px-2 pt-1 pb-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                    This thread
                  </div>
                  <div
                    className={cn(
                      'flex items-center justify-between rounded-sm px-2 py-1 hover:bg-accent hover:text-accent-foreground',
                      selectedPreset?.id === shownThreadPreset.id &&
                        'bg-accent/50 text-accent-foreground'
                    )}
                  >
                    <button
                      className="flex flex-1 items-center gap-2 overflow-hidden py-1 text-left"
                      onClick={() => selectPreset(shownThreadPreset)}
                      type="button"
                    >
                      <FileText className="size-4 shrink-0 opacity-70" />
                      <div className="flex flex-col truncate">
                        <span className="truncate font-medium text-sm">
                          {shownThreadPreset.name}
                        </span>
                        <span className="truncate text-[10px] text-muted-foreground opacity-80">
                          {shownThreadPreset.description}
                        </span>
                      </div>
                    </button>
                    {selectedPreset?.id === shownThreadPreset.id && (
                      <Check className="ml-2 size-4 shrink-0 text-primary" />
                    )}
                  </div>
                </div>
              ) : null}
              {loading && filteredPresets.length === 0 && (
                <div className="py-4 text-center text-muted-foreground text-sm">
                  Loading presets...
                </div>
              )}
              {filteredPresets.map((preset) => {
                const isEditing = editingId === preset.id;
                const PresetIcon = getIcon(preset.icon);

                if (isEditing) {
                  return (
                    <PresetEditForm
                      dispatch={dispatchEdit}
                      form={editForm}
                      key={preset.id}
                      onCancel={() => setEditingId(null)}
                      onDelete={handleDelete}
                      onSave={handleSaveEdit}
                      preset={preset}
                    />
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
                      onClick={() => selectPreset(preset)}
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
                        aria-label="Edit preset"
                        className="size-6 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditing(preset);
                        }}
                        size="icon"
                        title="Edit preset"
                        variant="ghost"
                      >
                        <Settings2 className="size-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}

              {!loading && filteredPresets.length === 0 && !shownThreadPreset && (
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
