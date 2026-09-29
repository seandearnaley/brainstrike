# Workspace indexing QoS ownership — evidence

Supports `docs/agents/local-inference.md` § "Workspace indexing QoS ownership".
Read before moving the QoS policy out of `@brainstrike/indexing-contract`,
adding an environment default at the import boundary, or debouncing QoS
telemetry. BST-1337 is the reason-only transition logging.

## Original text

Workspace indexing QoS ownership:
- `@brainstrike/indexing-contract/workspace-indexing-qos` is the canonical,
  renderer-safe policy shared by app-shell scheduling and the desktop embedding
  host. `@brainstrike/indexing-contract/workspace-indexing-power-snapshot` owns
  the plain-data power snapshot contract and normalization.
- Keep these contracts in `indexing-contract`, not a general utilities package
  or a platform implementation. Desktop supplies capabilities and snapshots;
  the shared policy remains free of Electron imports.
- Invalid power snapshots throw through the shared normalization/validation
  contract. Do not add implicit environment defaults at an import boundary.
- QoS observers log initial observations and state transitions at info; a
  reason-only transition uses the distinct debug message `Workspace indexing
  QoS reason changed` (BST-1337). The observer retains the latest reason even
  with debug disabled. Each loop owns its observer; logging never controls
  scheduling. `accelerator-idle` can change pipeline overlap, stream capacity,
  and app-shell batch sizes while staying `balanced` (worker claim size stays
  16). This is capacity feedback, not a pause/resume edge; foreground, memory,
  battery, and thermal constraints still take precedence immediately. Do not
  add a telemetry debounce that delays those constraints. Coverage:
  `packages/indexing-contract/src/__tests__/workspace-indexing-qos.test.ts`.
