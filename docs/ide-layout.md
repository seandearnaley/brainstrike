# IDE Layout & Panel System

The **IdeLayout** component in `@brainstrike/ui` provides a flexible, IDE-style layout with optional
left, right and console panels. Layout state is preserved across sessions by the
`usePanelPersistence` hook which stores panel sizes and visibility.

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
