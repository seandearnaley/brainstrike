# App shell

Follow root instructions. This package composes shared UI; it does not become a
second agent runtime or durable storage owner.

- Select desktop/web behavior through available capabilities. Optional bridges
  must not prevent the rest of the shell from rendering.
- Reuse shared TreeTable, TabStrip and context actions. Preserve accessible
  keyboard/focus behavior and use the existing layout/state owners.
- Runtime teardown, explicit Stop and reset have different ownership semantics.
  Preserve the existing joins and cancellation authority; component unmount must
  not silently cancel work owned by a longer-lived host.
- Keep secrets and raw provider/MCP configuration out of UI, logs and bundles.
  Show actionable safe failures rather than raw internal errors.

Consult `docs/agents/ui-conventions.md`, `assistant-persistence.md`,
`local-inference.md` or `platform-contracts.md` for the relevant behavior.
