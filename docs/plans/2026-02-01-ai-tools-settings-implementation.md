# AI Tools Settings Redesign - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the AI Tools settings panel with accordion-based collapsible groups, dense table-like tool rows, and improved visual hierarchy.

**Architecture:** Replace current card-based layout with Radix Accordion for collapsible groups. Tools displayed as dense inline rows with expand/collapse for details. MCP server status integrated into accordion headers instead of separate card. Filter bar made compact with inline stats.

**Tech Stack:** React 19, Radix UI (Accordion, DropdownMenu, Tooltip), Tailwind CSS v4, Vitest + React Testing Library

---

## Task 1: Create ToolGroupAccordion Component

Create a new accordion wrapper that handles tool group display with header, stats, and dropdown menu.

**Files:**
- Create: `packages/preferences/src/settings/tools/tool-group-accordion.tsx`
- Create: `packages/preferences/src/settings/tools/__tests__/tool-group-accordion.test.tsx`

**Step 1: Write the failing test**

```tsx
// packages/preferences/src/settings/tools/__tests__/tool-group-accordion.test.tsx
/**
 * Tool Group Accordion Tests
 */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolGroupAccordion } from '../tool-group-accordion';

// Mock @brainstrike/ui
vi.mock('@brainstrike/ui', () => ({
  Accordion: ({ children, ...props }: { children: React.ReactNode }) => (
    <div data-testid="accordion" {...props}>{children}</div>
  ),
  AccordionItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-testid={`accordion-item-${value}`}>{children}</div>
  ),
  AccordionTrigger: ({ children }: { children: React.ReactNode }) => (
    <button data-testid="accordion-trigger" type="button">{children}</button>
  ),
  AccordionContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="accordion-content">{children}</div>
  ),
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
  Button: ({ children, onClick, ...props }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick} type="button" {...props}>{children}</button>
  ),
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick} type="button">{children}</button>
  ),
  DropdownMenuSeparator: () => <hr />,
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('ToolGroupAccordion', () => {
  const defaultProps = {
    id: 'native',
    label: 'Native Tools',
    description: 'Core agent capabilities',
    source: 'native' as const,
    enabledCount: 8,
    totalCount: 12,
    children: <div data-testid="tool-rows">Tool Rows</div>,
    onEnableAll: vi.fn(),
    onDisableAll: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders the group label', () => {
      render(<ToolGroupAccordion {...defaultProps} />);
      expect(screen.getByText('Native Tools')).toBeInTheDocument();
    });

    it('renders the description', () => {
      render(<ToolGroupAccordion {...defaultProps} />);
      expect(screen.getByText('Core agent capabilities')).toBeInTheDocument();
    });

    it('renders enabled count fraction', () => {
      render(<ToolGroupAccordion {...defaultProps} />);
      expect(screen.getByText('8/12 enabled')).toBeInTheDocument();
    });

    it('renders children in accordion content', () => {
      render(<ToolGroupAccordion {...defaultProps} />);
      expect(screen.getByTestId('tool-rows')).toBeInTheDocument();
    });
  });

  describe('MCP server status', () => {
    it('shows connected status for MCP groups', () => {
      render(
        <ToolGroupAccordion
          {...defaultProps}
          id="mcp-github"
          label="@github/mcp-server"
          source="mcp"
          mcpStatus="connected"
        />
      );
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    it('shows error status with message', () => {
      render(
        <ToolGroupAccordion
          {...defaultProps}
          id="mcp-github"
          source="mcp"
          mcpStatus="error"
          mcpError="Connection refused"
        />
      );
      expect(screen.getByText('Error')).toBeInTheDocument();
    });
  });

  describe('actions', () => {
    it('calls onEnableAll when Enable All is clicked', () => {
      render(<ToolGroupAccordion {...defaultProps} />);
      const enableButton = screen.getByText('Enable All');
      fireEvent.click(enableButton);
      expect(defaultProps.onEnableAll).toHaveBeenCalled();
    });

    it('calls onDisableAll when Disable All is clicked', () => {
      render(<ToolGroupAccordion {...defaultProps} />);
      const disableButton = screen.getByText('Disable All');
      fireEvent.click(disableButton);
      expect(defaultProps.onDisableAll).toHaveBeenCalled();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/preferences -- --run tool-group-accordion`
Expected: FAIL with "Cannot find module '../tool-group-accordion'"

**Step 3: Write minimal implementation**

