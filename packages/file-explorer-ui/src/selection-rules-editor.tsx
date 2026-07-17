/**
 * SelectionRulesEditor - Dialog for creating and editing selection rules.
 *
 * Allows users to define glob patterns for including/excluding files
 * from rule-based selection mode.
 */

import {
  DEFAULT_EXCLUDE_ROOTS,
  DEFAULT_INCLUDE_PATTERNS,
  type GlobExcludeRule,
  type GlobIncludeRule,
  type RootExcludeRule,
  SELECTION_RULES_SCHEMA_VERSION,
  type SelectionRuleSet,
  serializeRuleSet,
} from '@brainstrike/selection-rules';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
} from '@brainstrike/ui';
import { generateUUID } from '@brainstrike/utils';
import { Info, Minus, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useFileExplorerStoreSelector } from './shell/file-explorer-provider';

/** Props for the selection rules editor */
export interface SelectionRulesEditorProps {
  /** Current folder ID for rule context */
  folderId: string;
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dialog open state changes */
  onOpenChange: (open: boolean) => void;
}

/** State for a pattern input row */
interface PatternInput {
  id: string;
  pattern: string;
}

/** Convert an array of strings to PatternInput objects */
function stringsToPatternInputs(strings: string[]): PatternInput[] {
  return strings.map((s) => ({ id: generateUUID(), pattern: s }));
}

/** Empty result for parseExistingRules */
const EMPTY_PARSED_RULES = {
  excludePatterns: [] as PatternInput[],
  excludeRoots: [] as PatternInput[],
  includePatterns: [] as PatternInput[],
};

/** Parse existing rules from JSON to extract patterns */
function parseExistingRules(ruleSetJson: string | null): {
  includePatterns: PatternInput[];
  excludePatterns: PatternInput[];
  excludeRoots: PatternInput[];
} {
  if (!ruleSetJson) {
    return EMPTY_PARSED_RULES;
  }

  try {
    const ruleSet = JSON.parse(ruleSetJson) as SelectionRuleSet;
    const enabledRules = ruleSet.rules.filter((r) => r.enabled !== false);

    const includePatterns = stringsToPatternInputs(
      enabledRules.filter((r) => r.type === 'glob-include').flatMap((r) => r.patterns)
    );
    const excludePatterns = stringsToPatternInputs(
      enabledRules.filter((r) => r.type === 'glob-exclude').flatMap((r) => r.patterns)
    );
    const excludeRoots = stringsToPatternInputs(
      enabledRules.filter((r) => r.type === 'root-exclude').flatMap((r) => r.roots)
    );

    return { excludePatterns, excludeRoots, includePatterns };
  } catch {
    return EMPTY_PARSED_RULES;
  }
}

/** Build a rule set from the editor state */
function buildRuleSet(
  folderId: string,
  includePatterns: PatternInput[],
  excludePatterns: PatternInput[],
  excludeRoots: PatternInput[]
): SelectionRuleSet {
  const now = new Date().toISOString();
  const rules: SelectionRuleSet['rules'] = [];

  // Add glob-include rule if patterns exist
  const validIncludePatterns = includePatterns
    .map((p) => p.pattern.trim())
    .filter((p) => p.length > 0);

  if (validIncludePatterns.length > 0) {
    const includeRule: GlobIncludeRule = {
      createdAt: now,
      enabled: true,
      id: generateUUID(),
      label: 'Include patterns',
      patterns: validIncludePatterns,
      priority: 0,
      type: 'glob-include',
    };
    rules.push(includeRule);
  }

  // Add root-exclude rule if roots exist
  const validExcludeRoots = excludeRoots.map((r) => r.pattern.trim()).filter((r) => r.length > 0);

  if (validExcludeRoots.length > 0) {
    const rootExcludeRule: RootExcludeRule = {
      createdAt: now,
      enabled: true,
      id: generateUUID(),
      label: 'Exclude directories',
      priority: 0,
      roots: validExcludeRoots,
      type: 'root-exclude',
    };
    rules.push(rootExcludeRule);
  }

  // Add glob-exclude rule if patterns exist
  const validExcludePatterns = excludePatterns
    .map((p) => p.pattern.trim())
    .filter((p) => p.length > 0);

  if (validExcludePatterns.length > 0) {
    const excludeRule: GlobExcludeRule = {
      createdAt: now,
      enabled: true,
      id: generateUUID(),
      label: 'Exclude patterns',
      patterns: validExcludePatterns,
      priority: 0,
      type: 'glob-exclude',
    };
    rules.push(excludeRule);
  }

  return {
    folderId,
    metadata: {
      createdAt: now,
      updatedAt: now,
    },
    rules,
    version: SELECTION_RULES_SCHEMA_VERSION,
  };
}

