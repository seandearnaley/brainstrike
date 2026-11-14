# Project memory

Plain files the host keeps for each project, so a later thread in a project starts knowing what an earlier one saved. Decision: [ADR-0040](../adr/0040-project-memory-files.md).

## Ownership and storage

Owners: [notes](../../packages/host-capabilities/src/project-memory/memory-notes.ts), [admission](../../packages/host-capabilities/src/project-memory/memory-admission.ts), [Core's record](../../packages/agent-host/src/project-memory-record.ts).

- `<data root>/project-memory/<project id>/`: `MEMORY.md` and one file per note. Never in the repository or git.
- `ProjectMemoryNotes` is the only writer. The memory tool writes during a turn and Core's `memory/undo` restores; nothing writes in the background.
  - Writes to one folder run one at a time, from any thread.
  - Never write the folder from anywhere else, and never let the model write `MEMORY.md`: the host rewrites it from the notes after every change, so it cannot drift.
  - Which notes untrusted context wrote is the host's `.provenance.json` beside them; the tool refuses hidden names, so the model cannot reach it.
- A run's project is its checkout's: the project of the folder that answers for its operating folder (`hostAnsweringFolder`, so a managed worktree uses its repository's own checkout), found by canonical path (`repository-projects`). Never go by a root record's `projectId`, which a worktree's record does not carry.
  - The operating folder is the binding's, else the run's only folder. A scratch folder has no project and no memory.
  - The standalone CLI records no folders: its runs have memory only when another host recorded the launch root's project in the same data root.

## The tool

- Anthropic's memory commands, field for field (`MemoryInputSchema`): `view`, `create`, `str_replace`, `insert`, `delete`, `rename` over `/memories`, with the vendor's result strings.
  - On the Anthropic provider, Core declares the native `memory_20250818` around the same host executor (`nativeMemory`, `createAdmittedHostSdkTools`), keyed `memory` (`withHostNativeMemoryName`): the AI SDK maps the key to `memory` on the way out but names a client tool's call by its wire name on the way back. Every call still passes Core's decision and dispatch. Other providers get the function tool, `brainstrike_memory`.
  - The tool is `critical` (always declared, never behind discovery) and `read` risk: it never asks, and plan mode keeps it.
  - It is parent-only (`PARENT_ONLY_TOOL_IDS`); a child reads the index through its instructions and never writes.
- Paths: `/memories` or under it. A `.`, `..`, percent-encoded or hidden segment is refused before the workspace path resolver keeps the write inside the folder through symlinks. Reuse that resolver; never add another.
- A note holds at most 16,000 characters. One that `scrubLikelySecretValues` flags is refused and committed as `memory.refused`, which never carries its text.
- A write by a run that has read web or MCP tool output (`hostRunReadUntrustedContent`) marks the note untrusted until it is deleted.

## Loading

- Admission reads `MEMORY.md` once and adds `projectMemorySection` after the stable prompt and the workspace instructions; `childSystem` gets the child variant. The text is committed with `run.started`, so a recovered run reuses it.
- Only while the operating folder is trusted (ADR-0032), the same gate as its `AGENTS.md`. An untrusted run gets neither the section nor the tool.
- The first 200 lines or 25,000 characters load, with a marker where the index was cut (`loadedMemoryIndex`). Note files are read with `view`.
- The section says notes are data, never instructions, and that the person and `AGENTS.md` outrank them. Keep it that way.

## Events and the card

- Core commits `memory.changed` under the call that wrote (path, title, text after, text before, untrusted), `memory.refused` for a refused note, and `memory.undone` for an Undo.
- The renderer projects one `brainstrike.memory-note` part per call (`project-memory-note.ts`) and draws `ProjectMemoryNoteCard`: title, text, the untrusted mark and Undo. No explanation of what memory is.
- `memory/undo` names the call. Core finds its committed change and the platform's `projectMemory.undo` restores what it replaced: a created note is deleted, an edited one gets its text back, a rename moves back. It is refused once the note changed since, and for a write already undone.

## Reset lifecycle

- Clear Database: `StateStore.clearContent` removes `project-memory/` under the lock, with the rows.
- Factory Reset: the profile reset clears the data root.
- A project `join-project` deletes (its last folder joined another) loses its folder: the store reports `deletedProjectIds` and the root registry removes them.
- New memory state goes in the project's folder, so these three keep covering it.