```tsx
// packages/preferences/src/settings/tools/tool-group-accordion.tsx
/**
 * Tool Group Accordion
 *
 * Collapsible accordion section for a group of tools (Native or MCP server).
 * Features two-line header with stats and dropdown menu for bulk actions.
 */

import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { Circle, MoreHorizontal, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

export interface ToolGroupAccordionProps {
  /** Unique identifier for the accordion item */
  id: string;
  /** Display label for the group */
  label: string;
  /** Optional description shown below label */
  description?: string;
  /** Tool source type */
  source: 'native' | 'mcp';
  /** Number of enabled tools */
  enabledCount: number;
  /** Total number of tools in group */
  totalCount: number;
  /** Tool rows to render inside */
  children: ReactNode;
  /** MCP connection status (MCP groups only) */
  mcpStatus?: 'connected' | 'connecting' | 'disconnected' | 'error';
  /** MCP error message (when status is error) */
  mcpError?: string;
  /** Callback to enable all tools in group */
  onEnableAll: () => void;
  /** Callback to disable all tools in group */
  onDisableAll: () => void;
  /** Callback to refresh MCP connection (MCP groups only) */
  onRefresh?: () => void;
  /** Callback to open MCP config (MCP groups only) */
  onOpenConfig?: () => void;
}

/**
 * Get status indicator color class.
 */
function getStatusColor(status: ToolGroupAccordionProps['mcpStatus']): string {
  switch (status) {
    case 'connected':
      return 'fill-green-500 text-green-500';
    case 'connecting':
      return 'fill-yellow-500 text-yellow-500';
    case 'error':
      return 'fill-destructive text-destructive';
    default:
      return 'fill-muted-foreground text-muted-foreground';
  }
}

/**
 * Get status label text.
 */
function getStatusLabel(status: ToolGroupAccordionProps['mcpStatus']): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting...';
    case 'error':
      return 'Error';
    default:
      return 'Disconnected';
  }
}

export function ToolGroupAccordion({
  id,
  label,
  description,
  source,
  enabledCount,
  totalCount,
  children,
  mcpStatus,
  mcpError,
  onEnableAll,
  onDisableAll,
  onRefresh,
  onOpenConfig,
}: ToolGroupAccordionProps) {
  const isMcp = source === 'mcp';
  const showStatus = isMcp && mcpStatus;

  return (
    <AccordionItem className="rounded-lg border bg-card" value={id}>
      <AccordionTrigger className="px-4 py-3 hover:no-underline">
        <div className="flex w-full items-center justify-between gap-4">
          {/* Left: Label and description */}
          <div className="min-w-0 flex-1 text-left">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{label}</span>
              {showStatus && (
                <div className="flex items-center gap-1.5">
                  <Circle className={`h-2 w-2 ${getStatusColor(mcpStatus)}`} />
                  <span className={`text-xs ${mcpStatus === 'connecting' ? 'italic' : ''}`}>
                    {getStatusLabel(mcpStatus)}
                  </span>
                </div>
              )}
            </div>
            {(description || mcpError) && (
              <p className="mt-0.5 truncate text-muted-foreground text-sm">
                {mcpStatus === 'error' && mcpError ? mcpError : description}
              </p>
            )}
          </div>

          {/* Right: Stats and actions */}
          <div className="flex shrink-0 items-center gap-3">
            <Badge variant="secondary">
              {enabledCount}/{totalCount} enabled
            </Badge>

            {/* Dropdown Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  className="h-7 w-7 p-0"
                  onClick={(e) => e.stopPropagation()}
                  size="sm"
                  variant="ghost"
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEnableAll}>Enable All</DropdownMenuItem>
                <DropdownMenuItem onClick={onDisableAll}>Disable All</DropdownMenuItem>
                {isMcp && (
                  <>
                    <DropdownMenuSeparator />
                    {onRefresh && (
                      <DropdownMenuItem onClick={onRefresh}>
                        <RefreshCw className="mr-2 h-3.5 w-3.5" />
                        Refresh Connection
                      </DropdownMenuItem>
                    )}
                    {onOpenConfig && (
                      <DropdownMenuItem onClick={onOpenConfig}>Open Config File</DropdownMenuItem>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="px-4 pb-4">{children}</AccordionContent>
    </AccordionItem>
  );
}

export default ToolGroupAccordion;
```

**Step 4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/preferences -- --run tool-group-accordion`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/preferences/src/settings/tools/tool-group-accordion.tsx packages/preferences/src/settings/tools/__tests__/tool-group-accordion.test.tsx
git commit -m "feat(preferences): add ToolGroupAccordion component

Collapsible accordion section for tool groups with:
- Two-line header (label + description)
- MCP connection status indicator
- Enabled count badge
- Dropdown menu for bulk actions

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Create ToolRow Component

Replace the card-based ToolCard with a dense, table-like row component.

**Files:**
- Create: `packages/preferences/src/settings/tools/tool-row.tsx`
- Create: `packages/preferences/src/settings/tools/__tests__/tool-row.test.tsx`

**Step 1: Write the failing test**

```tsx
// packages/preferences/src/settings/tools/__tests__/tool-row.test.tsx
/**
 * Tool Row Tests
 */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDisplayMetadata } from '../types';
import { ToolRow } from '../tool-row';

