# @brainstrike/platform-utils

Environment labels, Content Security Policy helpers, Canvas sandbox contracts and positive-integer config parsing. Public surface: [`index.ts`](src/index.ts).

- `detectPlatform()` returns `electron` when it sees Electron process indicators, otherwise `web` (including plain Node, unknown environments and detection errors).
  - The label is not a capability: it doesn't prove browser APIs exist, that Node modules are importable, or that a native bridge is authorized.
  - Feature gating uses the injected capability; platform composition owns adapter selection and native imports.
- `getContentSecurityPolicy(env, target)` builds the app CSP for desktop (`electron`) and web. Never replace it with a permissive development shortcut.
- The Canvas shell and its inbound messages share one validation contract.
- `parsePositiveIntegerConfig` rejects invalid configuration instead of hiding it behind a default.
