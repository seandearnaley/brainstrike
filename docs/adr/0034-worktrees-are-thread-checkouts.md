# ADR-0034: A worktree is a thread's checkout, not another folder

- **Status:** Accepted (Sean, 2026-11-01: "Adopt as proposed")
  - 2026-11-01 (BST-2436, [ADR-0035](0035-workspace-retrieval-is-live-search.md)): there is no index, so decision 5 (a worktree
    reads its repository's index) is void. A worktree's search is live grep on the worktree.
  - 2026-11-10 (owner decisions, below): decision 7's default is replaced by an Automatic default, a
    project gets a host-owned record with its own id, and the interface word is "Project".
- **Date:** 2026-11-01
- **Related:** ADR 0017 (root authority), 0018 (derived indexer), 0026 (two-lane
  search), 0028 (a created worktree binds its thread), 0029 (host owns the
  open-folder list), 0032 (workspace trust); BST-1988 (worktree index opt-in);
  tickets BST-2419 (BST-2420 to BST-2422, BST-2424, BST-2340)

## Context

Most threads are expected to run in a new worktree. Today that path feels wrong:

- **The repository shows up twice.** Creating or picking a worktree mounts it as
  a new workspace root (`kind: 'worktree'`) and then binds the thread
  (`use-worktree-mode.ts`). Every surface that lists open folders, the Explorer
  first, then shows the local checkout and the worktree side by side.
- **Folders can only be added.** "Add Folder to Workspace" and the composer's
  "Add folder…" grow one global list. Nothing opens a folder in place of the
  current one.
- **A worktree's index is a second index.** A worktree root is left out of the
  index until it is opted in (BST-1988). Once opted in it is indexed as an
  unrelated folder, and embeddings are reused only within the same file record,
  so it re-embeds and stores the whole repository again.
- **A worktree asks for trust again**, because trust is keyed by path (ADR-0032).

Other tools agree on one shape (read on 2026-11-01):

- **VS Code Agents window:** a session runs in a New Worktree or a Folder; "the
  active session controls the Files, Changes, Terminal, Tasks, and Browser
  views". Extra repositories attach as context "without adding workspace roots".
  Classic VS Code separates Open Folder (replace) from Add Folder to Workspace.
- **Cursor 3:** agents work in worktrees under a machine-wide folder while the
  main checkout stays untouched; `/apply-worktree` brings changes back. Cursor
  turned its semantic index down for grep in July 2026; before that, copies of a
  codebase reused one index and dropped hits the client could not prove it had.
- **Codex app:** a chat runs in Local or Worktree and "Hand off" moves it between
  them. Worktrees live under `$CODEX_HOME/worktrees`. No index.
- **Claude Code:** `--worktree`, or the desktop's worktree option, per session.
  A worktree shares permission approvals and project configuration with its
  main checkout. No index.

No tool lists a worktree beside its repository, and none builds a second index
for it.

## Decision

1. **A project is a repository; a worktree is one of its checkouts.** The
   repository is identified by its realpath'd git common dir (`repoCommonDir`,
   the worktree ledger's key). A folder outside git is a project with one
   checkout.
2. **Worktrees stay roots for authority, not for display.** A worktree keeps its
   `roots` row and `roots.id`, because root ids are the authority (ADR-0017). A
   `kind: 'worktree'` root is left out of the open-folder list, Recents and the
   composer's other-folders list. It appears only as a checkout of its project.
3. **The Explorer follows the active thread.** Its project header names the
   checkout (`brainstrike · swift-badger`) and offers Local, the repository's
   worktrees, New worktree and Archive. Choosing one is the thread binding's
   existing action (ADR-0028); the binding stays its only writer.
4. **Open replaces; add is secondary.** "Open Folder…" makes the chosen folder
   the window's project, and Recents is the switcher. "Add Folder to Workspace"
   stays for multi-repository work. Open is one more host method on the
   open-folder list the host owns (ADR-0029 stage 4), `workspace/roots/open`.
   File ▸ Open Folder…, File ▸ Open Recent, ⌘K "Open folder…" and a path
   handed to the app (`brainstrike <path>`, open-file, a second instance)
   open; a dropped folder joins. A folder a running run was admitted with
   leaves the open folders but stays mounted until the next launch, so the run
   keeps working; its record and identity stay, so Recents reopen it as it was.
5. **A worktree reads its repository's index.** Worktree roots are never indexed
   on their own and the opt-in goes. Semantic and hybrid search for a worktree
   query the local checkout's index, map each hit to the worktree by
   repository-relative path, and keep it only when the worktree's file still has
   that chunk's content. The result names how many hits were dropped, and grep
   reads changed files live (ADR-0026).
6. **Repository-level answers follow the repository.** A managed worktree of a
   trusted repository is trusted, resolved through `repoCommonDir` (BST-2340;
   amends ADR-0032, where a managed worktree asks again).
7. **New threads default to a worktree, created on first send**, so an empty
   thread creates nothing. Archive keeps its snapshot ref; a cap archives the
   oldest idle worktrees that no open thread uses.

2026-11-01: the semantic and hybrid read-through of decision 5 is removed with the
retrieval tools (the retrieval decision, BST-2428).

## Owner decisions, 2026-11-10

Sean's answers to the questions the "Where Threads Live" brief left open. They
supersede the decisions above where they differ.

- **Decision 7's default is replaced: the default checkout is Automatic.** A
  new thread starts in the repository's own checkout. A thread works in a
  worktree instead when it would start writing to a checkout another thread is
  already writing to, or when the person asks for work in parallel. The
  worktree is created at that first write, so a thread that only reads creates
  nothing. The options not taken were a worktree for every thread (decision 7
  as written) and always Local. Not built yet.
  - The rest of decision 7 stands: archive keeps its snapshot ref, and a cap
    archives the oldest idle worktrees that no open thread uses.
  - Which thread moves was not part of Sean's answer. It is recorded here as
    the later writer, because the thread already writing has uncommitted work
    in the checkout. The work that builds this may revisit it.
- **A project gets a host-owned record with its own id.** The realpath'd git
  common dir of decision 1 stays the way a repository is found on disk, and
  becomes a locator of the project instead of its identity. A moved or renamed
  folder can then be relinked and keep its threads, and a second clone can join
  the same project in the thread list. Trust follows only on proof that it is
  the same folder, never on a fingerprint such as a remote URL or a root
  commit, which a repository can copy. The record is new durable state, so it
  needs one owner and joins the reset lifecycle (ADR-0015). Not designed or
  built yet.
- **The interface word is "Project".** Labels that say workspace or folder for
  this are renamed as each screen is touched.
- **Built so far: the Threads panel lists threads by project** (#5329, #5337).
  Its default grouping, labelled Project, puts a thread in a managed worktree
  under its repository, beside the threads in the repository's own checkout; a
  folder outside a repository is its own section and threads with no folder
  come last. Each row carries a checkout chip, the worktree's name or Local,
  read from the thread's binding. A Needs you strip above the sections lists
  every thread waiting on the person, from the run state the host commits. A
  section is keyed on the repository's `repoCommonDir` through one function
  (`threadProjectKey`), which the project record's id will replace; until then
  a second clone is a section of its own. A saved grouping is kept.

## Consequences

- The duplicate folder goes away without new storage. The project record
  (owner decisions, 2026-11-10) will add an identity of its own.
- The index stays one copy per repository. Deleted: the `worktrees` map in
  `index/config`, its Settings and Worktree Map toggles, and the worktree branch
  of `isPartitionRoot`.
- A worktree hit is as fresh as its file on disk: a chunk whose content differs
  in the worktree is dropped, never shown with the local checkout's text.
- Files only the worktree has (new, unindexed) are found by grep, glob and read,
  not by semantic search, until they reach the local checkout's index.
- Display and Open Folder wait for the host-owned open-folder list (ADR-0029
  stage 4 slice C); the index change does not.
