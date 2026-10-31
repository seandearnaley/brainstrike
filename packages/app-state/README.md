# @brainstrike/app-state

Client-resident application state and persistence for BrainStrike. This package
owns Zustand stores, state synchronization hooks, notification decisions, and
renderer-side factory-reset coordination. It intentionally has no settings UI
dependency.

The package exposes explicit subpaths only. Import the state you use:

```ts
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { prepareFactoryReset } from '@brainstrike/app-state/factory-reset';
```

There is no root barrel and no wildcard export. New public state must be added
to `package.json` deliberately, and every new persistent store must also be
registered with factory reset.

Presentation belongs in `@brainstrike/settings-ui`; feature and shell packages
may consume app-state directly without acquiring React component dependencies.