// Mock @brainstrike/agent/client
vi.mock('@brainstrike/agent/client', () => ({
  TOOL_CATEGORIES: {
    retrieval: { id: 'retrieval', label: 'Retrieval' },
    action: { id: 'action', label: 'Action' },
    analysis: { id: 'analysis', label: 'Analysis' },
  },
  TOOL_LOADING_TIERS: {
    critical: { id: 'critical', label: 'Critical' },
    conditional: { id: 'conditional', label: 'Conditional' },
    deferred: { id: 'deferred', label: 'Deferred' },
  },
}));

// Mock @brainstrike/ui
vi.mock('@brainstrike/ui', () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-testid="badge" data-variant={variant}>{children}</span>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    'data-testid': testId,
  }: {
    checked: boolean;
    onCheckedChange: () => void;
    'data-testid'?: string;
  }) => (
    <button
      aria-checked={checked}
      data-testid={testId}
      onClick={onCheckedChange}
      role="switch"
      type="button"
    >
      {checked ? 'On' : 'Off'}
    </button>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  cn: (...args: (string | undefined)[]) => args.filter(Boolean).join(' '),
}));

describe('ToolRow', () => {
  const mockTool: ToolDisplayMetadata = {
    id: 'brainstrike.hybridSearch',
    source: 'native',
    category: 'retrieval',
    loadingTier: 'critical',
    description: 'Search across documents using hybrid semantic and keyword search',
    enabled: true,
    estimatedTokens: 150,
    requiresApproval: false,
  };

  const mockOnToggle = vi.fn();
  const mockOnExpand = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders the tool name in monospace', () => {
      render(<ToolRow onToggle={mockOnToggle} tool={mockTool} />);
      const toolName = screen.getByText('brainstrike.hybridSearch');
      expect(toolName).toBeInTheDocument();
      expect(toolName).toHaveClass('font-mono');
    });

    it('renders abbreviated tier label for conditional', () => {
      const conditionalTool = { ...mockTool, loadingTier: 'conditional' as const };
      render(<ToolRow onToggle={mockOnToggle} tool={conditionalTool} />);
      expect(screen.getByText('Cond.')).toBeInTheDocument();
    });

    it('renders abbreviated tier label for deferred', () => {
      const deferredTool = { ...mockTool, loadingTier: 'deferred' as const };
      render(<ToolRow onToggle={mockOnToggle} tool={deferredTool} />);
      expect(screen.getByText('Defer.')).toBeInTheDocument();
    });

    it('renders token count', () => {
      render(<ToolRow onToggle={mockOnToggle} tool={mockTool} />);
      expect(screen.getByText('~150')).toBeInTheDocument();
    });

    it('shows warning icon for tools requiring approval', () => {
      const toolWithApproval = { ...mockTool, requiresApproval: true };
      render(<ToolRow onToggle={mockOnToggle} tool={toolWithApproval} />);
      expect(screen.getByTestId('requires-approval-icon')).toBeInTheDocument();
    });
  });

  describe('toggle functionality', () => {
    it('calls onToggle when switch is clicked', () => {
      render(<ToolRow onToggle={mockOnToggle} tool={mockTool} />);
      const toggle = screen.getByTestId('toggle-brainstrike.hybridSearch');
      fireEvent.click(toggle);
      expect(mockOnToggle).toHaveBeenCalledWith('brainstrike.hybridSearch', true);
    });
  });

  describe('expand/collapse', () => {
    it('calls onExpand when row is clicked', () => {
      render(<ToolRow onExpand={mockOnExpand} onToggle={mockOnToggle} tool={mockTool} />);
      const row = screen.getByTestId('tool-row-brainstrike.hybridSearch');
      fireEvent.click(row);
      expect(mockOnExpand).toHaveBeenCalledWith('brainstrike.hybridSearch');
    });

    it('does not call onExpand when toggle is clicked', () => {
      render(<ToolRow onExpand={mockOnExpand} onToggle={mockOnToggle} tool={mockTool} />);
      const toggle = screen.getByTestId('toggle-brainstrike.hybridSearch');
      fireEvent.click(toggle);
      expect(mockOnExpand).not.toHaveBeenCalled();
    });
  });

  describe('visual states', () => {
    it('applies muted opacity when disabled', () => {
      const disabledTool = { ...mockTool, enabled: false };
      render(<ToolRow onToggle={mockOnToggle} tool={disabledTool} />);
      const row = screen.getByTestId('tool-row-brainstrike.hybridSearch');
      expect(row).toHaveClass('opacity-70');
    });

    it('shows expanded indicator when expanded', () => {
      render(<ToolRow expanded={true} onToggle={mockOnToggle} tool={mockTool} />);
      expect(screen.getByTestId('chevron-down')).toBeInTheDocument();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/preferences -- --run tool-row.test`
Expected: FAIL with "Cannot find module '../tool-row'"

**Step 3: Write minimal implementation**

```tsx
// packages/preferences/src/settings/tools/tool-row.tsx
/**
 * Tool Row
 *
 * Dense, table-like row for displaying a single tool.
 * Click to expand for details, toggle to enable/disable.
 */

import { TOOL_CATEGORIES, TOOL_LOADING_TIERS } from '@brainstrike/agent/client';
import {
  Badge,
  cn,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import type { ToolDisplayMetadata } from './types';

export interface ToolRowProps {
  /** Tool data to display */
  tool: ToolDisplayMetadata;
  /** Whether this row is expanded */
  expanded?: boolean;
  /** Callback when toggle is clicked */
  onToggle: (toolId: string, currentlyEnabled: boolean) => Promise<void>;
  /** Callback when row is clicked to expand */
  onExpand?: (toolId: string) => void;
}

/**
 * Get abbreviated tier label for dense display.
 */
function getAbbreviatedTier(tier: string): string {
  switch (tier) {
    case 'conditional':
      return 'Cond.';
    case 'deferred':
      return 'Defer.';
    default:
      return TOOL_LOADING_TIERS[tier as keyof typeof TOOL_LOADING_TIERS]?.label ?? tier;
  }
}

/**
 * Get badge variant based on loading tier.
 */
function getTierBadgeVariant(tier: string): 'default' | 'secondary' | 'outline' {
  switch (tier) {
    case 'critical':
      return 'default';
    case 'conditional':
      return 'secondary';
    default:
      return 'outline';
  }
}

export function ToolRow({ tool, expanded = false, onToggle, onExpand }: ToolRowProps) {
  const tierLabel = getAbbreviatedTier(tool.loadingTier);
  const categoryInfo = TOOL_CATEGORIES[tool.category];

  const handleRowClick = () => {
    onExpand?.(tool.id);
  };

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    void onToggle(tool.id, tool.enabled);
  };

  return (
    <div
      className={cn(
        'group flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50',
        !tool.enabled && 'opacity-70'
      )}
      data-testid={`tool-row-${tool.id}`}
      onClick={handleRowClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleRowClick();
        }
      }}
      role="button"
      tabIndex={0}
    >
      {/* Expand chevron */}
      <div className="w-4 shrink-0">
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" data-testid="chevron-down" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" data-testid="chevron-right" />
        )}
      </div>

      {/* Tool name */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <code className="truncate font-mono text-sm">{tool.id}</code>
              {tool.requiresApproval && (
                <AlertTriangle
                  className="h-3.5 w-3.5 shrink-0 text-yellow-600"
                  data-testid="requires-approval-icon"
                />
              )}
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs" side="top">
          <p className="font-medium">{tool.id}</p>
          <p className="text-muted-foreground">{tool.description}</p>
        </TooltipContent>
      </Tooltip>

      {/* Tier badge */}
      <Badge
        className="w-16 shrink-0 justify-center text-[10px]"
        variant={getTierBadgeVariant(tool.loadingTier)}
      >
        {tierLabel}
      </Badge>

      {/* Category */}
      <span className="w-20 shrink-0 truncate text-muted-foreground text-xs">
        {categoryInfo?.label ?? tool.category}
      </span>

      {/* Token count */}
      <span className="w-12 shrink-0 text-right text-muted-foreground text-xs">
        ~{tool.estimatedTokens}
      </span>

      {/* Toggle */}
      <div onClick={handleToggleClick} role="presentation">
        <Switch
          checked={tool.enabled}
          data-testid={`toggle-${tool.id}`}
          onCheckedChange={() => {}}
        />
      </div>
    </div>
  );
}

export default ToolRow;
```

**Step 4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/preferences -- --run tool-row.test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/preferences/src/settings/tools/tool-row.tsx packages/preferences/src/settings/tools/__tests__/tool-row.test.tsx
git commit -m "feat(preferences): add ToolRow component

Dense table-like row for tool display with:
- Monospace tool name with tooltip for description
- Abbreviated tier labels (Cond., Defer.)
- Category and token count columns
- Toggle switch with click isolation
- Visual state for disabled tools (opacity-70)
- Keyboard navigation support

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Create ToolRowExpanded Component

Create the expanded details view shown when a tool row is clicked.

**Files:**
- Create: `packages/preferences/src/settings/tools/tool-row-expanded.tsx`
- Create: `packages/preferences/src/settings/tools/__tests__/tool-row-expanded.test.tsx`

**Step 1: Write the failing test**

```tsx
// packages/preferences/src/settings/tools/__tests__/tool-row-expanded.test.tsx
/**
 * Tool Row Expanded Tests
 */

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolDisplayMetadata } from '../types';
import { ToolRowExpanded } from '../tool-row-expanded';

