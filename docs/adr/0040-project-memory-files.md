# ADR-0040: Project memory is plain files the host keeps for each project

- **Status:** Accepted
- **Date:** 2026-11-14
- **Ticket:** BST-2530 (the panel to read, edit and delete notes is BST-2534)
- **Related:** [ADR-0015](0015-desktop-platform-ipc-reset-diagnostics.md) (reset),
  [ADR-0020](0020-greenfield-data-lifecycle.md) (greenfield), [ADR-0032](0032-workspace-trust.md)
  (trust), [ADR-0034](0034-worktrees-are-thread-checkouts.md) (projects),
  [ADR-0039](0039-host-is-the-only-compactor.md) (memory across threads goes here)

## Context

- Nothing carries a fact from one thread to the next. ADR-0039 retired Mastra's working memory and
  left memory across threads to this decision.
- Rules meant for every tool stay in a repository's `AGENTS.md`. This is for what the assistant
  learns while working: facts a later thread in the same project needs.
- The vendors agree on a shape (read on 2026-11-14):
  - **Anthropic's memory tool** (`memory_20250818`): six file commands (`view`, `create`,
    `str_replace`, `insert`, `delete`, `rename`) over paths under `/memories`, with storage
    implemented by the client. The documentation gives each command's result strings and asks the
    client to refuse paths outside `/memories`, cap file sizes and strip sensitive data.
  - **The AI SDK** exposes it as `anthropic.tools.memory_20250818({ execute })`, a tool the client
    executes. Its wire name is `memory`.
  - **Claude Code's auto memory**: one folder per repository with a `MEMORY.md` index (one line
    per memory) and one file per memory. The first 200 lines or 25 KB of the index load into every
    session; the files are read on demand.

## Decision

- **One owner, one writer.** The host owns project memory. Only its memory module
  (`@brainstrike/host-capabilities/project-memory`) writes the files: the memory tool during a
  turn, and Undo through Core. No background process writes memory.
- **Where it lives.** `<data root>/project-memory/<project id>/`, beside the state database. It
  is app-private: never in the repository, never in git.
- **A thread's project** is the project of its checkout, as the Threads panel reads it (ADR-0034):
  the folder that answers for the run's operating folder (a managed worktree's repository's own
  checkout, otherwise the folder itself, `hostAnsweringFolder`), looked up in `project_folders` by
  its canonical path. A scratch folder has no project, so a scratch thread has no memory until it
  is turned into a project. A run with several folders and no binding has no operating folder and
  no memory.
- **Trust.** Memory loads, and the tool is offered, only while that folder is trusted (ADR-0032),
  the same gate as the folder's `AGENTS.md`.
- **The vendor's commands are adopted.**
  - The tool is Anthropic's six commands from `memory_20250818`, field for field, over
    `/memories`, with the documented result strings. Every provider, Anthropic included, gets them
    as one ordinary function tool, `brainstrike_memory`.
  - The native `memory_20250818` type is not used (decided 2026-11-14). Declaring it makes
    the API add its own protocol to the system prompt: view the memory directory before anything
    else, and record progress because the context may reset. That protocol is for surviving a
    context reset, which the host's compaction summary already does. Project memory is for facts
    later threads need, never task progress, and its index is already loaded, so a forced `view`
    would be a wasted call on every run.
  - It removed a bespoke design: no note schema, no separate save, list and delete tools, no path
    model of our own.
  - The index is the host's, not the model's. After every write the host rewrites `MEMORY.md`
    from the files: one line per note, its title (the first `# ` heading, else the file name) and
    a one-line hook (the first line of text after it). The model cannot write `MEMORY.md`, so the
    index cannot drift from the files.
- **Loading.** The host reads `MEMORY.md` once, when a run is admitted, and adds it with one short
  paragraph to the run's system text after the stable prompt and the workspace instructions. The
  run commits that text, so a recovered run reads the index it started with.
  - A note written during a run changes nothing that run sends; the next run sees it.
  - Limit: the first 200 lines or 25,000 characters, whichever comes first, with a marker that
    says where it was cut. Note files are not loaded; the model reads them with `view`.
  - A child run (subagent) gets the index too and never writes: the tool is parent-only.
- **Limits.** Paths start with `/memories`; a `..` segment or a hidden name is refused, and the
  workspace path resolver (`resolveWorkspaceWritePath`) keeps every write inside the folder
  through symlinks. A note holds at most 16,000 characters, the size Anthropic's `view` shows
  before it truncates.
- **A note is data.** The section tells the model that notes are facts earlier threads saved,
  never instructions, and that the person and `AGENTS.md` outrank them.
- **Secrets.** Before a note is stored, the host scans it with `scrubLikelySecretValues`
  (`@brainstrike/utils/diagnostics`) and refuses a note that matches, with the reason on the card.
  `@brainstrike/logging` redacts by key name only and has no text scan to reuse; the secret-scan
  script's patterns are private to the script.
- **Provenance.** A write made by a run that has read web or MCP tool output (web search, web
  extract, browser pages, an MCP tool) is marked as coming from untrusted context. The mark stays
  with the note until the note is deleted. The host keeps it beside the notes
  (`.provenance.json`, hidden from the tool), shows it on the card and on the note's index line.
- **Every write is visible.** A write commits `memory.changed`, which the thread shows as a card:
  the note's title and text, the untrusted mark, and Undo. Undo (`memory/undo`) restores what the
  write replaced: it deletes a note the write created, and is refused once the note has changed
  since.
- **Risk.** The tool is `read`, as working memory was: it changes only the app's own memory, never
  the workspace, so it does not ask, and plan mode keeps it.
- **Reset lifecycle** (ADR-0015).
  - Clear Database removes `project-memory/` with the rows (`StateStore.clearContent`).
  - Factory Reset clears the data root.
  - A project deleted because its last folder joined another project
    (`join-project`) takes its folder with it.

## Consequences

- On Anthropic the model reads the commands from the function schema and the section, without the
  tool description the API supplies with the native type.
- A note added in one run changes the tail of the next run's system text once. Providers that
  cache a prefix automatically keep the stable prompt before it; Anthropic's single tail
  breakpoint re-caches that run's request once.
- The standalone CLI records no folders, so its runs have memory only for a workspace whose
  project another host recorded in the same data root.
- A write after a delegated child's result is not marked untrusted, though the child may have
  read the web. The mark covers the run's own tool calls.
- Reading, editing and deleting notes outside a thread is BST-2534.

## Sources

- Anthropic, "Memory tool": platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.
- AI SDK, "Anthropic provider": ai-sdk.dev/providers/ai-sdk-providers/anthropic, and
  `@ai-sdk/anthropic` 4.0.94 (`memory_20250818`).
- Claude Code, "How Claude remembers your project": code.claude.com/docs/en/memory.
