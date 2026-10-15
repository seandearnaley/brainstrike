# File explorer state

Follow root instructions. This package owns explorer state/actions/cache and is
UI-agnostic; React and platform adapters belong to its consumers.

- Preserve canonical composite selection keys and current-format serialization.
  Use existing encoders and explicit root/folder identity; malformed keys fail
  visibly instead of being guessed or coerced.
- Persist only the existing lightweight state. File bytes belong in ephemeral
  content/cache owners, not selection snapshots or Web Storage. Preserve reset
  and provider-lifetime isolation.
- Refresh and selection reconciliation use acknowledged source/root authority;
  do not infer missing membership from a partial tree or a matching path.
- Keep persisted paths/identifiers and file contents out of diagnostics. Preserve
  public actions and their batching semantics for large selections.

Consult `docs/agents/explorer-search-context-map.md` and `workspace-context.md` when
changing these contracts.
