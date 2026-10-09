# ADR-0019: Host thread run selection

- **Status:** Accepted
- **Date:** 2026-10-09
- **Ticket:** BST-1932

## Context

A wake (ADR-0010) continued its turn by reopening the committed snapshot of the run
it followed. The model a user picked in the composer while the turn's children ran
lived only in renderer localStorage, so the wake answered on the old model. The CLI
and the desktop also had no shared answer to "which model does this thread run on".

## Decision

- **The fact.** A thread's run selection is the `{ modelId, configuration? }` pair
  that `run/start` already sends. It has one owner and one writer: Core. It is keyed
  by the thread ID and has one current value. Each change is identified by the
  `commandId` of the command that committed it.
- **The event.** `thread.selection.updated` is committed to the thread's log. Core
  folds it from every committed row and again from the log at open, so a restarted
  host has the same selection.
- **Writers.** A composer pick calls `thread/selection/set`. A `run/start`,
  `run/regenerate` or `run/input` whose pair differs from the selection commits the
  event before its `run.started`, in the same transaction. A delegated child thread
  starts on its parent run's pair. A pick or a run that matches the current
  selection commits no event.
- **Reader.** `thread/selection/read` returns the selection, or null before any run
  or pick. For host threads, the renderer's composer reads it; renderer storage is
  not the source.
- **Wakes.** A wake always admits fresh from the thread's selection. It sends no
  user prompt and does not reopen a run snapshot. It keeps the turn's admitting
  client origin. The snapshot reopen remains only for restart recovery of an
  admitted run.
- **No secrets.** The configuration is the same non-secret intent that `run/start`
  commits in its accepted command. Credentials stay in the credential store
  (ADR-0014) and never enter the selection.
- **No migration.** Greenfield: logs from before this decision are not upgraded.

## Consequences

- The desktop, the CLI and a wake read the same choice.
- A pick made while children run changes the model of the wake that answers them.
  The children keep their own admitted selection.
- Core folds one more fact per thread.
- Saving a pick is separate from send readiness. Only what makes the selection
  itself invalid holds the save: the provider not configured, an invalid
  settings draft, or the host's selection read failing. Send-only gates never
  hold it.
- Known limit: a pick saves once its model's details have loaded, so its effort
  keeps its provider options. A reload in that sub-second window loses the pick.
  Saving it without its settings would store a configuration a run cannot use.
