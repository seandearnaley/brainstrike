---
title: "Visual Identity Diagrams"
---

# Visual Identity Transformation Diagrams

## Design System Architecture

```mermaid
flowchart TB
  subgraph Foundation["Design Foundation"]
    Typography["Typography<br/>Geist Sans + Mono"]
    Colors["Color System<br/>Warm Neutrals"]
    Spacing["Spacing Scale<br/>4px Base Unit"]
    Radius["Border Radius<br/>4-24px Scale"]
  end

  subgraph Tokens["Design Tokens"]
    CSSVars["CSS Variables<br/>HSL Format"]
    TailwindConfig["Tailwind Config<br/>Theme Extension"]
  end

  subgraph Components["Component Layer"]
    Primitives["Primitives<br/>Button, Input, Card"]
    Patterns["Patterns<br/>Panels, Headers, Status"]
    Layouts["Layouts<br/>IDE Layout System"]
  end

  subgraph Apps["Application Layer"]
    Web["Web App"]
    Desktop["Desktop App"]
    Mobile["Future: Mobile"]
  end

  Typography --> CSSVars
  Colors --> CSSVars
  Spacing --> CSSVars
  Radius --> CSSVars

  CSSVars --> TailwindConfig
  TailwindConfig --> Primitives
  Primitives --> Patterns
  Patterns --> Layouts

  Layouts --> Web
  Layouts --> Desktop
  Layouts --> Mobile
```

## Color Transformation: Cool to Warm

```mermaid
flowchart LR
  subgraph Before["Current - Cool Grays"]
    BG1["#FFFFFF<br/>Pure White"]
    BG2["#F5F5F5<br/>Cool Gray 100"]
    Border1["#E4E4E7<br/>Cool Gray 200"]
    Text1["#09090B<br/>Near Black"]
  end

  subgraph After["New - Warm Neutrals"]
    BG3["#FDFCFB<br/>Warm White"]
    BG4["#F9F7F5<br/>Warm Gray"]
    Border2["#EEEBE7<br/>Warm Border"]
    Text2["#2D2520<br/>Warm Dark"]
  end

  Before -->|Transform| After
```

## Sync Status Visual System

```mermaid
stateDiagram-v2
  [*] --> Synced

  Synced --> Syncing: Local change made
  Synced --> Offline: Network lost

  Syncing --> Synced: Upload complete
  Syncing --> Pending: Network lost
  Syncing --> Error: Server error

  Pending --> Syncing: Network restored
  Pending --> Conflict: Remote change detected

  Offline --> Pending: Changes queued
  Offline --> Synced: Network restored - no changes

  Error --> Syncing: Retry clicked
  Error --> Pending: Give up - try later

  Conflict --> Synced: Conflict resolved

  note right of Synced
    Green checkmark
    "All changes saved"
  end note

  note right of Syncing
    Blue spinner
    "Syncing..."
  end note

  note right of Pending
    Amber circle
    "3 pending"
  end note

  note right of Offline
    Gray icon
    "Offline"
  end note

  note right of Error
    Red alert
    "Sync failed"
  end note

  note right of Conflict
    Orange warning
    "Conflict detected"
  end note
```

## Typography Hierarchy

```mermaid
flowchart TB
  subgraph Display["Display Text"]
    H1["32-48px<br/>Weight 600<br/>Tracking -0.02em"]
  end

  subgraph Headings["Headings"]
    H2["24-32px<br/>Weight 600<br/>Tracking -0.015em"]
    H3["20px<br/>Weight 600<br/>Tracking -0.01em"]
  end

  subgraph Body["Body Text"]
    BodyText["15px<br/>Weight 400<br/>Line Height 1.6"]
  end

  subgraph UI["UI Elements"]
    UIText["13px<br/>Weight 500<br/>Tracking 0.01em"]
    Caption["12px<br/>Weight 500<br/>Tracking 0.02em"]
    Micro["11px<br/>Weight 500<br/>Tracking 0.03em"]
  end

  Display --> Headings
  Headings --> Body
  Body --> UI
```

## Button State Transitions

