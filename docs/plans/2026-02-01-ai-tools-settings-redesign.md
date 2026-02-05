# AI Tools Settings Redesign

**Date:** 2026-02-01
**Status:** Approved
**Focus:** Visual Polish + Information Architecture
**Aesthetic:** Dense but Organized (VS Code/JetBrains style)

## Overview

Redesign the AI Tools settings panel in `@brainstrike/preferences` to improve usability, visual clarity, and information density for power users.

## Design Principles

1. **Dense but scannable** - Maximize information per viewport without sacrificing readability
2. **Collapsible groups** - Users control information density via accordion sections
3. **Inline actions** - Reduce clicks by surfacing controls in context
4. **Keyboard-first** - Full navigation without mouse

## Layout Structure

```
┌─────────────────────────────────────────────────────────────┐
│  HEADER: Token Budget Bar (collapsible summary)             │
├─────────────────────────────────────────────────────────────┤
│  FILTER BAR: Search | Category ▼ | Tier ▼ | Stats | Reset  │
├─────────────────────────────────────────────────────────────┤
│  MCP CONFIG ALERT (if missing - dismissable)                │
├─────────────────────────────────────────────────────────────┤
│  ACCORDION GROUPS                                           │
│  ├─ Native Tools (collapsible)                              │
│  ├─ MCP Server 1 (collapsible)                              │
│  └─ MCP Server 2 (collapsible)                              │
└─────────────────────────────────────────────────────────────┘
```

## Component Specifications

### 1. Token Budget Bar (Compact)

```
┌─────────────────────────────────────────────────────────────┐
│ Token Budget  ████████████░░░░░░░░  2,450 / 8K (31%)    [▼] │
└─────────────────────────────────────────────────────────────┘
```

- Single-line with inline segmented progress bar
- Click to expand breakdown (Critical/Conditional/Available)
- Warning/error states change bar color

### 2. Filter Bar (Dense)

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 Search tools...  │ Category ▼ │ Tier ▼ │ 28 tools │ ↺   │
└─────────────────────────────────────────────────────────────┘
```

- Inline stats replace separate badges row
- Icon-only reset button with tooltip
- 150ms debounced search
- Keyboard: `/` focuses search, `Escape` clears

### 3. Accordion Group Headers

```
┌─────────────────────────────────────────────────────────────┐
│ ▼ Native Tools                                              │
│   Core agent capabilities                    8/12 enabled   │
│                                        [Enable All] [━━━]   │
└─────────────────────────────────────────────────────────────┘
```

**For MCP Servers:**
```
┌─────────────────────────────────────────────────────────────┐
│ ▶ @anthropic/claude-mcp                      ● Connected    │
│   Model Context Protocol server               5/5 enabled   │
│                                        [Enable All] [━━━]   │
└─────────────────────────────────────────────────────────────┘
```

- Two-line header: Name + description, stats on second line
- Status indicator for MCP (green/yellow/red dot)
- Dropdown menu `[━━━]` for Enable All / Disable All / Refresh / Config
- Multiple accordions can be open simultaneously

**MCP Status States:**
- `● Connected` - Green dot
- `● Connecting...` - Yellow dot, italic
- `● Error` - Red dot, error in subtitle with [Retry] button

### 4. Tool Rows (Collapsed)

```
┌─────────────────────────────────────────────────────────────┐
│ ▶ read_file        Critical  FileSystem   ~320 tk    [●━━] │
│ ▶ write_file       Critical  FileSystem   ~280 tk    [●━━] │
│ ▶ search_code      Cond.     Search       ~450 tk    [○━━] │
└─────────────────────────────────────────────────────────────┘
```

**Column Layout:**
| Element | Width | Notes |
|---------|-------|-------|
| Chevron | 16px | Expand indicator |
| Tool name | flex-1 | Monospace, truncate with tooltip |
| Tier badge | 64px | "Critical", "Cond.", "Defer." |
| Category | 80px | Truncate long names |
| Tokens | 64px | Right-aligned, muted |
| Toggle | 40px | Switch component |

**Visual States:**
- Enabled: Normal opacity, filled toggle
- Disabled: opacity-70, empty toggle
- Requires Approval: `⚠` icon after name

**Interactions:**
- Hover: Subtle background highlight
- Click row: Expand details
- Keyboard: Arrow keys navigate, Space toggles, Enter expands

### 5. Tool Row (Expanded)

```
┌─────────────────────────────────────────────────────────────┐
│ ▼ read_file        Critical  FileSystem   ~320 tk    [●━━] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Read contents of a file at the specified path. Supports    │
│  text files and returns content with line numbers.          │
│                                                             │
│  ┌─ Input Schema ─────────────────────────────────────────┐ │
│  │ path: string (required)                                │ │
│  │ encoding: "utf-8" | "ascii" | "base64"                 │ │
│  │ maxLines: number                                       │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ Test Playground ──────────────────────────────────────┐ │
│  │ { "path": "/example/file.txt" }            [Run Test]  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

- Full description (no truncation)
- Parsed input schema (not raw JSON)
- Collapsible playground section
- Smooth height animation

### 6. MCP Config Alert

```
┌─────────────────────────────────────────────────────────────┐
│ ⚠ MCP config not found at ~/.config/brainstrike/mcp.json   │
│   [Select File]  [Create Sample]  [Reset Default]      [✕] │
└─────────────────────────────────────────────────────────────┘
```

- Single-line message with path inline
- Dismissable for session
- Inline action buttons

## Removed Components

1. **`McpServerStatus` card** - Status integrated into accordion headers
2. **Separate stats badges** - Integrated into filter bar
3. **Fixed 500px scroll height** - Flex layout adapts to container

## Files to Modify

| File | Changes |
|------|---------|
| `unified-tools-settings.tsx` | New layout structure, accordion integration |
| `tool-card.tsx` | Rename to `tool-row.tsx`, table-like layout |
| `tools-filter-bar.tsx` | Compact inline design with stats |
| `token-budget-summary.tsx` | Single-line compact mode |
| `mcp-config-alert.tsx` | Streamlined single-line |
| `mcp-server-status.tsx` | **Remove** - merge into accordion headers |
| `types.ts` | Add new props for accordion state |

## New Components

| Component | Purpose |
|-----------|---------|
| `tool-group-accordion.tsx` | Accordion wrapper with header, dropdown menu |
| `tool-row.tsx` | Dense row with expand/collapse |
| `tool-row-expanded.tsx` | Expanded details with schema + playground |
| `schema-display.tsx` | Formatted input schema renderer |

## Accessibility

- Full keyboard navigation (arrow keys, Tab, Space, Enter)
- ARIA labels on all interactive elements
- Focus indicators visible
- Screen reader announcements for state changes

## Animation

- Accordion expand/collapse: 200ms ease-out
- Row hover: 100ms background transition
- Toggle switch: 150ms
- Progress bar segments: 300ms on data change
