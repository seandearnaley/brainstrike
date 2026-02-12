---
title: "Unified Tools Ui Design 2026 02 01"
---

# Unified Tools UI Design

**Date:** 2026-02-01
**Status:** Approved
**Author:** Claude (with user validation)

## Overview

Complete overhaul of the tools management UI to create a single unified view for all agent tools (native BrainStrike + MCP) with developer/debug playground functionality, token budget visualization, and world-class 2026 UX.

## Design Decisions

| Decision | Choice |
|----------|--------|
| Playground scope | Developer/Debug Mode - test tool configurations before agent use |
| UI structure | Single Unified View - all tools in one list with source badges |
| Input handling | JSON Editor Only - Monaco-based, schema-aware |
| Token budget | Budget Aware - show per-tool tokens + summary bar with tier breakdown |
| MCP integration | Integrated - server status at top, tools grouped by server |
| Migration | Clean break - delete old MCP panel, no deprecation |

## Architecture

### Component Hierarchy

```
UnifiedToolsSettings (main container)
├── TokenBudgetSummary (budget bar at top)
├── McpServerStatus (desktop-only, collapsible header)
├── ToolsFilterBar (search, category filter, tier filter)
├── ToolsList (virtualized for performance)
│   └── ToolCard (individual tool with expand/collapse)
│       ├── ToolHeader (id, badges, toggle)
│       ├── ToolDetails (description, schema preview)
│       └── ToolPlayground (JSON editor + execute button)
└── ToolExecutionPanel (shows result/error of test runs)
```

### Data Flow

- `UnifiedToolRegistry` from `@brainstrike/agent` is the single source of truth
- UI receives tools via `ToolsSettingsOperations` interface
- Tool execution for playground uses `executeToolTest` operation
- Budget calculations use `TokenBudgetManager`

### Platform Adaptation

- **Desktop:** Full MCP integration, server status, native + MCP tools
- **Web:** Native tools only, MCP sections don't render
- Same component, conditional rendering based on `mcpAvailable` prop

## Component Designs

### Token Budget Summary

Visual budget bar at the top showing context usage:

```
┌─────────────────────────────────────────────────────────────────┐
│ Token Budget                                         12,800 / 16K │
│ ██████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  80%    │
│ ■ Critical (2,400)  ■ Conditional (8,200)  ■ Available (2,200)  │
└─────────────────────────────────────────────────────────────────┘
```

- Three-segment progress bar: Critical, Conditional, Available
- Collapsed by default; expands on click
- Warning state (amber) >90%; error state (red) when exceeded

### Tool Card (Collapsed)

```
┌─────────────────────────────────────────────────────────────────┐
│ ○ brainstrike.hybridSearch                                [ON]  │
│   Critical  Retrieval  ~200 tokens                              │
│   Semantic + keyword search with RRF fusion                     │
└─────────────────────────────────────────────────────────────────┘
```

### Tool Card (Expanded with Playground)

```
┌─────────────────────────────────────────────────────────────────┐
│ ● brainstrike.hybridSearch                                [ON]  │
│   Critical  Retrieval  ~200 tokens  ⚠ Requires Approval         │
├─────────────────────────────────────────────────────────────────┤
│ Semantic + keyword search with RRF fusion for finding relevant  │
│ code and documentation chunks.                                  │
├─────────────────────────────────────────────────────────────────┤
│ Test Tool                                              [▶ Run]  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ {                                                           │ │
│ │   "query": "authentication middleware",                     │ │
│ │   "embeddingSetId": "set-123",                              │ │
│ │   "limit": 10                                               │ │
│ │ }                                                           │ │
│ └─────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ Result                                              ✓ 245ms     │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ { "results": [...], "metadata": { "totalMs": 150 } }        │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### MCP Server Status (Desktop-only)

```
┌─────────────────────────────────────────────────────────────────┐
│ MCP Servers                                         [Refresh]   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ ● github-mcp      Connected   12 tools    [Enable All]      │ │
│ │ ● filesystem      Connected    8 tools    [Disable All]     │ │
│ │ ○ slack-mcp       Disconnected            [Retry]           │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ Config: ~/.config/brainstrike/mcp.json         [Open Config]   │
└─────────────────────────────────────────────────────────────────┘
```

### Tool Grouping

```
▼ Native Tools (3)                           [Enable All] [Disable All]
   └── brainstrike.hybridSearch
   └── brainstrike.queueStatus
   └── brainstrike.packContext

▼ github-mcp (12)                            [Enable All] [Disable All]
   └── mcp__github__create_issue
   └── mcp__github__list_repos
   └── ...

