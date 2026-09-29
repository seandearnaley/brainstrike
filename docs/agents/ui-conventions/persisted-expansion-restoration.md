# Persisted expansion restoration — evidence

Supports `docs/agents/ui-conventions.md` § "TREEGRID CONVERGENCE CONTRACT".
Read before changing root scoping, the 100-directory restoration cap, or Windows path normalisation in `root-scoped-paths.ts`.

Extracted verbatim from the pre-distillation contract.

---

- Persisted expansion restoration is scoped to the active root path before any
  worker I/O. A multi-root provider must never replay another root's paths.
  Web File System Access roots expose only a relative folder name, so their
  root-relative expansion paths remain in scope while stale absolute paths are
  excluded. Desktop scope comparisons normalize Windows separators and casing
  without changing the persisted or worker-facing path identity.
  Automatic startup restoration is capped at 100 directories per root,
  shallowest-first with selected/query parents prioritized; excess persisted
  paths are collapsed and surfaced through both the restoration progress card
  and a toast. Keep this bound visible—never silently attempt an unbounded
  restore that can monopolize the renderer. Post-restoration selection changes
  use the same root scoping, separator-normalized shallowest-first ordering, and
  100-directory cap before issuing worker I/O. Root scoping must preserve
  descendants when the workspace itself is a POSIX, drive, or UNC filesystem
  root, but a Windows drive-relative sentinel such as `C:` is not the `C:\`
  filesystem root and must never be sent to restoration or consume the cap.