/** Inner dialog content - render only, no hooks */
const RulesEditorContent = ({
  includePatterns,
  excludePatterns,
  excludeRoots,
  onIncludePatternsChange,
  onExcludePatternsChange,
  onExcludeRootsChange,
  onApply,
  onCancel,
  onApplyDefaults,
}: {
  folderId: string;
  includePatterns: PatternInput[];
  excludePatterns: PatternInput[];
  excludeRoots: PatternInput[];
  onIncludePatternsChange: (patterns: PatternInput[]) => void;
  onExcludePatternsChange: (patterns: PatternInput[]) => void;
  onExcludeRootsChange: (roots: PatternInput[]) => void;
  onApply: () => void;
  onCancel: () => void;
  onApplyDefaults: () => void;
}) => {
  const addIncludePattern = () => {
    onIncludePatternsChange([...includePatterns, { id: generateUUID(), pattern: '' }]);
  };

  const removeIncludePattern = (id: string) => {
    onIncludePatternsChange(includePatterns.filter((p) => p.id !== id));
  };

  const updateIncludePattern = (id: string, pattern: string) => {
    onIncludePatternsChange(includePatterns.map((p) => (p.id === id ? { ...p, pattern } : p)));
  };

  const addExcludePattern = () => {
    onExcludePatternsChange([...excludePatterns, { id: generateUUID(), pattern: '' }]);
  };

  const removeExcludePattern = (id: string) => {
    onExcludePatternsChange(excludePatterns.filter((p) => p.id !== id));
  };

  const updateExcludePattern = (id: string, pattern: string) => {
    onExcludePatternsChange(excludePatterns.map((p) => (p.id === id ? { ...p, pattern } : p)));
  };

  const addExcludeRoot = () => {
    onExcludeRootsChange([...excludeRoots, { id: generateUUID(), pattern: '' }]);
  };

  const removeExcludeRoot = (id: string) => {
    onExcludeRootsChange(excludeRoots.filter((r) => r.id !== id));
  };

  const updateExcludeRoot = (id: string, pattern: string) => {
    onExcludeRootsChange(excludeRoots.map((r) => (r.id === id ? { ...r, pattern } : r)));
  };

  const hasAnyRules =
    includePatterns.length > 0 || excludePatterns.length > 0 || excludeRoots.length > 0;

  return (
    <div className="flex flex-col" data-testid="selection-rules-editor">
      {/* Header */}
      <div className="rounded-t-lg border-b bg-card bg-gradient-to-t from-primary/5 to-card p-4 text-foreground">
        <DialogTitle className="flex items-center gap-2 font-semibold text-lg leading-none tracking-tight">
          <Sparkles className="h-5 w-5 text-primary" />
          Selection Rules Editor
        </DialogTitle>
        <DialogDescription className="mt-1 text-muted-foreground text-sm">
          Define glob patterns to automatically select matching files
        </DialogDescription>
      </div>

      {/* Content */}
      <ScrollArea className="max-h-[60vh] flex-1">
        <div className="flex flex-col gap-6 bg-card p-4 text-foreground">
          {/* Default patterns info */}
          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950/50">
            <div className="mb-2 flex items-center gap-2 text-blue-700 text-sm dark:text-blue-300">
              <Info className="h-4 w-4" />
              <span className="font-medium">Quick Start with Defaults</span>
            </div>
            <p className="mb-2 text-blue-600 text-xs dark:text-blue-400">
              Click below to apply common patterns for TypeScript/JavaScript projects:
            </p>
            <Button
              className="h-7 text-xs"
              data-testid="apply-defaults-button"
              onClick={onApplyDefaults}
              size="sm"
              variant="outline"
            >
              Apply Default Patterns
            </Button>
          </div>

          {/* Include patterns section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2 text-sm">
                <Plus className="h-4 w-4 text-green-600" />
                Include Patterns
              </Label>
              <Button
                className="h-7 text-xs"
                data-testid="add-include-pattern"
                onClick={addIncludePattern}
                size="sm"
                variant="ghost"
              >
                <Plus className="mr-1 h-3 w-3" />
                Add
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Glob patterns to match files for selection (e.g., **/*.ts, src/**/*.tsx)
            </p>
            {includePatterns.length === 0 ? (
              <div className="rounded border border-dashed p-3 text-center text-muted-foreground text-xs">
                No include patterns. Add patterns to match files.
              </div>
            ) : (
              <div className="space-y-2">
                {includePatterns.map((p) => (
                  <div className="flex items-center gap-2" key={p.id}>
                    <Input
                      className="h-8 flex-1 font-mono text-sm"
                      data-testid={`include-pattern-${p.id}`}
                      onChange={(e) => updateIncludePattern(p.id, e.target.value)}
                      placeholder="**/*.ts"
                      value={p.pattern}
                    />
                    <Button
                      aria-label="Remove include pattern"
                      className="h-8 w-8 p-0"
                      data-testid={`remove-include-${p.id}`}
                      onClick={() => removeIncludePattern(p.id)}
                      size="sm"
                      title="Remove include pattern"
                      variant="ghost"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Exclude directories section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2 text-sm">
                <Minus className="h-4 w-4 text-red-600" />
                Exclude Directories
              </Label>
              <Button
                className="h-7 text-xs"
                data-testid="add-exclude-root"
                onClick={addExcludeRoot}
                size="sm"
                variant="ghost"
              >
                <Plus className="mr-1 h-3 w-3" />
                Add
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Directories to exclude entirely (e.g., node_modules, dist, .git)
            </p>
            {excludeRoots.length === 0 ? (
              <div className="rounded border border-dashed p-3 text-center text-muted-foreground text-xs">
                No directory exclusions. Add directories to skip.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {excludeRoots.map((r) => (
                  <Badge
                    className="flex items-center gap-1 py-1 pr-1"
                    data-testid={`exclude-root-${r.id}`}
                    key={r.id}
                    variant="secondary"
                  >
                    <Input
                      className="h-5 w-24 border-none bg-transparent p-0 font-mono text-xs focus-visible:ring-0"
                      onChange={(e) => updateExcludeRoot(r.id, e.target.value)}
                      placeholder="node_modules"
                      value={r.pattern}
                    />
                    <Button
                      aria-label="Remove exclude directory"
                      className="h-5 w-5 p-0 hover:bg-destructive/20"
                      data-testid={`remove-root-${r.id}`}
                      onClick={() => removeExcludeRoot(r.id)}
                      size="sm"
                      title="Remove exclude directory"
                      variant="ghost"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Exclude patterns section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2 text-sm">
                <Minus className="h-4 w-4 text-orange-600" />
                Exclude Patterns
              </Label>
              <Button
                className="h-7 text-xs"
                data-testid="add-exclude-pattern"
                onClick={addExcludePattern}
                size="sm"
                variant="ghost"
              >
                <Plus className="mr-1 h-3 w-3" />
                Add
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Glob patterns to exclude from selection (e.g., **/*.test.ts, **/*.spec.ts)
            </p>
            {excludePatterns.length === 0 ? (
              <div className="rounded border border-dashed p-3 text-center text-muted-foreground text-xs">
                No exclude patterns. Add patterns to filter out files.
              </div>
            ) : (
              <div className="space-y-2">
                {excludePatterns.map((p) => (
                  <div className="flex items-center gap-2" key={p.id}>
                    <Input
                      className="h-8 flex-1 font-mono text-sm"
                      data-testid={`exclude-pattern-${p.id}`}
                      onChange={(e) => updateExcludePattern(p.id, e.target.value)}
                      placeholder="**/*.test.ts"
                      value={p.pattern}
                    />
                    <Button
                      aria-label="Remove exclude pattern"
                      className="h-8 w-8 p-0"
                      data-testid={`remove-exclude-${p.id}`}
                      onClick={() => removeExcludePattern(p.id)}
                      size="sm"
                      title="Remove exclude pattern"
                      variant="ghost"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Clear all button */}
          {hasAnyRules && (
            <div className="border-t pt-3">
              <Button
                className="h-8 text-destructive text-xs hover:text-destructive"
                data-testid="clear-all-rules"
                onClick={() => {
                  onIncludePatternsChange([]);
                  onExcludePatternsChange([]);
                  onExcludeRootsChange([]);
                }}
                size="sm"
                variant="ghost"
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Clear All Rules
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="flex justify-end gap-2 border-t bg-card p-4">
        <Button data-testid="cancel-button" onClick={onCancel} size="sm" variant="outline">
          Cancel
        </Button>
        <Button data-testid="apply-rules-button" onClick={onApply} size="sm">
          Apply Rules
        </Button>
      </div>
    </div>
  );
};

/** Stateful container - isolates hooks from compiled content */
const RulesEditorContainer = ({
  isOpen,
  onOpenChange,
  folderId,
  existingRuleSetJson,
  onSave,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string;
  existingRuleSetJson: string | null;
  onSave: (ruleSetJson: string) => void;
}) => {
  // Parse existing rules when dialog opens
  const initialState = useMemo(
    () => parseExistingRules(existingRuleSetJson),
    [existingRuleSetJson]
  );

  const [includePatterns, setIncludePatterns] = useState<PatternInput[]>(
    initialState.includePatterns
  );
  const [excludePatterns, setExcludePatterns] = useState<PatternInput[]>(
    initialState.excludePatterns
  );
  const [excludeRoots, setExcludeRoots] = useState<PatternInput[]>(initialState.excludeRoots);

  // Reset state when dialog opens
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        const parsed = parseExistingRules(existingRuleSetJson);
        setIncludePatterns(parsed.includePatterns);
        setExcludePatterns(parsed.excludePatterns);
        setExcludeRoots(parsed.excludeRoots);
      }
      onOpenChange(open);
    },
    [existingRuleSetJson, onOpenChange]
  );

  const handleApply = useCallback(() => {
    const ruleSet = buildRuleSet(folderId, includePatterns, excludePatterns, excludeRoots);

    // Only save if there are actual rules
    if (ruleSet.rules.length > 0) {
      // serializeRuleSet already returns a JSON string - don't double-encode!
      const serialized = serializeRuleSet(ruleSet);
      onSave(serialized);
    } else {
      // Clear rules if none defined
      onSave('');
    }
    onOpenChange(false);
  }, [folderId, includePatterns, excludePatterns, excludeRoots, onSave, onOpenChange]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleApplyDefaults = useCallback(() => {
    // Add default include patterns
    const defaultIncludes: PatternInput[] = DEFAULT_INCLUDE_PATTERNS.map((pattern: string) => ({
      id: generateUUID(),
      pattern,
    }));

    // Add default exclude roots
    const defaultRoots: PatternInput[] = DEFAULT_EXCLUDE_ROOTS.map((root: string) => ({
      id: generateUUID(),
      pattern: root,
    }));

    // Default test file exclusions
    const defaultExcludes: PatternInput[] = [
      { id: generateUUID(), pattern: '**/*.test.ts' },
      { id: generateUUID(), pattern: '**/*.test.tsx' },
      { id: generateUUID(), pattern: '**/*.spec.ts' },
      { id: generateUUID(), pattern: '**/*.spec.tsx' },
      { id: generateUUID(), pattern: '**/__tests__/**' },
      { id: generateUUID(), pattern: '**/__mocks__/**' },
    ];

    setIncludePatterns(defaultIncludes);
    setExcludeRoots(defaultRoots);
    setExcludePatterns(defaultExcludes);
  }, []);

  return (
    <Dialog onOpenChange={handleOpenChange} open={isOpen}>
      <DialogContent
        className="w-full max-w-md rounded-md border bg-card p-0 text-foreground"
        data-testid="selection-rules-dialog"
      >
        <RulesEditorContent
          excludePatterns={excludePatterns}
          excludeRoots={excludeRoots}
          folderId={folderId}
          includePatterns={includePatterns}
          onApply={handleApply}
          onApplyDefaults={handleApplyDefaults}
          onCancel={handleCancel}
          onExcludePatternsChange={setExcludePatterns}
          onExcludeRootsChange={setExcludeRoots}
          onIncludePatternsChange={setIncludePatterns}
        />
      </DialogContent>
    </Dialog>
  );
};

/** Main selection rules editor component */
export const SelectionRulesEditor = memo<SelectionRulesEditorProps>(function SelectionRulesEditor({
  isOpen,
  onOpenChange,
  folderId,
}) {
  // Use separate selectors to avoid array reference instability with useSyncExternalStore
  const selectionModel = useFileExplorerStoreSelector((s) => s.selectionModel);
  const setSelectionRules = useFileExplorerStoreSelector((s) => s.setSelectionRules);
  const setSelectionMode = useFileExplorerStoreSelector((s) => s.setSelectionMode);
  const clearSelectionRules = useFileExplorerStoreSelector((s) => s.clearSelectionRules);

  const handleSave = useCallback(
    (ruleSetJson: string) => {
      if (ruleSetJson) {
        setSelectionRules(ruleSetJson);
        // Auto-switch to rules mode when rules are applied
        setSelectionMode('rules');
      } else {
        // Clear rules and switch back to explicit mode
        clearSelectionRules();
      }
    },
    [setSelectionRules, setSelectionMode, clearSelectionRules]
  );

  return (
    <RulesEditorContainer
      existingRuleSetJson={selectionModel.ruleSetJson}
      folderId={folderId}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      onSave={handleSave}
    />
  );
});