▶ filesystem (8)                             [Enable All] [Disable All]
   (collapsed)
```

## File Structure

### New Files

```
packages/preferences/src/settings/tools/
├── index.tsx                        # Export all components
├── unified-tools-settings.tsx       # Main container component
├── token-budget-summary.tsx         # Budget visualization bar
├── tools-filter-bar.tsx             # Search + filter controls
├── tool-card.tsx                    # Individual tool with playground
├── tool-playground.tsx              # JSON editor + execute panel
├── mcp-server-status.tsx            # Desktop-only server management
├── use-tool-execution.ts            # Hook for playground execution
├── __tests__/
│   ├── token-budget-summary.test.tsx
│   ├── tool-card.test.tsx
│   ├── tool-playground.test.tsx
│   ├── tools-filter-bar.test.tsx
│   ├── mcp-server-status.test.tsx
│   └── unified-tools-settings.test.tsx
```

### Files to Delete

- `apps/desktop/src/renderer/components/settings/mcp-tools-panel.tsx`
- `packages/preferences/src/settings/tools/tools-settings-section.tsx` (old version)

## Extended Operations Interface

```typescript
interface ToolsSettingsOperations {
  // Existing
  getTools: () => Promise<ToolDisplayMetadata[]>;
  getStats: () => Promise<ToolStats>;
  enableTools: (toolIds: string[]) => Promise<void>;
  disableTools: (toolIds: string[]) => Promise<void>;
  resetTools: () => Promise<void>;
  enableBySource?: (source: 'native' | 'mcp') => Promise<void>;
  disableBySource?: (source: 'native' | 'mcp') => Promise<void>;

  // New for playground
  executeToolTest?: (toolId: string, input: unknown) => Promise<ToolExecutionResult>;

  // New for MCP server management
  getMcpServerStatus?: () => Promise<McpServerInfo[]>;
  refreshMcpServers?: () => Promise<void>;
  openMcpConfig?: () => Promise<void>;
}

interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

interface McpServerInfo {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
  error?: string;
}
```

## Testing Strategy (TDD)

### Test Files

```
packages/preferences/src/settings/tools/__tests__/
├── token-budget-summary.test.tsx
├── tool-card.test.tsx
├── tool-playground.test.tsx
├── tools-filter-bar.test.tsx
├── mcp-server-status.test.tsx
└── unified-tools-settings.test.tsx
```

### Test Categories

1. **Rendering** - Components render correctly with various props
2. **Interaction** - Click handlers, toggles, expand/collapse
3. **Filtering** - Search and dropdowns filter correctly
4. **Playground** - JSON validation, execution, results display
5. **Budget** - Progress bar reflects usage accurately
6. **Accessibility** - Keyboard nav, ARIA labels, focus management

### Key Scenarios

- Empty state (no tools registered)
- Native-only mode (web platform)
- Mixed native + MCP mode (desktop)
- Tool execution success and failure
- Budget warning/error thresholds
- MCP server disconnection handling

## Implementation Order

1. Write tests first (TDD)
2. `token-budget-summary.tsx`
3. `tools-filter-bar.tsx`
4. `tool-card.tsx` (without playground)
5. `tool-playground.tsx`
6. `mcp-server-status.tsx`
7. `unified-tools-settings.tsx` (compose all)
8. Wire into desktop/web apps
9. Delete old files

## App Integration

### Desktop (`apps/desktop/.../settings/page-content.tsx`)

```typescript
import { createToolsSettingsCategory } from '@brainstrike/preferences';

// In categories array - replaces 'mcp-integrations' category:
createToolsSettingsCategory({
  operations: {
    getTools: () => window.tools.list(),
    enableTools: (ids) => window.tools.enable(ids),
    disableTools: (ids) => window.tools.disable(ids),
    executeToolTest: (id, input) => window.tools.execute(id, input),
    getMcpServerStatus: () => window.mcp.getServerStatus(),
    refreshMcpServers: () => window.mcp.refresh(),
    openMcpConfig: () => window.mcp.openConfig(),
  },
  mcpAvailable: true,
  budgetManager: createBudgetManagerForTier('large'),
}),
```

### Web (`apps/web/.../settings/page-content.tsx`)

```typescript
createToolsSettingsCategory({
  operations: {
    getTools: () => unifiedRegistry.getAllTools(),
    enableTools: (ids) => unifiedRegistry.enableTools(ids),
    disableTools: (ids) => unifiedRegistry.disableTools(ids),
    executeToolTest: (id, input) => executeNativeTool(id, input),
  },
  mcpAvailable: false,
  budgetManager: createBudgetManagerForTier('medium'),
}),
```
