# File explorer UI

Follow root instructions. Reuse the explorer state package and shared UI rather
than creating another selection, content-loading or virtualization owner.

- Explorer trees use shared TreeTable; preserve its scrollport, keyboard/focus
  semantics and layout contract. Use the existing tab and context-action owners.
- File reads require the exact root authority. Selection/cache folder identity
  does not grant filesystem access. Preserve the explicit desktop direct-read
  capability and browser handle/permission path without cross-platform fallback.
- Provider-owned content generations and queues fence late completions. Preserve
  per-key failures, explicit Retry and physical settlement on reset/unmount;
  never render raw loader exceptions or hide a failed key behind another success.
- Preserve binary/inaccessible content handling, selection limits and ephemeral
  file-byte storage. Keep paths and content out of diagnostics.

Consult `docs/agents/ui-conventions.md`, `explorer-search-tapestry.md` and
`workspace-context.md` for the relevant contract.
