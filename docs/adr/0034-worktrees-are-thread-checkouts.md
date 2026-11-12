# ADR-0034: A worktree is a thread's checkout, not another folder

- **Status:** Accepted (Sean, 2026-11-01: "Adopt as proposed")
  - 2026-11-01 (BST-2436, [ADR-0035](0035-workspace-retrieval-is-live-search.md)): there is no index, so decision 5 (a worktree
    reads its repository's index) is void. A worktree's search is live grep on the worktree.
  - 2026-11-10 (owner decisions, below): decision 7's default is replaced by an Automatic default, a
    project gets a host-owned record with its own id, and the interface word is "Project".
  - 2026-11-11 (owner decisions, below): how Automatic isolation is built, and its first part;
    the composer's folder, branch and checkout chips become one control that says where a thread
    works.
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
  as written) and always Local. The first part is built (owner decisions,
  2026-11-11); the person asking for work in parallel is not.
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
  needs one owner and joins the reset lifecycle (ADR-0015).
  - Built: the record. The state DB (version 16) has `projects` and
    `project_folders`. The store gives a folder its project in the commit that
    records the folder as opened, so the host's root registry stays the only
    writer and a folder opened from version 16 on always has a project. A
    folder recorded before it gets one when it is next opened. Clear Database
    deletes projects with the folders and threads they group, and Factory
    Reset deletes the store.
  - How the record is kept was not part of Sean's answer. It is recorded here
    as built, and the work that reads it may revisit it:
    - The locator is the folder a project is kept in, by its canonical path:
      a repository's own checkout, or a folder outside a repository. A folder
      that answers for itself has the same identity in workspace trust. For a
      repository whose `.git` is in its checkout, the usual case, that folder
      and the common dir name the same place, and a folder that later becomes
      a repository keeps its project.
    - A root recorded as a managed worktree has no project of its own. A
      folder opened first and adopted as a worktree afterwards keeps the one
      it had, so the work that reads the id goes by the thread's checkout.
    - A folder inside a repository that is opened by itself is a project of
      its own. Nothing looks above the opened folder for a repository, so a
      repository kept in a home directory does not take in every folder under
      it.
    - A folder the person picks again where its path now leads keeps its
      project.
    - Joining a second clone will be something the person does. Nothing joins
      folders by a remote URL or a commit.
  - Built: the Threads panel reads the id. Each root record reaches the
    renderer with its project, and a section is the project's whenever its
    project is known. The panel reads the records again whenever a root
    registration commits, because a folder picked again can join another
    project under the same root id. How it reads the id was not part of
    Sean's answer and is recorded here as built:
    - A thread's project is the project of its checkout: for a thread in its
      repository's own checkout or one of its managed worktrees, the project
      of the repository's own checkout folder; for any other thread, its
      folder's. The worktree listing decides which repository a checkout
      belongs to, as before, so a folder adopted as a worktree goes under its
      repository's project, not the project it kept.
    - Every folder of one project lists in one section: today a folder
      picked again at a new place while a record still leads to the old one,
      and a second clone once joining is built. The section is named by a
      repository before a folder, then by name, whichever thread comes first.
    - A repository whose own checkout is not an open folder has no project to
      read and keeps its common-dir section, and a folder recorded before
      projects keeps its own. The project of a repository reached only
      through a subfolder or a containing folder is not built.
    - Collapse state under a project is kept, not pruned, as for a
      repository. Saved collapse state of sections from before (keyed on the
      common dir or the root id) does not carry over.
  - Not built: relinking a moved folder, joining a second clone and naming a
    project.
- **The interface word is "Project".** Labels that say workspace or folder for
  this are renamed as each screen is touched.