```mermaid
stateDiagram-v2
  [*] --> Default

  Default --> Hover: Mouse enter
  Hover --> Default: Mouse leave
  Hover --> Active: Mouse down
  Active --> Hover: Mouse up
  Default --> Focus: Tab key
  Focus --> Default: Blur
  Focus --> Active: Enter/Space
  Default --> Disabled: disabled=true
  Disabled --> Default: disabled=false

  note right of Default
    Base shadow
    No transform
  end note

  note right of Hover
    Lift -1px
    Enhanced shadow
    150ms ease
  end note

  note right of Active
    Return to 0
    Pressed shadow
    50ms ease
  end note

  note right of Focus
    Focus ring
    3px primary/15%
  end note

  note right of Disabled
    50% opacity
    No pointer events
  end note
```

## Implementation Phases

```mermaid
gantt
  title Visual Identity Refresh Timeline
  dateFormat YYYY-MM-DD
  excludes weekends

  section Phase 1 - Typography
    Font integration           :p1a, 2025-12-02, 5d
    Typography scale           :p1b, after p1a, 3d
    OpenType features          :p1c, after p1b, 2d

  section Phase 2 - Colors
    Define CSS variables       :p2a, 2025-12-16, 3d
    Light mode palette         :p2b, after p2a, 4d
    Dark mode palette          :p2c, after p2b, 4d
    High contrast mode         :p2d, after p2c, 3d

  section Phase 3 - Components
    Button refinements         :p3a, 2026-01-06, 3d
    Card and surface styling   :p3b, after p3a, 3d
    Input focus states         :p3c, after p3b, 2d
    Panel headers              :p3d, after p3c, 2d

  section Phase 4 - Animations
    Button interactions        :p4a, 2026-01-20, 3d
    Skeleton loaders           :p4b, after p4a, 2d
    Form validation            :p4c, after p4b, 2d
    Reduced motion support     :p4d, after p4c, 2d

  section Phase 5 - Sync UI
    Status indicators          :p5a, 2026-02-03, 4d
    File badges                :p5b, after p5a, 3d
    Offline banner             :p5c, after p5b, 2d
    Conflict modal             :p5d, after p5c, 3d

  section Phase 6 - QA
    Cross-browser testing      :p6a, 2026-02-20, 5d
    Accessibility audit        :p6b, after p6a, 5d
    Performance testing        :p6c, after p6b, 3d
    Final polish               :p6d, after p6c, 5d
```

## Component Hierarchy

```mermaid
flowchart TB
  subgraph Primitives["Primitive Components"]
    Button["Button"]
    Input["Input"]
    Label["Label"]
    Badge["Badge"]
    Icon["Icon"]
  end

  subgraph Composed["Composed Components"]
    Card["Card"]
    Dialog["Dialog"]
    Dropdown["Dropdown"]
    Tabs["Tabs"]
    Table["Table"]
  end

  subgraph Patterns["Pattern Components"]
    SyncStatus["SyncStatus"]
    PanelHeader["PanelHeader"]
    FileItem["FileItem"]
    Toolbar["Toolbar"]
  end

  subgraph Layout["Layout Components"]
    IdeLayout["IdeLayout"]
    ExplorerPanel["ExplorerPanel"]
    ToolsPanel["ToolsPanel"]
    ConsolePanel["ConsolePanel"]
  end

  Button --> Card
  Input --> Card
  Badge --> FileItem
  Icon --> SyncStatus

  Card --> PanelHeader
  Dropdown --> Toolbar
  Tabs --> ConsolePanel

  SyncStatus --> IdeLayout
  PanelHeader --> ExplorerPanel
  PanelHeader --> ToolsPanel
  FileItem --> ExplorerPanel
  Toolbar --> IdeLayout
```

## Accessibility Modes

```mermaid
flowchart LR
  subgraph System["User Preferences"]
    ColorScheme["prefers-color-scheme"]
    Contrast["prefers-contrast"]
    Motion["prefers-reduced-motion"]
  end

  subgraph Modes["Theme Modes"]
    Light["Light Mode"]
    Dark["Dark Mode"]
    HighContrast["High Contrast"]
    ReducedMotion["Reduced Motion"]
  end

  subgraph Output["Visual Output"]
    WarmLight["Warm neutrals<br/>Subtle shadows"]
    DarkUI["Dark surfaces<br/>Elevated cards"]
    StrongContrast["7:1+ contrast<br/>Bold borders"]
    NoAnimation["Instant transitions<br/>Static indicators"]
  end

  ColorScheme -->|light| Light
  ColorScheme -->|dark| Dark
  Contrast -->|more| HighContrast
  Motion -->|reduce| ReducedMotion

  Light --> WarmLight
  Dark --> DarkUI
  HighContrast --> StrongContrast
  ReducedMotion --> NoAnimation
```
