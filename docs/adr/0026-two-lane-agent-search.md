# ADR-0026: The agent's core tools read the disk; the index is an optional lane

- **Status:** Accepted (Sean, 2026-10-20: "lets do what others do, and separate")
- **Date:** 2026-10-20
- **Ticket:** follows BST-2271 and BST-2272
- **Related:** ADR 0017 (CLI retrieval), BST-1988 (index partition and worktree
  opt-in), BST-1990 (a thread searches its own folders)

## Context

On 2026-10-20 every grep in a worktree-mode thread failed, and three of four
delegated children died before their first step. Both failures came from the
agent's loop waiting on the search index.

- **Grep ran the index first.** It searched Main's index before the live
  ripgrep pass. The index pass saw 200 candidate files where ripgrep sees
  1,500. It made about four authority reads through Main, and its rows were
  never re-checked against disk. It was also the only part that could fail
  the whole call. The index leaves a worktree out until it is opted in, so
  asking it about the thread's own folder failed every grep (BST-2271).
- **Retrieval tools were offered when they could not answer.** Semantic and
  hybrid search were in the tool list on a TEXT-mode or building index, where
  they always refuse.
- **Memory recall ran before every model step.** When recall is on, a vector
  query ran on the host's single state-index worker before each step, and a
  failure ended the run (BST-2272).

Other coding agents converged on the same answer in 2026. Grep, glob and read
over the disk are the base layer everywhere. Cursor turned down its embeddings
index in July 2026 in favour of grep-based retrieval. Copilot and Augment keep
semantic search only as a separate tool next to grep, never inside it.

## Decision

The agent's search has three lanes.

1. **Core lane: grep, glob, read and symbols read the disk only.** They never
   call Main's index, so they work in any folder, indexed or not, and always
   see the agent's own edits. Grep is the live ripgrep pass alone; its
   zero-match steering probes run on the same pass.
2. **Retrieval lane: semantic and hybrid search are optional tools.** They are
   offered only when the index is in VECTOR mode and ready for the thread's
   folders. They are described as a companion to grep for conceptual
   questions, not as the default, and they name any folder they could not
   search.
3. **Memory lane: recall runs once per turn.** Its query is the turn's user
   message, so it does not change between steps. A recall failure is shown on
   the run and the turn continues.

The index itself stays. It serves Explorer search, collections, notes, thread
history and the retrieval lane.

## Consequences

- Grep no longer returns index rows for files the live pass excludes, for
  example under the `full-root` indexing preset.
- Grep's result carries no per-match `source` label and no
  `skippedMissingLineMetadata` count. Stored results that still have them
  replay unchanged, because the parser ignores fields it does not read.
- On very large repositories, grep is bounded by the live pass's caps: 1,500
  candidate files, then a bounded walk if ripgrep fails or times out. Every
  cap is reported to the model. If that becomes a problem, the answer is a
  lexical accelerator that includes the agent's own edits immediately, not a
  return to the semantic index.
- Admitting the retrieval tools and running recall once per turn are separate
  changes under this decision.
