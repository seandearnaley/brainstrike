# @brainstrike/app-shell

Shared React layout and feature composition for the desktop app. It wires UI to injected platform capabilities; it is not a second agent runtime or storage owner. Package rules: [`AGENTS.md`](AGENTS.md).

## Layout

`AppLayout` takes an `AppShellConfig`, routing callbacks and content. Types: [`types.ts`](src/types.ts); defaults: [`app-config.tsx`](src/app-config.tsx).

```tsx
import { AppLayout, createAppConfig } from '@brainstrike/app-shell';
import '@brainstrike/app-shell/styles.css';

const config = createAppConfig({ title: 'Workspace' });

export function Shell({ navigate }: { navigate: (path: string) => void }) {
  return (
    <AppLayout config={config} currentPath="/" onNavigationClick={navigate} onOpenSettings={() => navigate('/settings')}>
      <main>Workspace content</main>
    </AppLayout>
  );
}
```

- Subpaths are in [`package.json`](package.json). Don't infer feature flags, provider APIs or runtime ownership from the layout config.

## Runtime integration

- Desktop composition lives in [`root-layout-content.tsx`](../../apps/desktop/src/renderer/components/root-layout-content.tsx); it attaches host-owned conversations and capabilities.
- Assistant presentation uses the host's public run/thread IDs; it never persists a transcript or runs inference.
- Closing a panel releases presentation only; Stop and deletion go through the host's cancellation/retirement owner.
- Select capabilities at the platform composition boundary; never import a provider or engine into a UI wrapper.
- State:
  - Transient palette, visible-thread and checkout intent: [`src/stores`](src/stores/README.md).
  - Persistent preferences and layout: [`@brainstrike/app-state`](../app-state/README.md). Settings UI: `@brainstrike/settings-ui`.
  - New persistent state joins reset.
- Keep secrets out of UI, logs and serialized preferences.
- Contracts: [UI](../../docs/agents/ui-conventions.md), [persistence](../../docs/agents/assistant-persistence.md), [reset](../../docs/agents/platform-contracts.md).

MIT. See the repository [LICENSE](../../LICENSE).
