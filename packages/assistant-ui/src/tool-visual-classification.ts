export type ToolVisualCategory = 'memory' | 'internal' | 'mcp' | 'lifecycle';

const INTERNAL_TOOL_PREFIX = /^brainstrike[._]/i;

/** Internal Brainstrike tools render as `brainstrike.x` or (Mastra-sanitized) `brainstrike_x`. */
export function isInternalToolName(name: string): boolean {
  return INTERNAL_TOOL_PREFIX.test(name);
}

/** Classify a per-tool card by its tool name. */
export function classifyToolName(name: string): 'internal' | 'mcp' {
  return isInternalToolName(name) ? 'internal' : 'mcp';
}

/** Classify a run-event card from its kind and optional tool metadata. */
export function classifyRunEvent(kind: string, toolName?: string): ToolVisualCategory {
  if (kind.startsWith('memory.')) {
    return 'memory';
  }
  if (kind.startsWith('tool.')) {
    return toolName ? classifyToolName(toolName) : 'lifecycle';
  }
  return 'lifecycle';
}

interface CategoryTint {
  /** Border + faint background applied to the card (non-failure state). */
  card: string;
  /** Left-rail accent color. */
  rail: string;
}

const TINTS: Record<ToolVisualCategory, CategoryTint> = {
  internal: { card: 'border-sky-300/50 bg-sky-500/5', rail: 'text-sky-800 dark:text-sky-300' },
  lifecycle: { card: 'border-border bg-background/70', rail: 'text-muted-foreground' },
  mcp: { card: 'border-teal-300/50 bg-teal-500/5', rail: 'text-teal-800 dark:text-teal-300' },
  memory: {
    card: 'border-violet-300/50 bg-violet-500/5',
    rail: 'text-violet-800 dark:text-violet-300',
  },
};

/** Subtle, theme-aware tint per category. Failure (red) is applied by the caller and overrides this. */
export function categoryTintClasses(category: ToolVisualCategory): CategoryTint {
  return TINTS[category];
}