// Mock @brainstrike/ui
vi.mock('@brainstrike/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick} type="button">{children}</button>
  ),
  cn: (...args: (string | undefined)[]) => args.filter(Boolean).join(' '),
}));

// Mock ToolPlayground
vi.mock('../tool-playground', () => ({
  ToolPlayground: ({ toolId }: { toolId: string }) => (
    <div data-testid={`playground-${toolId}`}>Tool Playground</div>
  ),
}));

describe('ToolRowExpanded', () => {
  const mockTool: ToolDisplayMetadata = {
    id: 'brainstrike.hybridSearch',
    source: 'native',
    category: 'retrieval',
    loadingTier: 'critical',
    description: 'Search across documents using hybrid semantic and keyword search',
    enabled: true,
    estimatedTokens: 150,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['query'],
    },
  };

  describe('rendering', () => {
    it('renders full description without truncation', () => {
      render(<ToolRowExpanded tool={mockTool} />);
      expect(
        screen.getByText('Search across documents using hybrid semantic and keyword search')
      ).toBeInTheDocument();
    });

    it('renders MCP server name for MCP tools', () => {
      const mcpTool = { ...mockTool, source: 'mcp' as const, serverName: '@github/mcp' };
      render(<ToolRowExpanded tool={mcpTool} />);
      expect(screen.getByText('@github/mcp')).toBeInTheDocument();
    });

    it('renders playground when onExecuteTest is provided', () => {
      const mockExecute = vi.fn();
      render(<ToolRowExpanded onExecuteTest={mockExecute} tool={mockTool} />);
      expect(screen.getByTestId('playground-brainstrike.hybridSearch')).toBeInTheDocument();
    });

    it('does not render playground when onExecuteTest is not provided', () => {
      render(<ToolRowExpanded tool={mockTool} />);
      expect(screen.queryByTestId('playground-brainstrike.hybridSearch')).not.toBeInTheDocument();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/preferences -- --run tool-row-expanded`
Expected: FAIL

**Step 3: Write minimal implementation**

```tsx
// packages/preferences/src/settings/tools/tool-row-expanded.tsx
/**
 * Tool Row Expanded
 *
 * Expanded details view for a tool row, showing full description,
 * metadata, and optional playground.
 */

import { Badge, cn } from '@brainstrike/ui';
import { ToolPlayground } from './tool-playground';
import type { ToolDisplayMetadata, ToolExecutionResult } from './types';

export interface ToolRowExpandedProps {
  /** Tool data to display */
  tool: ToolDisplayMetadata;
  /** Callback to execute a test (enables playground) */
  onExecuteTest?: (toolId: string, input: unknown) => Promise<ToolExecutionResult>;
}

export function ToolRowExpanded({ tool, onExecuteTest }: ToolRowExpandedProps) {
  return (
    <div
      className={cn(
        'ml-6 mt-1 rounded-md border border-border/50 bg-muted/20 p-3',
        'animate-in slide-in-from-top-1 fade-in duration-200'
      )}
      data-testid={`tool-row-expanded-${tool.id}`}
    >
      {/* Description */}
      <p className="mb-3 text-sm">{tool.description}</p>

      {/* Metadata */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
        {tool.source === 'mcp' && tool.serverName && (
          <div className="flex items-center gap-1.5">
            <span className="font-medium">Server:</span>
            <span>{tool.serverName}</span>
          </div>
        )}
        {tool.requiresApproval && (
          <Badge className="text-[10px]" variant="outline">
            Requires Approval
          </Badge>
        )}
      </div>

      {/* Playground */}
      {onExecuteTest && (
        <ToolPlayground
          inputSchema={tool.inputSchema}
          onExecute={(input: unknown) => onExecuteTest(tool.id, input)}
          toolId={tool.id}
        />
      )}
    </div>
  );
}

export default ToolRowExpanded;
```

**Step 4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/preferences -- --run tool-row-expanded`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/preferences/src/settings/tools/tool-row-expanded.tsx packages/preferences/src/settings/tools/__tests__/tool-row-expanded.test.tsx
git commit -m "feat(preferences): add ToolRowExpanded component

Expanded details panel for tool rows with:
- Full description (no truncation)
- Server name for MCP tools
- Requires Approval badge
- Optional playground integration
- Slide-in animation

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Update ToolsFilterBar for Compact Design

Refactor the filter bar to be more compact with inline stats.

**Files:**
- Modify: `packages/preferences/src/settings/tools/tools-filter-bar.tsx`
- Modify: `packages/preferences/src/settings/tools/__tests__/tools-filter-bar.test.tsx`
- Modify: `packages/preferences/src/settings/tools/types.ts` (add stats prop)

**Step 1: Update types**

```typescript
// Add to types.ts ToolsFilterBarProps:
/** Total tool count for display */
totalCount?: number;
```

**Step 2: Write test for new functionality**

Add to existing test file:

```tsx
it('displays tool count when provided', () => {
  render(<ToolsFilterBar {...defaultProps} totalCount={28} />);
  expect(screen.getByText('28 tools')).toBeInTheDocument();
});

it('shows reset button as icon only', () => {
  render(<ToolsFilterBar {...defaultProps} />);
  const resetButton = screen.getByTestId('reset-filters');
  expect(resetButton.querySelector('svg')).toBeInTheDocument();
});
```

**Step 3: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/preferences -- --run tools-filter-bar`
Expected: FAIL on new tests

**Step 4: Update implementation**

```tsx
// packages/preferences/src/settings/tools/tools-filter-bar.tsx
/**
 * Tools Filter Bar
 *
 * Compact search and filter controls with inline stats.
 */

import { TOOL_CATEGORIES, TOOL_LOADING_TIERS } from '@brainstrike/agent/client';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { RotateCcw, Search } from 'lucide-react';
import type { ToolsFilterBarProps } from './types';

export function ToolsFilterBar({
  searchQuery,
  onSearchChange,
  categoryFilter,
  onCategoryChange,
  tierFilter,
  onTierChange,
  onReset,
  totalCount,
}: ToolsFilterBarProps) {
  const hasFilters = searchQuery || categoryFilter !== 'all' || tierFilter !== 'all';

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-muted/30 p-2"
      data-testid="tools-filter-bar"
    >
      {/* Search */}
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-8 pl-8 text-sm"
          data-testid="search-input"
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search tools..."
          type="text"
          value={searchQuery}
        />
      </div>

      {/* Category Filter */}
      <Select
        onValueChange={(value) => onCategoryChange(value as typeof categoryFilter)}
        value={categoryFilter}
      >
        <SelectTrigger className="h-8 w-[130px] text-sm" data-testid="category-filter">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Categories</SelectItem>
          {Object.values(TOOL_CATEGORIES).map((cat) => (
            <SelectItem key={cat.id} value={cat.id}>
              {cat.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Tier Filter */}
      <Select
        onValueChange={(value) => onTierChange(value as typeof tierFilter)}
        value={tierFilter}
      >
        <SelectTrigger className="h-8 w-[120px] text-sm" data-testid="tier-filter">
          <SelectValue placeholder="Tier" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Tiers</SelectItem>
          {Object.values(TOOL_LOADING_TIERS).map((tier) => (
            <SelectItem key={tier.id} value={tier.id}>
              {tier.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Stats */}
      {totalCount !== undefined && (
        <span className="px-2 text-muted-foreground text-sm">{totalCount} tools</span>
      )}

      {/* Reset Button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            className="h-8 w-8 p-0"
            data-testid="reset-filters"
            disabled={!hasFilters}
            onClick={onReset}
            size="sm"
            variant="ghost"
          >
            <RotateCcw className="h-4 w-4" />
            <span className="sr-only">Reset filters</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reset filters</TooltipContent>
      </Tooltip>
    </div>
  );
}

export default ToolsFilterBar;
```

**Step 5: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/preferences -- --run tools-filter-bar`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/preferences/src/settings/tools/tools-filter-bar.tsx packages/preferences/src/settings/tools/__tests__/tools-filter-bar.test.tsx packages/preferences/src/settings/tools/types.ts
git commit -m "refactor(preferences): compact ToolsFilterBar design

- Add search icon inside input
- Add inline tool count display
- Change reset button to icon-only with tooltip
- Add border and background for visual containment
- Disable reset button when no filters active

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Update TokenBudgetSummary for Compact Mode

Make the token budget summary more compact with single-line display.

**Files:**
- Modify: `packages/preferences/src/settings/tools/token-budget-summary.tsx`
- Modify: `packages/preferences/src/settings/tools/__tests__/token-budget-summary.test.tsx`

**Step 1: Write test for compact layout**

Add to existing test file:

```tsx
it('displays budget info in single line when collapsed', () => {
  render(<TokenBudgetSummary {...defaultProps} />);
  // Should show inline: "Token Budget  [progress bar]  2,450 / 8K (31%)"
  expect(screen.getByText('Token Budget')).toBeInTheDocument();
  expect(screen.getByTestId('progress-bar-inline')).toBeInTheDocument();
});
```

**Step 2: Update implementation for compact layout**

```tsx
// Update the return JSX in token-budget-summary.tsx
return (
  <div
    className={cn(
      'rounded-lg border p-2 transition-colors',
      isError
        ? 'border-destructive/50 bg-destructive/5'
        : isWarning
          ? 'border-yellow-500/50 bg-yellow-500/5'
          : 'border-border/50 bg-muted/30'
    )}
    data-testid="token-budget-summary"
  >
    <button
      className="flex w-full items-center gap-3"
      onClick={() => setExpanded(!expanded)}
      type="button"
    >
      <span className="shrink-0 font-medium text-sm">Token Budget</span>

      {/* Inline Progress Bar */}
      <div
        className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
        data-testid="progress-bar-inline"
      >
        <div className="flex h-full">
          <div
            className="bg-primary transition-all"
            style={{ width: `${Math.min(criticalPercent, 100)}%` }}
          />
          <div
            className="bg-secondary transition-all"
            style={{ width: `${Math.min(conditionalPercent, 100 - criticalPercent)}%` }}
          />
        </div>
      </div>

      <span className="shrink-0 text-muted-foreground text-sm">
        {usedTokens.toLocaleString()} / {(totalBudget / 1000).toFixed(0)}K
        <span className="ml-1.5">({usagePercent.toFixed(0)}%)</span>
      </span>

      <ChevronDown
        className={cn(
          'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
          expanded && 'rotate-180'
        )}
      />
    </button>

    {/* Expanded Details */}
    {expanded && (
      <div className="mt-2 flex flex-wrap gap-4 border-t border-border/50 pt-2 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-primary" />
          <span>Critical ({criticalTokens.toLocaleString()})</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-secondary" />
          <span>Conditional ({conditionalTokens.toLocaleString()})</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-muted" />
          <span>Available ({availableTokens.toLocaleString()})</span>
        </div>
      </div>
    )}
  </div>
);
```

**Step 3: Run test and commit**

Run: `pnpm test --filter @brainstrike/preferences -- --run token-budget-summary`

```bash
git add packages/preferences/src/settings/tools/token-budget-summary.tsx packages/preferences/src/settings/tools/__tests__/token-budget-summary.test.tsx
git commit -m "refactor(preferences): compact TokenBudgetSummary

- Single-line layout with inline progress bar
- Collapsible legend section
- Reduced padding for density
- Chevron rotation animation

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Update McpConfigAlert for Streamlined Design

Make the MCP config alert more compact and dismissable.

**Files:**
- Modify: `packages/preferences/src/settings/tools/mcp-config-alert.tsx`
- Modify: `packages/preferences/src/settings/tools/__tests__/mcp-config-alert.test.tsx`
- Modify: `packages/preferences/src/settings/tools/types.ts` (add onDismiss prop)

**Step 1: Add onDismiss to types**

```typescript
// Add to McpConfigAlertProps in mcp-config-alert.tsx:
/** Callback when alert is dismissed */
onDismiss?: () => void;
```

**Step 2: Write test for dismiss functionality**

```tsx
it('calls onDismiss when close button is clicked', () => {
  const onDismiss = vi.fn();
  render(<McpConfigAlert {...defaultProps} onDismiss={onDismiss} />);
  const closeButton = screen.getByTestId('dismiss-alert');
  fireEvent.click(closeButton);
  expect(onDismiss).toHaveBeenCalled();
});

it('renders path inline with message', () => {
  render(<McpConfigAlert {...defaultProps} />);
  // Should be on same line or close together
  expect(screen.getByText(/MCP config not found/)).toBeInTheDocument();
});
```

**Step 3: Update implementation**

```tsx
// Streamlined single/two-line layout with dismiss button
return (
  <div
    className="flex items-start gap-3 rounded-lg border border-yellow-500/50 bg-yellow-500/5 p-3"
    data-testid="mcp-config-alert"
  >
    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-500" />

    <div className="min-w-0 flex-1">
      <p className="text-sm text-yellow-800 dark:text-yellow-200">
        MCP config not found
        {configInfo.path && (
          <code className="ml-1.5 rounded bg-yellow-500/10 px-1 py-0.5 font-mono text-[11px]">
            {configInfo.path}
          </code>
        )}
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          className="h-7 gap-1.5 px-2.5 text-xs"
          onClick={onSelectConfig}
          size="sm"
          variant="outline"
        >
          <FolderOpen className="h-3 w-3" />
          Select File
        </Button>
        {onCreateSample && (
          <Button
            className="h-7 gap-1.5 px-2.5 text-xs"
            onClick={onCreateSample}
            size="sm"
            variant="ghost"
          >
            <FileJson className="h-3 w-3" />
            Create Sample
          </Button>
        )}
        <Button
          className="h-7 gap-1.5 px-2.5 text-xs"
          onClick={onResetConfig}
          size="sm"
          variant="ghost"
        >
          <RotateCcw className="h-3 w-3" />
          Reset Default
        </Button>
      </div>
    </div>

    {onDismiss && (
      <Button
        className="h-6 w-6 shrink-0 p-0"
        data-testid="dismiss-alert"
        onClick={onDismiss}
        size="sm"
        variant="ghost"
      >
        <X className="h-3.5 w-3.5" />
        <span className="sr-only">Dismiss</span>
      </Button>
    )}
  </div>
);
```

**Step 4: Run test and commit**

```bash
git add packages/preferences/src/settings/tools/mcp-config-alert.tsx packages/preferences/src/settings/tools/__tests__/mcp-config-alert.test.tsx
git commit -m "refactor(preferences): streamline McpConfigAlert

- Compact single-line message with inline path
- Dismissable with close button
- Smaller action buttons
- Reduced vertical padding

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Rewrite UnifiedToolsSettings with New Components

Integrate all new components into the main settings view.

**Files:**
- Modify: `packages/preferences/src/settings/tools/unified-tools-settings.tsx`
- Modify: `packages/preferences/src/settings/tools/__tests__/unified-tools-settings.test.tsx`

**Step 1: Update the component to use Accordion layout**

Key changes:
1. Import `Accordion` from `@brainstrike/ui`
2. Import new `ToolGroupAccordion`, `ToolRow`, `ToolRowExpanded` components
3. Replace `Card` groups with `Accordion` using `type="multiple"`
4. Remove fixed `ScrollArea` height
5. Track expanded tool state per group
6. Remove separate `McpServerStatus` card - status now in accordion headers
7. Pass `totalCount` to filter bar
8. Add dismiss state for MCP config alert

**Step 2: Update tests to match new structure**

Update mocks and assertions for:
- Accordion-based layout
- New component imports
- Removed McpServerStatus card
- Stats in filter bar instead of separate badges

**Step 3: Implement and commit**

```bash
git add packages/preferences/src/settings/tools/unified-tools-settings.tsx packages/preferences/src/settings/tools/__tests__/unified-tools-settings.test.tsx
git commit -m "refactor(preferences): accordion-based UnifiedToolsSettings

Major redesign integrating new components:
- Accordion layout for collapsible tool groups
- ToolRow for dense tool display
- ToolRowExpanded for details
- MCP status integrated in accordion headers
- Removed separate McpServerStatus card
- Stats moved to filter bar
- Dismissable MCP config alert
- Removed fixed scroll height

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 8: Remove Deprecated McpServerStatus Component

Clean up the now-unused McpServerStatus component.

**Files:**
- Delete: `packages/preferences/src/settings/tools/mcp-server-status.tsx`
- Delete: `packages/preferences/src/settings/tools/__tests__/mcp-server-status.test.tsx`
- Modify: `packages/preferences/src/settings/tools/index.tsx` (remove export)

**Step 1: Remove files and update exports**

```bash
rm packages/preferences/src/settings/tools/mcp-server-status.tsx
rm packages/preferences/src/settings/tools/__tests__/mcp-server-status.test.tsx
```

**Step 2: Update index.tsx**

Remove: `export * from './mcp-server-status';`

**Step 3: Run full test suite**

Run: `pnpm test --filter @brainstrike/preferences`
Expected: All tests pass

**Step 4: Commit**

```bash
git add -A packages/preferences/src/settings/tools/
git commit -m "refactor(preferences): remove McpServerStatus

Status display now integrated into accordion headers.
Removes unused component and tests.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 9: Update Exports and Deprecate ToolCard

Update exports and deprecate the old ToolCard component.

**Files:**
- Modify: `packages/preferences/src/settings/tools/index.tsx`
- Modify: `packages/preferences/src/settings/tools/tool-card.tsx` (add deprecation)

**Step 1: Update index.tsx exports**

```tsx
// packages/preferences/src/settings/tools/index.tsx
export * from './mcp-config-alert';
export * from './token-budget-summary';
export * from './tool-group-accordion';
export * from './tool-playground';
export * from './tool-row';
export * from './tool-row-expanded';
export * from './tools-filter-bar';
export * from './types';
export * from './unified-tools-settings';

// Deprecated - use ToolRow instead
export * from './tool-card';
```

**Step 2: Add deprecation notice to ToolCard**

```tsx
/**
 * Tool Card
 *
 * @deprecated Use ToolRow for dense display, ToolRowExpanded for details.
 * This component will be removed in a future version.
 */
```

**Step 3: Commit**

```bash
git add packages/preferences/src/settings/tools/index.tsx packages/preferences/src/settings/tools/tool-card.tsx
git commit -m "refactor(preferences): update tool settings exports

- Add new component exports
- Deprecate ToolCard (use ToolRow + ToolRowExpanded)
- Remove McpServerStatus export

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 10: Final Integration and Validation

Run full validation pipeline and fix any issues.

**Step 1: Run linting**

Run: `pnpm lint --filter @brainstrike/preferences`

**Step 2: Run type checking**

Run: `pnpm type-check --filter @brainstrike/preferences`

**Step 3: Run all tests**

Run: `pnpm test --filter @brainstrike/preferences`

**Step 4: Build the package**

Run: `pnpm build --filter @brainstrike/preferences`

**Step 5: Visual verification**

Run: `pnpm dev --filter @brainstrike/web`
Navigate to Settings > AI Tools and verify:
- Accordion groups collapse/expand
- Tool rows display correctly
- Filter bar is compact
- Token budget is single-line
- MCP status shows in accordion headers

**Step 6: Final commit**

```bash
git add -A
git commit -m "chore(preferences): finalize AI Tools settings redesign

Complete implementation of accordion-based layout:
- Dense but organized tool display
- Collapsible groups with status
- Compact filter bar with inline stats
- Single-line token budget summary
- Full keyboard navigation

Closes: AI Tools settings redesign

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Summary

| Task | Component | Action |
|------|-----------|--------|
| 1 | ToolGroupAccordion | Create new |
| 2 | ToolRow | Create new |
| 3 | ToolRowExpanded | Create new |
| 4 | ToolsFilterBar | Refactor |
| 5 | TokenBudgetSummary | Refactor |
| 6 | McpConfigAlert | Refactor |
| 7 | UnifiedToolsSettings | Major rewrite |
| 8 | McpServerStatus | Delete |
| 9 | Exports | Update |
| 10 | Validation | Test + verify |

**Estimated tasks:** 10
**New files:** 6 (3 components + 3 tests)
**Modified files:** 8
**Deleted files:** 2
