# @brainstrike/app-shell

Shared React layout and feature composition for Brainstrike web and desktop.
The shell integrates UI with injected platform capabilities; it is not a second
agent runtime or canonical storage owner.

## Compose the layout

`AppLayout` accepts `AppShellConfig`, routing callbacks and content. The public
shape lives in [`types.ts`](src/types.ts), with defaults in
[`app-config.tsx`](src/app-config.tsx).

```tsx
import { AppLayout, createAppConfig } from '@brainstrike/app-shell';
import '@brainstrike/app-shell/styles.css';

const config = createAppConfig({ title: 'Workspace' });

export function Shell({ navigate }: { navigate: (path: string) => void }) {
  return (
    <AppLayout
      config={config}
      currentPath="/"
      onNavigationClick={navigate}
      onOpenSettings={() => navigate('/settings')}
    >
      <main>Workspace content</main>
    </AppLayout>
  );
}
```

Use the exported roots/subpaths in [`package.json`](package.json). Do not infer
feature flags, provider APIs or runtime ownership from the layout config.
Versions and dependencies belong to installed manifests and workspace catalogs.

## Runtime integration

The desktop composition in
[`root-layout-content.tsx`](../../apps/desktop/src/renderer/components/root-layout-content.tsx)
attaches host-owned conversations and capabilities. Shared assistant presentation
uses the host's public run/thread IDs; it does not persist a second transcript or
own inference. Closing a panel releases presentation; Stop and deletion use the
existing host cancellation/retirement owner.

Database-backed workspace sync/import modules remain for their supported
consumers. They do not establish desktop PGlite ownership: desktop canonical
catalog/conversations and native indexing use their existing host/index owners.
Select capabilities at the platform composition boundary rather than importing a
provider or engine into a UI wrapper.

Transient palette, quick-open, visible-thread and checkout intent live in
[`src/stores`](src/stores/README.md). Persistent client preferences/layout state
belong to [`@brainstrike/app-state`](../app-state/README.md); settings presentation
belongs to `@brainstrike/settings-ui`. New persistent state participates in reset.

Reuse TreeTable, TabStrip and context actions. Preserve accessible keyboard/focus
behavior and keep secrets out of UI, logs and serialized preferences. Relevant
contracts: [UI](../../docs/agents/ui-conventions.md),
[persistence](../../docs/agents/assistant-persistence.md),
[inference](../../docs/agents/local-inference.md) and
[reset](../../docs/agents/platform-contracts.md).

## Development

Use this package's `build`, `type-check`, `test` and `test:integration` scripts for
the affected boundary. **CI is disabled due to cost; validation must run locally.**
Follow [validation guidance](../../docs/agents/ci-quality.md).

ISC. See the repository [LICENSE](../../LICENSE).
