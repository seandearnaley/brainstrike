# @brainstrike/app-state

Client-side application state and persistence: Zustand stores, sync hooks, notification decisions and renderer-side factory-reset coordination. No settings-UI dependency.

- Explicit subpaths only; no root barrel or wildcard export:

  ```ts
  import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
  import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
  import { prepareFactoryReset } from '@brainstrike/app-state/factory-reset';
  ```

- Add new public state to `package.json` deliberately.
- Persistent stores use `persistDurable` from `@brainstrike/storage` and join factory reset by construction; a writer that must stop first registers with `registerFactoryResetPreparation`.
- Presentation belongs in `@brainstrike/settings-ui`.