- **Built so far: the Threads panel lists threads by project** (#5329, #5337).
  Its default grouping, labelled Project, puts a thread in a managed worktree
  under its repository, beside the threads in the repository's own checkout; a
  folder outside a repository is its own section and threads with no folder
  come last. A worktree joins its repository only while the ledger lists it
  and git's two links join it, the rule decision 6 uses. Each row carries a
  checkout chip, the worktree's name or Local, read from the thread's binding.
  A Needs you strip above the sections lists every thread waiting on the
  person, from the run state the host commits; a thread leaves it when its
  request is answered or it has been shown. A section is keyed on its project
  (see the project record above). A saved grouping is kept.
- **Built: a person moves a sent thread into a new worktree between turns.**
  This is a build decision, not one of Sean's answers. The composer's checkout
  chip (New worktree…) and the Branch chip's Switch in a new worktree now work
  after a thread's first send. The first-send refusal they had (BST-1390) was
  removed because it guarded cost, not safety: the host accepts a binding change
  at any time and admits the next run with it. Every checkout change (New
  worktree…, Switch in a new worktree, Use existing worktree…, Hand off to Local
  and Archive worktree…) waits for the thread's run to end, because a run keeps
  the checkout it was admitted with. Uncommitted changes stay in the thread's
  folder, and the create sheet says so. The same wait covers the Worktree Map's
  move and hand-off, an Archive whose inspection a run outlasts, and the folder
  actions that take a thread out of its worktree: Make primary, Remove from
  this thread on its worktree folder or its Local folder, and Use another
  folder…. The single
  control that says where a thread works is below (owner decisions,
  2026-11-11).

## Owner decisions, 2026-11-11

Sean's answers to how Automatic isolation (the default of 2026-11-10) is built.

- **The thread moves at its first edit.** A run cannot change folder once it
  has started, because its binding is fixed when it is admitted (ADR-0017). So
  the host refuses the first edit that clashes, the run ends after that step,
  and the same turn carries on in a new worktree. This costs one wasted model
  step and adds one rule to the run engine. If the worktree cannot be made, the
  edit is refused with the reason and is never written in place.
- **"Already writing" means a run in progress that has edited a file with the
  edit tools.** Shell commands do not count. Threads that take turns still
  share the checkout.
- **The new worktree starts from the last commit.** A thread that already has
  uncommitted edits of its own in the shared checkout is not moved. Both keep
  writing there, with a visible note.
- **Nothing new is built for getting the work back.** The thread names its
  branch, and the person merges it or asks the thread to.

Decisions the build made, which are not Sean's and which later work may
revisit:

- The later writer is the one that moves (recorded on 2026-11-10).
- "The same checkout" is the folder an edit targets, by its root id. So the
  rule also covers a thread with no folder of its own and two threads working
  in one worktree.
- A thread and its workers are one writer.
  - A worker's edits count as its thread's writing for as long as the run that
    dispatched the worker is in progress, whether or not the worker has ended.
    Core reads that from the origin it already holds for a worker's run. So a
    thread that has its workers make its edits is seen as writing between
    workers.
  - That stops when the dispatching run ends. A later run of the same thread
    that only takes a finished background worker's results did not dispatch
    it, so that worker's edits no longer count.
  - Only a thread's own edits can move it. A worker's own clashing edit is
    made in place, where its parent works, and never moves its parent.
  - A thread whose workers are still working stays with them (ADR-0028
    rule 5) and shares the folder, with the note. That includes a worker
    dispatched in the same step as the edit, which begins while the worktree
    is being made.
- "In progress" includes a run that is waiting on an approval nobody has
  answered. If that run has edited a folder, other threads' first edits there
  keep moving, or sharing with the note, until the approval is answered or
  the run is stopped.
- A folder is taken when an edit's start is committed, in Core's one admission
  queue, so of two first edits exactly one moves. After a restart the same
  fact is read from the committed edit records. Nothing new is stored.
- A run that is stopped, or whose thread is deleted, while its worktree is
  being made does not move its thread. Its edit ends with the run.
- The host names the worktree as the create sheet does (`generateWorktreeName`)
  and puts it on the branch `bs/<name>`. The ledger records it as the agent's,
  with the run and the thread.
- Where a thread cannot be given a worktree it shares the folder, with the
  note, as Sean's third answer does for a thread with uncommitted edits. An
  edit is refused only when a worktree should exist and could not be made, or
  when a thread reaches back into the checkout it left for its worktree.
  - A thread has one checkout, so only the folder it works in is replaced by a
    worktree. A clashing edit in another of its folders is made there.
  - A folder outside git cannot have a worktree. Threads share it as they did
    before Automatic. The option not taken was to refuse the later thread's
    edit until the other run ends, which would stop work in a plain folder
    whenever another thread is running or waiting on an approval.
  - Three more folders cannot have one, and share the same way. A repository
    with no commit yet has nothing for a worktree to start from. A folder
    inside a repository, below its top folder, cannot be replaced by a
    worktree of the whole repository: the same relative path would land
    somewhere else. And on a machine where git is missing or cannot read the
    folder, nothing says a worktree could exist; git's failure is logged. The
    platform reads each case from what git reports of the folder, before it
    creates anything.
  - A thread in a worktree that reaches back into the checkout it left is
    refused before anything else is weighed. A path it once edited there may
    be uncommitted again by the other thread's change, which is not its own
    work.
- "Uncommitted edits of its own" (Sean's third answer) is read as the paths in
  the edit records of the thread and its workers that git's status still
  reports as changed.
  - A path under a folder git reports as one entry, such as a nested
    repository, counts. Names are compared in one Unicode form.
  - Not seen: files git ignores, and changes a shell command made, which have
    no edit record. A thread whose only uncommitted work is of those kinds is
    moved, and that work stays in the checkout it left.
- A host that cannot open a worktree as a folder (the standalone host) does
  not apply the rule: its threads share a folder as they did.
- The refused call's result is how the model learns of the move. It names the
  worktree and the branch, and tells the model to make the edit again there
  and to give the person the branch name when the work is done.
- The visible note is a row in the thread's own transcript, from a committed
  event (`checkout.shared`). It says which folder is shared and why the thread
  stayed.

Built, in the agent host:

- The rule, for the four file tools (write, replace, rename, delete). The host
  settles the refused call unrun, makes the worktree through the worktree
  tool's own create-and-open, and moves the thread through the binding's own
  command (ADR-0028 step 3). The binding's commit says the host made the move
  and why (`enteredBy.cause: 'checkout-contended'`). Every file edit of the
  same step is left unrun too.
- A thread that only reads creates nothing.

Not built:

- The person asking for work in parallel from the control that says where a
  thread works, beyond New worktree… and Other worktree… (the control itself is
  below).
- The cap that archives idle worktrees.
- Moving a thread for a worker's edit or for a shell command.
- A note for a worker's own clashing edit. It is made in place with no note.
- Cleaning up a worktree that was made and never entered. It stays in the
  ledger, bound to no thread, when the run is stopped or its thread is deleted
  while the worktree is being made, whether the host made it or the model's
  worktree tool did (`manageWorktree` create), and when a worker dispatched in
  the same step keeps the thread where it is.
- An action that brings a worktree's changes back.
- The repository's setup script for a worktree the host made. Consent for it
  is kept by the renderer, so the host skips the script and the worktree shows
  the reason. Moving that consent to the host is a change of owner.

### The control that says where a thread works

Sean's answers:

- **Closed, it reads `<project> · <checkout>`**, in the Threads panel's words
  for the checkout: `brainstrike · Local` or `brainstrike · swift-badger`. In a
  worktree the project is named by the thread's Local folder. The branch moves
  into the menu.
- **Branch switching moves into the control**, as a Branch submenu: the
  switcher as it was (switch, create, fetch, Switch in a new worktree). There
  is no separate Branch chip.
- There is no stored "its own worktree / stay here" choice.

Built: the composer's Folder, Branch and checkout chips are one control
(`workspace-bar-where-chip`); the Trust chip stays its own. It is a merge of
the interface only: every row keeps its handler, hook, host method,
preconditions, refusals and test id. Open, it lists the project and its Local
folder's path; Local, checked while the thread works there and noting that a
clashing edit moves the thread to a worktree of its own; the thread's
worktree, checked, with its branch and any setup outcome; Other worktree… (the
picker) and New worktree… (the create sheet); the Branch and Folders submenus;
and, in a worktree, Create branch here and Archive worktree…. While the
thread's run is in progress the checkout rows are disabled with the reason. A
closed folder's repairs stay at the top level.

Removed as duplicates:

- the three separate triggers;
- Hand off to Local as its own row: choosing the Local row is the hand-off;
- the checkout's own Reveal and Open in Terminal, which the folder rows keep
  (and with them `WorkspaceBarMode.onReveal`, `onOpenTerminal` and
  `localPath`);
- Make primary on the Local folder while the Local row can hand off to it.

Decisions the build made, which are not Sean's:

- Make primary on the Local folder is kept when no Local row can hand off: a
  thread whose worktree folder is closed has no checkout rows, and Make
  primary is then the one action that returns it to that folder.
- The control is not modal, as the branch switcher's popover was not: a click
  on another thread closes it and selects that thread in one click. Its own
  trigger is not outside it, as a non-modal popover's is not.
- The folder rows are the Folders submenu while the thread has a live primary
  folder, and the menu itself while it has none (no folder, or a closed one).
- The closed label counts the folders beyond the project and its worktree
  (`brainstrike +1 · Local`). A folder outside git reads `Local` with no
  warning (the Explorer's header, below); any other unavailable checkout shows
  a warning and no checkout.
- The closed label names the checkout from the thread's binding, not from its
  folder's git status, so it keeps saying Local or the worktree while that
  status is read again after a checkout change or a thread switch. Where the
  platform has no worktrees (the web build) it names no checkout.
- The menu lists the thread's own worktree, not every worktree of the
  repository; the others are a click away in Other worktree….
- The Local row's branch in a worktree is read from the worktree list's
  primary checkout, and is left blank when the list does not name it.
- The project row shows the Local folder's full path; the control has no home
  directory to shorten it with.
- While a worktree operation runs, the closed control is `aria-busy`. Once the
  operation moves the thread, the new folder's git status is read before the
  checkout rows return (BST-2129); the operation's sheet and dialogs, and the
  busy state, keep the last rows' state through that read instead of closing
  and coming back.

### The Explorer's header (decision 3)

Built:

- The Explorer follows the active thread: the thread's worktree stands in the
  place of the folder it was made from, and no other worktree is shown.
- The header of the folder the thread works in reads `<project> · <checkout>`,
  as the where-control does closed: `brainstrike · swift-badger`, with the
  project named by the thread's Local folder, or `brainstrike · Local`. It is
  the one-folder row, or that folder's section when several are open. Other
  folders, and the Explorer with no thread selected, keep their names, and the
  full path stays on hover. It is display only: app-shell words it from the
  thread's binding and the open folders' names, and passes it to the Explorer
  through the thread-checkout context, the one thing the Explorer knows of
  threads.
- One function names a checkout for every surface that shows one
  (`checkoutName`, `@brainstrike/assistant-contract/thread-checkout-name`): the
  Threads panel's chip, the where-control and the Explorer's header.
- The composer's list of other open folders leaves out every managed worktree,
  so another thread's worktree, still mounted for that thread, is not offered
  (decision 2).

Decisions the build made, which are not Sean's:

- A folder outside git reads `<name> · Local`, the Threads panel's words, which
  already said Local for any thread with a folder. Sean's answer was that the
  control reads `<project> · <checkout>` in the Threads panel's words; a folder
  outside git is a project with one checkout (decision 1).
- When the thread's Local folder is not open in the window, the worktree's
  header keeps its folder's own name: the Explorer has no name for the project
  then.
- While no thread is selected, the new-thread composer is the active thread,
  so the Explorer follows the folder and checkout chosen for it before its
  first send: its worktree stands in for its folder and the header names it.
  Before, the Explorer followed only a thread that had been sent.

- The header's rows (Local, the repository's worktrees, New worktree and
  Archive) are the composer's where-control: the header of the folder the
  thread works in has a control, Change where this thread works, that opens
  it. They act through the thread binding, its only writer, and
  `useWorkspaceBar` still runs once.

Decisions the build made for the control, which are not Sean's:

- It opens the composer's where-control rather than drawing the rows in the
  Explorer. The where-control already holds them, with Branch and Folders,
  and the same wait for the thread's run to end.
- It shows only while a composer where-control is shown, so it never does
  nothing. The two share an in-memory count of shown controls and a request
  the header raises (`where-control-requests.ts` in app-shell); a
  where-control opens for a request raised while it is shown, never for one
  from before.

## Consequences

- The duplicate folder goes away without new storage. The project record
  (owner decisions, 2026-11-10) adds an identity of its own.
- The index stays one copy per repository. Deleted: the `worktrees` map in
  `index/config`, its Settings and Worktree Map toggles, and the worktree branch
  of `isPartitionRoot`.
- A worktree hit is as fresh as its file on disk: a chunk whose content differs
  in the worktree is dropped, never shown with the local checkout's text.
- Files only the worktree has (new, unindexed) are found by grep, glob and read,
  not by semantic search, until they reach the local checkout's index.
- Display and Open Folder came with the host-owned open-folder list (ADR-0029
  stage 4 slice C, #5017): Open Folder replaces the open folders, Recents
  switch, and a managed worktree is refused as a project. The Explorer's header
  is above.
