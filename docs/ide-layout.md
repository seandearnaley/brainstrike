# IDE Layout & Panel System

The **IdeLayout** component in `@brainstrike/ui` provides a flexible, IDE-style layout with optional
left, right and console panels. Layout state is preserved across sessions by the
`usePanelPersistence` hook which stores panel sizes and visibility.

As of 2025‑09, `IdeLayout` also supports a pluggable provider for panel state and persistence so apps can
coordinate layout from a central store (e.g., Zustand) or inject a custom persistence adapter.

## Basic Usage

```tsx
import { IdeLayout } from "@brainstrike/ui";
import { usePanelPersistence } from "@brainstrike/ui/hooks";

function App() {
  const panel = usePanelPersistence([25, 20, 30]);

  return (
    <IdeLayout
      navigationItems={[{ title: "Home", href: "/" }]}
      currentPath="/"
      leftPanelContent={<FileExplorer />}
      rightPanelContent={<Inspector />}
      consoleContent={<Console />}
    >
      <Editor />
    </IdeLayout>
  );
}
```

`usePanelPersistence` returns helpers such as `toggleLeftPanel` and `toggleRightPanel`.
You can pass its values directly to `IdeLayout` or use them to build custom
controls.

## Panel Components

- **Left panel** – Typically hosts a file explorer or navigation tree.
- **Right panel** – Optional sidebar for inspectors or settings.
- **Console panel** – Collapsible terminal/output area below the main content.

All panels can be hidden or resized, and their state persists through page reloads.

## Provider + Pluggable Persistence

For cross‑feature orchestration (navigation, commands, responsive rules), wrap your layout in
`PanelLayoutProvider`. When present, `IdeLayout` will use the provider state; otherwise it falls back
to internal `usePanelPersistence`.

```tsx
import {
  PanelLayoutProvider,
  LocalStoragePanelPersistenceAdapter,
  ElectronPanelPersistenceAdapter,
  detectDefaultAdapter,
  IdeLayout,
} from "@brainstrike/ui";

function LayoutShell() {
  const adapter = detectDefaultAdapter() ?? new LocalStoragePanelPersistenceAdapter();

  return (
    <PanelLayoutProvider
      initialState={{ sizes: [25, 55, 20], showConsole: false, showLeftPanel: true, showRightPanel: false }}
      adapter={adapter}
    >
      <IdeLayout
        leftPanelContent={<FileExplorer />}
        rightPanelContent={<Inspector />}
        consoleContent={<Console />}
      >
        <Editor />
      </IdeLayout>
    </PanelLayoutProvider>
  );
}
```

You can also drive the layout in a controlled way by passing `controlledState` and `onChange` to
`PanelLayoutProvider` if you prefer to keep state in your own store and simply persist via `onChange`.

## Testing Notes

- Panel controls include `data-testid` attributes for reliable selection in tests:
  - Show buttons: `show-left-panel`, `show-right-panel`, `show-console-panel`
  - Hide buttons: `hide-left-panel`, `hide-right-panel`, `hide-console-panel`
- Focus after show/hide uses `requestAnimationFrame` sequencing for deterministic behavior in unit/E2E tests.
