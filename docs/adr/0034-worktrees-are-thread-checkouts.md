# ADR-0034: A worktree is a thread's checkout, not another folder

- **Status:** Accepted (Sean, 2026-11-01: "Adopt as proposed")
  - 2026-11-01 (BST-2436, [ADR-0035](0035-workspace-retrieval-is-live-search.md)): there is no index, so decision 5 (a worktree
    reads its repository's index) is void. A worktree's search is live grep on the worktree.
  - 2026-11-10 (owner decisions, below): decision 7's default is replaced by an Automatic default, a
    project gets a host-owned record with its own id, and the interface word is "Project".
  - 2026-11-11 (owner decisions, below): how Automatic isolation is built, and its first part;
    the composer's folder, branch and checkout chips become one control that says where a thread
    works.
  - 2026-11-12 (owner decisions, below): decision 7's cap keeps 15 idle managed worktrees per
    repository; built, with a control that restores an archived worktree.
  - 2026-11-12 (owner decisions, below): a thread sent with no folder while none is open works
    in a scratch folder the host makes for it.
  - 2026-11-12 (owner decision, below): repository setup script consent moves from the renderer
    to the host, so a worktree the host makes runs the script too.
  - 2026-11-12 (build decisions, under the project record below): a project can be named, a
    folder joined to another project, and a moved folder located; built.
  - 2026-11-12 (build decisions, below): Factory Reset archives every managed worktree before
    it deletes their ledger.
  - 2026-11-12 (build decisions, below): Clear Database archives every managed worktree too,
    and moves every scratch folder to the system Trash once it has cleared.
  - 2026-11-12 (build decisions, under scratch threads below): a scratch thread's folder can be
    turned into a project; built. Starting one from a thread that ran with no folder is built
    since (2026-11-13, below).
  - 2026-11-13 (build decisions, under the idle-worktree cap below): an idle managed worktree
    whose branch has commits of its own and adds nothing the default branch lacks is archived,
    and the thread that made it is told; built (BST-2504).
  - 2026-11-13 (build decisions, under the idle-worktree cap below): when a thread is deleted,
    the managed worktrees it made that no other thread is bound to are archived; built (BST-2505).
  - 2026-11-13 (build decisions, under scratch threads below): a thread that works with no
    folder of its own gets a new project folder the person places; built (BST-2513).
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
    archives the oldest idle worktrees that no open thread uses. The cap is
    built (owner decisions, 2026-11-12).
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
    - Every folder of one project lists in one section: a folder picked again
      at a new place while a record still leads to the old one, and a folder
      the person moved into the project (Move to project…, below). The section
      is named by its project's name once the person gave one; otherwise by a
      repository before a folder, then by name, whichever thread comes first.
    - A repository whose own checkout is not an open folder, and that the
      person has not named or moved into a project, has no project to read and
      keeps its common-dir section, and a folder recorded before projects keeps
      its own. A repository reached only through a subfolder opened by itself
      is not found: nothing looks above an opened folder. One the person names
      or moves gets a project of its own, below.
    - **A repository found inside an open folder can have a project of its
      own** (BST-2511, corrected by BST-2520). How it is built was not part of
      Sean's answers; these are build decisions, and later work may revisit
      them:
      - The project is made by the person's first Rename project… or Move to
        project… on the repository's section, in the store's commit for that
        change, and nothing else makes one. The roots domain, the one writer
        of projects, keeps it by the checkout's canonical path, as it keeps an
        opened folder's, and writes no root, no trust and no hook approval
        (`rename-project` and `join-project` by path; `projects/rename` and
        `projects/join` with `repositoryPath`). A move with no project yet puts
        the repository straight into the chosen one. BST-2511 made the project
        on every worktree listing instead; that wrote rows for every submodule
        and fixture repository the walk reached (a submodule keyed on
        `<repository>/.git/modules/<path>`, which never matches its checkout),
        left them behind when a repository moved or went, failed the whole
        listing over one refused folder, and could race Clear Database.
      - The store refuses, changing nothing, a path inside a `.git` folder
        (which is never a checkout), a path inside a scratch folder or a
        managed worktree, and an empty or relative path.
      - The worktree listing only reads (`repository-projects`): one lookup
        for the own checkouts of every repository it lists that is not an open
        folder, whether or not an open folder holds it now, carried as
        `projectId` and `projectName` on that checkout's entry (host protocol
        version 31). So a named repository keeps its section while the folder
        that holds it is closed, and a store that opened damaged still reads
        it.
      - Kept by the checkout's canonical path, the project is the same when
        the repository is later opened by itself, and when the folder that
        holds it is closed and opened again; Clear Database deletes it with
        every project.
      - Its section is `project:<id>` once it has a project, named by the
        project's name or else the checkout's folder name, and
        `repository:<commonDir>` before. Either way its menu has Rename
        project… and Move to project…, by the rules a folder's rename and join
        follow, and no Locate folder… and no New thread here, being no open
        folder. The panel offers them for any repository section whose own
        checkout is not an open folder, the folder that holds it closed
        included; what may not have a project is the store's to refuse.
      - Threads in its managed worktrees, and in its own checkout opened by
        itself, list in its section. A thread in the folder that holds it
        stays in that folder's project: it may work in any repository inside,
        and nothing moves it by a guess.
      - The panel reads the listing again after every project action, as it
        reads the folder rows, so a renamed or moved repository regroups.
    - Collapse state under a project is kept, not pruned, as for a
      repository. Saved collapse state of sections from before (keyed on the
      common dir or the root id) does not carry over.
  - Built: naming a project, joining a folder to another project and relinking
    a moved folder. How each is built was not part of Sean's answers; these are
    build decisions, and later work may revisit them:
    - **A project has a name the person gives it.** State DB version 18 adds
      `projects.name`, NULL while it has none; every project keeps its row and
      starts unnamed. The roots domain is its one writer (`rename-project`):
      it trims the name, an empty one clears it, and one longer than 80
      characters is refused and changes nothing. A root record carries
      `projectName` beside `projectId`, which Main decodes strictly (host
      protocol version 28, `projects/rename`). A project section in the
      Threads panel reads and sorts by the name when there is one, and is
      named as before when there is none. Its header's menu has Rename
      project…, an inline form like a group's rename; an empty name names the
      project by its folder again. Clear Database deletes the name with its
      project.
    - **Joining is something the person does.** Move to project… in a project
      section's menu lists the other projects the panel shows, and moves the
      folder that names the section into the one chosen (`join-project`,
      `projects/join`). Its folder row then names that project, and the
      project it left is deleted in the same commit once no folder is in it.
      A managed worktree and a scratch folder are refused, having no project
      of their own, and so is a folder or project the store does not have.
      Nothing joins folders by a remote URL or a commit.
    - **Joining writes nothing to trust or hook approvals.** Both stay keyed
      by each folder's own canonical path (ADR-0032), so a joined folder keeps
      its own answers and takes none of its new project's folders'. Being in
      one project is not proof that two folders are the same folder.
    - **Relinking was not reachable, so it is built as Locate folder….** A
      folder moved outside the app and picked again at its new place got a
      new root id and a new project: the registry matches a picked folder to
      a record by its canonical path, which the move changed, and the store's
      re-pin (`repin`) reached only a record whose own path now led
      elsewhere. A project section whose folder is not mounted now offers
      Locate folder… (`workspace/roots/locate`): the person picks where the
      folder is now, and the registry re-pins that record to it through the
      store's `repin`, so it keeps its root id, and with it its threads and
      its project. It is refused for a managed worktree or a scratch folder,
      for a folder still at its recorded place (it opens from Recents), and
      for a folder another record has. The Explorer then shows the folder by
      its path, as it shows a reopened one.
    - **A managed worktree's record never moves to another folder.** A folder
      opened before it was adopted as a managed worktree keeps kind `path`,
      so the store's re-pin itself refuses, in its own commit, to point a
      record the worktree ledger names (or a thread's own folder) at another
      folder; moved, it would part from the checkout the ledger records.
    - **A relink that committed is read again even when the Explorer cannot
      show the folder.** The panel re-reads the folder rows after every
      project action, whatever its outcome, and a refusal it shows goes with
      the rename form and with Project grouping.
    - **Trust does not follow a relink.** The person's pick is not proof that
      it is the same folder, so it is asked again at its new place, as any
      folder is. Its old place's answer stays with that path.
    - **The threads working in a located folder follow it there** (BST-2516).
      A thread's binding names its folder by root id and keeps the folder's
      path and name as hints, and a run's admission refuses a path hint that
      is not where the root is mounted. Once a Locate commits, the host
      rewrites those two hints, through the binding's own command, for every
      thread whose binding names the located root as where it works
      (`locate-rebinding.ts`, from the `workspace/roots/locate` route).
      A thread with a run in progress is rewritten at once, in Core's
      admission queue as any binding update is, rather than waiting for the run
      to end as Turn into a project… does. That run keeps the binding it was
      admitted with, at a place the folder had already left, so nothing it
      holds changes, and the thread's next run is admitted at the new place.
      Each rewrite reads the thread's binding again in its own admission slot
      and commits there: a where-control change queued before it may have
      moved the thread to another folder, and the hints must never land on
      that folder's binding. A thread deleted meanwhile is skipped, not
      counted as a failure.
      A rewrite that fails is a fault the panel shows, naming what to do. A
      path hint that still disagrees with the mount is refused as
      `workspace.binding-root-moved`: "This thread's folder is no longer at
      <path>. Choose it again from the where-control."
    - **A store refusal is typed.** The roots domain declines these requests
      with a `project.*` code and a message the person can act on
      (`StateStoreRefusalError`), the host passes them on as typed refusals,
      and the panel shows them.
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
    made in place, where its parent works, and never moves its parent. The
    person's own thread shows the note for it, at the run and the call that
    dispatched the worker, through any workers between; the worker's thread
    shows none. Every worker under that call notes at it, so each folder is
    noted once there, however many of them edit it (a build decision: the
    dispatching run keeps the call and folder pairs it has noted).
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
- Moving a thread for a worker's edit or for a shell command. A worker's run
  keeps the binding it was admitted with, and its thread cannot move while it
  works (ADR-0028 rule 5); a shell command is not writing (Sean's second
  answer).
- An action that brings a worktree's changes back.

Cleaning up a worktree that was made and never entered was on this list until
a deleted thread's worktrees were archived (BST-2505, under the idle-worktree
cap below). One whose thread still exists is left to the cap.

The repository's setup script for a worktree the host made was on this list
until consent for it moved to the host (owner decision, 2026-11-12, below).

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

New worktree… is one click (BST-2506). Choosing it makes the worktree at once
and moves the thread into it, with the defaults Automatic isolation uses: from
`HEAD`, named by the host's suggestion (`worktrees/create-context`'s
`suggestedName`), on the branch `bs/<name>`, not detached. Those defaults are
one pair of constants in `@brainstrike/types` (`DEFAULT_WORKTREE_BASE_REF`,
`WORKTREE_BRANCH_PREFIX`), which Automatic isolation and the create sheet's
first choices read too. It goes through the sheet's own create, so it waits for
the thread's run to end, mounts the folder, binds the thread and shows the same
toasts. A new Customize… row under it opens the create sheet unchanged; both
rows are disabled, with the reason, while the run is in progress.

The one exception is a repository whose setup script has no answer
(`repositorySetup.decision` is null). With no answer the host makes the
worktree and skips the script, and only the sheet asks Allow or Skip, so
New worktree… then creates nothing and opens the sheet on the context it read.
The script is never skipped silently.

Decisions the build made, which are not Sean's:

- The one-click path is a hook of its own (`use-quick-worktree.ts` in
  app-shell's hooks) behind one new mode handler, `onQuickCreate`, which
  resolves `{ needsSheet }`. It reads the create context through the sheet's
  own read, so the sheet that opens for the question shows the same name.
- The row keeps its label, New worktree…: it still opens the sheet when the
  setup script has no answer.
- The sheet notes, before Create, that uncommitted changes stay in the
  thread's folder. One click has no sheet, so once the thread is in the new
  worktree a toast says so ("Uncommitted changes stayed in <folder>").
- The desktop E2E specs share one helper (`e2e/utils/create-worktree.ts`) that
  makes a worktree in one click and reads its name and folder from the
  where-control.

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
- It shows only while the active thread's composer where-control is shown,
  so it never does nothing. The two share, by thread id, an in-memory count of
  shown controls and a request the header raises (`where-control-requests.ts`
  in app-shell). Inactive thread tabs keep their composers mounted, hidden, so
  only the active thread's where-control opens; it opens for a request raised
  while it is shown, never for one from before.

## Owner decisions, 2026-11-12: the idle-worktree cap (decision 7)

Sean's answers:

- **The cap is 15 per repository.** When a repository has more than 15 idle
  managed worktrees, the oldest beyond 15 are archived. Archive keeps its
  snapshot ref, so the worktree can be restored.
- **Idle means no thread is bound to it.** That covers worktrees left by
  deleted threads and by threads handed back to Local. A worktree an existing
  thread's binding names is never idle and never archived, however old.
- **The cap archives idle worktrees even with ignored files** (installed
  dependencies, build output, a copied `.env`), which archiving deletes.
  Uncommitted work stays in the archive snapshot, and unpushed commits stay on
  the worktree's branch, which archiving does not delete.
- **Always skipped:** a locked worktree, one with nested repositories, and one
  where a thread's run is active.
- **Each archive is shown to the person in a notice.**

Built: the cap (`worktree-idle-cap.ts` in the host's git cluster), its checks
in the worktree service's own archive (`idleCap`, `worktree-idle-archive.ts`),
and the thread's notice, a committed `worktrees.archived` row that Core writes.

Decisions the build made, which are not Sean's and which later work may
revisit:

- **When it runs.** After each managed worktree is created for a thread, in the
  repository it was created in. It starts as the creation returns, and the
  creation never waits on the cap or fails because of it; its archives queue
  behind the creation's own turn. The trigger is the worktree service's create,
  which all three creations use (the host's Automatic isolation, the model's
  `manageWorktree` create and the person's New worktree…). Caps run one at a
  time, so a second creation's cap sees the first one's archives. An archive
  holds the worktree service's one queue while it runs, as a person's does, so
  a worktree operation asked for meanwhile waits for it. A failure is logged
  with the repository and worktree. At the host's close the cap starts no
  further archive, and Core waits for the one in flight and commits its
  notice before it stops admitting, so no worktree is archived untold (from
  Codex's review). It does not run when a thread is deleted or handed back to
  Local; those worktrees are counted at the repository's next creation. A
  deleted thread's own worktrees are archived whatever the count (BST-2505,
  below).
- **The worktree just made is never counted.** Its thread is about to enter
  it, so the count does not depend on whether that binding has committed yet.
  A worktree that was made and never entered is counted from the repository's
  next creation, so the cap is what clears it away while its thread lives; once
  the thread is deleted, it is archived (BST-2505, below).
- **"Bound" is any of a binding's folders:** the thread's worktree
  (`checkoutWorktreeId`), its operating folder, the folder it returns to or
  another of its folders, matched by id, or by a folder's path (as opened and
  canonical) that is the worktree or lies inside it, against the worktree's
  ledger path and its realpath. A folder inside a worktree opened on its own is
  the worktree's files, and archiving the worktree would take it from the
  thread working there (from the commit security review). A
  thread that moves from one worktree to another keeps the first as one of its
  folders, and archiving it would leave that thread naming a folder that is
  gone. Every existing thread is read from Core's thread list (a worker takes
  its parent's binding, and a deleted thread is not listed). The bindings are
  read when the cap chooses and again in the archive's own turn, so a thread
  that takes the worktree meanwhile keeps it.
- **Oldest is the ledger's `created_at`**, then its id, as the ledger lists a
  repository. An idle worktree's last use is not recorded. A restored worktree
  keeps its first creation time.
- **A skipped worktree keeps its place.** The cap archives the idle worktrees
  older than the newest 15 and skips any it may not archive; it does not
  archive a younger one instead, so the newest 15 idle worktrees are never
  touched.
- **How it archives.** Through the worktree service's own serialized
  `archive`, the one a person's archive uses, with an `idleCap` that no client
  can send. In that turn it reads the bindings again and checks the lock (from
  git, not the cached inventory), nested repositories and an active run, and
  refuses the worktree on any of them; the cap leaves a refused worktree in
  place and logs why. Otherwise it archives with `force` and the archive
  preview's own confirmation token for the ignored files. The person's archive
  path under it still refuses an active run and nested repositories too.
- **Where the notice goes.** To the thread the creation was for, as a row in
  its transcript at every detail level: each archived worktree with its branch
  and its snapshot ref, where its uncommitted changes are kept, and where to
  restore one (restoring, below). The host's worktree and
  the model's name their run and thread. The person's New worktree… now names
  the selected thread, which it already required. The row shows with the run
  that made the worktree, or with the thread's latest run when the person made
  it between runs. A creation that names no thread (no client of the app
  sends one), or whose thread is gone before the cap reads its list, has no
  one to tell, so it runs no cap; the repository's next creation for a thread
  does. Nor does the person's creation in a thread with no run yet (a new
  thread before its first send): the row has no run to be shown with, and an
  archive is never left untold (from Codex's and Claude's review).

Built: restoring an archived worktree. These are build decisions, not Sean's,
and later work may revisit them:

- **Where.** The where-control's Other worktree… picker has an Archived
  section below the live worktrees: the archived managed worktrees of the
  repository the thread's folder is in, newest archive first, each with its
  name, branch, when it was archived and Restore and use. The picker's filter
  narrows it with the live list. The host lists them from the ledger's archived
  rows (`worktrees/list-archived`, a method added under protocol v27). The list
  belongs to the folder it was read for: when the thread's folder moves to
  another repository, the first repository's rows are neither shown nor
  restorable there, and a restore that finishes after the folder moved does not
  move the thread into it.
- **What it does.** Restore and use calls the host's existing
  `worktrees/restore`, the one writer: it recreates the worktree on its branch
  and replays its archive snapshot, so its uncommitted changes come back. Then
  it does what Use does: it opens the worktree's folder and binds the thread
  through the binding's own command. Like every checkout change it waits for
  the thread's run to end. A worktree a thread is bound to is not idle, so the
  cap does not archive it again while the thread works there. Nothing new is
  stored: no restore time, and a restored worktree keeps its first creation
  time (above).
- **Failure is visible.** A refused restore says why in a toast, as Use's,
  Create's and Archive's failures do, so it is seen after the picker closes, and
  in the picker while it is open: its folder is taken, its snapshot ref is gone,
  its branch has moved, or its branch is checked out in another worktree (git's
  own words). Nothing is retried or done instead. A worktree that was restored
  but that the thread could not enter (its folder did not open, the binding
  refused, or the thread's folder moved meanwhile) says so too; it is no longer
  archived, so Use can choose it.
- **The notice** says where to restore: Other worktree… in the composer's
  Where this thread works menu, then Restore and use under Archived.
- Files git ignores, which archiving deletes, do not come back.

Built: archiving a deleted thread's worktrees (BST-2505). The ticket set the
outcome; these are build decisions, mine and not Sean's, and later work may
revisit them:

- **The rule.** When a thread is deleted, each live managed worktree whose
  ledger row names that thread as its maker, and that no other thread is bound
  to, is archived. The thread that made it may be gone before it entered it:
  its run was stopped, or the thread deleted, while the worktree was being made
  (by the host's Automatic isolation or the model's `manageWorktree` create), or
  a worker dispatched in the same step kept the thread where it was. A thread
  that entered its worktree and is then deleted leaves it bound to no thread,
  so it is archived too. A thread's child threads are deleted with it, and each
  one's worktrees are archived the same way. The idle cap does not count on a
  deletion: a repository's other idle worktrees wait for its next creation.
- **No new column.** The ledger's `thread_id` already records the maker,
  written once at insert and never changed, as for every creation and adoption.
  A new ledger read, `list-thread`, lists a thread's live rows in every
  repository, since a thread can make worktrees in more than one and
  `list-repository` reads one. The state store's worktree ledger domain is its
  one reader and writer, and the state DB's schema is unchanged.
- **Bound** is the cap's test: any existing thread's binding names the worktree
  or a folder that is it or lies inside it. The deleted thread is no longer in
  Core's thread list, so its own binding does not keep the worktree. The
  bindings are read again in the archive's own turn, so a thread that takes the
  worktree meanwhile keeps it.
- **How it archives.** Through `archiveIdleWorktree`, inside the cap's queue,
  with the cap's skip rules: a bound, locked, nested-repository or active-run
  worktree stays. Otherwise it is archived with `force` and the archive
  preview's token, as the cap archives: the snapshot ref and the branch are
  kept, so Restore and use brings it back with its uncommitted changes, and the
  files git ignores are deleted.
- **When.** Once the deletion has committed: each deleted thread is erased and
  its runs have joined, so a tool call still making a worktree when its run was
  stopped or its thread deleted has recorded it by then. Core asks the
  platform through the cap's port (`idleWorktreeArchives.afterThreadDeleted`),
  outside its admission queue, and never waits on it: the deletion answers
  without it, and a pass that fails does not fail the deletion. At the host's
  close no pass starts, and the one in flight finishes before the worktree
  service retires, as the cap's do. A host with no cap (the CLI) archives
  nothing on a deletion.
- **No notice.** The thread is gone, so no one is told. One log line for each
  deleted thread names the worktrees archived (with branch and snapshot ref)
  and those left in place, each with why (`worktree.bound`,
  `worktree.run-active`, `worktree.locked`, `worktree.nested-repositories` or
  `host.closing`); an archive that fails is also logged as an error.
- **What it leaves.** A worktree made and never entered whose thread still
  exists stays until that thread is deleted or the cap counts it.

Built: archive on merge (BST-2504), the last part of the worktree life cycle
(a Restore action, a cap with skip rules, and archive on merge). The ticket set
the outcome; these are build decisions, not Sean's, and later work may revisit
them:

- **The rule.** An idle managed worktree is archived when its branch has
  commits of its own and adds nothing the repository's default branch lacks.
  All of these must hold:
  - the worktree is on a branch, not detached, and has no uncommitted changes
    (untracked files count; ignored files do not);
  - the branch has moved since the worktree was made: its tip is not the commit
    the ledger recorded at creation (BST-2518, below);
  - the branch has commits of its own: its tip is not on the default branch's
    first-parent history. The host asks `merge-base --is-ancestor`, then counts
    `rev-list --first-parent <branch>..<default>` and checks whether the default
    branch that many first parents down is the tip. A squash-merged branch's tip
    is not an ancestor, and a merged branch's tip is a merge's second parent, so
    both count. A branch only moved along that history (fast-forwarded to it,
    rebased onto it with nothing of its own left, or reset to an older commit of
    it) has none; each is left to the idle cap. A worktree made and never
    committed to is left to it by the rule above, wherever it was made (this
    rule alone did not leave it, BST-2518). So is a branch the default branch took by a fast-forward
    merge, which sits on that history. The first build compared the tip with the
    branch reflog's oldest entry, which counted a fast-forward, a rebase or a
    reset as commits of its own (from review);
  - `git merge-tree --write-tree <default> <branch>` merges without a conflict
    and writes the default branch's own tree. This catches a squash merge, which
    this repository makes through Mergify, as well as an ordinary one;
    `merge-base --is-ancestor` alone misses squash merges.
  "Merged" (`reason: 'merged'`) is the rule's name, not a claim: a commit and
  its own revert add nothing either, so the notice says merging the branch
  would change nothing rather than that it merged (BST-2518, below).
- **The default branch** is `origin/HEAD`'s target, else `origin/main`
  (`resolveDefaultBaseRef`, moved unchanged into `default-branch.ts`, which
  `branch-vs-base` changesets also use). The host never fetches, so merged
  means merged into the person's last fetch. A repository with neither archives
  nothing on merge and logs why.
- **Git 2.38.** `merge-tree --write-tree` came in Git 2.38, and the rest of the
  host needs 2.36. On an older git the pass refuses (`git.version-unsupported`),
  archives nothing and logs why.
- **A merge driver from the repository's own config.** A content merge in
  `merge-tree` runs a merge driver the repository's own config names
  (`merge.<name>.driver`, chosen by a `merge` attribute, which can sit in
  `.git/info/attributes`). That is a command from the folder, which the host
  never runs (BST-2454), and a driver can also make any merge come out as the
  default branch's tree. So a repository whose own config names a merge driver
  archives nothing on merge (`worktree.repository-merge-driver`) and logs why,
  trusted or not. Drivers in the person's global or system config run.
- **A known gap.** After a squash merge the merge base is still where the branch
  started. If the default branch later changes a file the branch added, or the
  lines it changed, `merge-tree` conflicts, and the worktree is left to the idle
  cap.
- **When it runs.** In the idle cap's pass after each creation, whether or not
  the creation names a thread, before the cap counts and in its queue, so a
  merged worktree never counts toward the 15. And once in each repository with
  live ledger rows when the host's git cluster starts serving (the first window
  subscription or inventory read once Core has opened its threads, as the
  snapshot startup GC), in the same queue, one repository per turn; it never
  holds up the host's start. Both stop when the host closes, as the cap does.
  It does not run when a thread's binding leaves a worktree; the next creation
  in that repository, or the next start, takes it. No notice from the start-up
  pass is dropped: Core subscribes to the platform's archives while it folds
  its log, before its thread list answers, and the pass reads that list before
  it archives anything.
- **What it archives.** Each idle, unarchived worktree of the repository (the
  cap's own test of idle), except the one just made, through
  `archiveIdleWorktree` with the cap's skip rules: a bound, locked,
  nested-repository or active-run worktree stays. The merged check runs before
  the archive is queued and again in the archive's own turn (`idleCap.isMerged`),
  so a worktree that took a commit or a change meanwhile stays
  (`worktree.not-merged`). The snapshot ref and the branch are kept, so Restore
  and use brings it back.
- **Ignored files are deleted**, as the cap deletes them: archive on merge uses
  the cap's archive, which confirms their deletion with the archive preview's
  token. This rests on Sean's 2026-11-12 answer that the cap archives idle
  worktrees even with ignored files (installed dependencies, build output, a
  copied `.env`). The rule needs no uncommitted changes, and the branch keeps
  its commits.
- **The notice.** The thread the ledger records as the worktree's maker
  (`threadId`) is told, in the same `worktrees.archived` row with
  `reason: 'merged'` and `defaultBranch` in place of `limit` (host protocol v30).
  It shows with the thread's latest run, since the run that made the worktree
  may be far back: "Merging the branch {branch} into {default} would change
  nothing, so its worktree {name} was archived.", then that its commits stay on
  its branch and in its archive snapshot, that files git ignores were deleted,
  and how to restore it (BST-2518 reworded both). A thread's worktrees from one pass share one row. A
  worktree no thread made, or whose thread is gone or has no run yet, is
  archived and logged, untold.
- **Rows from before v30 still read.** The cap's rows carry
  `reason: 'idle-cap'`. A row a v25 to v29 host committed has no `reason`; it is
  the cap's shape, so it decodes and shows as the cap's notice, and a thread
  told before v30 still opens. This is not a migration: nothing is rewritten.

Follow-up build decisions (BST-2518, from an independent review of BST-2504;
mine, not Sean's, and later work may revisit them):

- **A branch counts as merged only once it has moved.** "Commits of its own"
  (off the first-parent history) is not "committed to since it was made": a
  worktree defaults to the person's `HEAD`, often a feature branch, and one
  made at a commit the default branch later took by a merge commit or a squash,
  or at origin's tip that a pull then merged in as a second parent, was archived
  though never committed to, and so was one made moments before another and not
  yet bound. The ledger now records the commit each worktree was made at
  (`brainstrike_worktrees.base_commit`, state DB version 19): the creation
  reads the new worktree's `HEAD` after `git worktree add`, inside the insert's
  undo, so a failed read removes the worktree as a failed insert does; adoption
  records `HEAD` at adoption, as it records `baseRef`. The ledger's insert is
  the one writer and always writes it. The column is added as v18 added
  `projects.name`: no migration, so a row recorded before version 19 has none,
  and the merged check reads such a row as not merged
  (`base-commit-unrecorded`), never as merged. A damaged DB served unupgraded
  probes the column. The commit stays off the wire: `ManagedWorktreeRow` (which
  clients decode strictly) does not carry it, so the host protocol is unchanged;
  the host reads it with `WorktreeLedger.baseCommit`. It is checked in the pass
  and again in the archive's own turn. Clear Database and Factory Reset take it
  with its row (ADR-0015); it needs no reset step of its own.
- **Main reverting a merged branch.** A branch merged by a merge commit whose
  merge main then reverted still merges as nothing (git counts it merged), so
  it is archived, and "adds nothing that main doesn't already have" was untrue:
  its files are gone from main. The rule stays (its commits stay on the branch
  and in the snapshot, and Restore brings the folder back); the notice now says
  what holds for every branch the rule takes, that merging it into the default
  branch would change nothing.
- **The archive's own turn asks everything again.** It resolves the default
  branch and the checks before it (git version, a merge driver in the
  repository's own config, a partial clone) again, not only the branch, so a
  `merge.<name>.driver` written after the pass began never runs in the
  re-check's `merge-tree`. A changed default branch also leaves the worktree.
- **A partial clone archives nothing on merge.** `merge-tree` reads blobs, and
  in a partial clone git fetches a missing one from the promisor remote on
  demand, which breaks "the host never fetches". Git can be told not to
  (`--no-lazy-fetch`, `GIT_NO_LAZY_FETCH=1`) only from Git 2.45 (its release
  notes), and archive on merge runs from 2.38; without the blob the merge
  cannot be told either. So a repository with a promisor remote
  (`extensions.partialClone`, or a `remote.<name>.promisor` that is true)
  archives nothing on merge (`worktree.partial-clone`) and logs why, on every
  git. Tested with a real blobless clone: the blob the merge would need is
  still missing after the pass. `merge-tree --write-tree` still writes the
  merge's trees into the person's object store as loose objects; for a branch
  that merges as nothing they are the default branch's own, which git already
  has.
- **Unrelated history is not merged.** A branch whose history meets the
  default branch's first-parent history nowhere, merged in as a second parent
  (`--allow-unrelated-histories`), has no commit that many first parents down,
  and that failed `rev-parse` was logged as an error each pass. It is now not
  merged (`unrelated-history`), logged at debug as any other reason.
- **Wording.** The merged notice no longer reuses the cap's sentence on
  uncommitted changes, which a worktree archived on merge never has, and the
  platform's log for an archive with no thread listening no longer says "Idle
  worktrees"; it names the archive's reason.

## Owner decisions, 2026-11-12: scratch threads

Sean's answers, approved as written:

- **A thread first sent while it has no folder and no folder is open in the
  workspace works in a scratch folder.** The app makes the folder and binds
  the thread to it before the run starts, so file tools work from the first
  message. Before, with no folder open, they refused ("No folder is open in
  the workspace…").
  - With any folder open nothing changes: the run gets the live folders and
    the Explorer's focused one.
  - A thread that never sends makes nothing.
- **The folder lives under Electron's userData**, `<userData>/scratch/<name>`,
  named as managed worktrees are (`generateWorktreeName`). Factory Reset
  already deletes userData.
- **App-made folders are trusted with no question** (ADR-0032, owner
  decisions 2026-11-10): at the moment the app makes the folder, the host
  records it as `trusted` through `writeHostWorkspaceTrust`, never for a
  folder that already existed.
- **Deleting the thread moves its scratch folder to the system Trash.**
- Approved changes of owner: the host makes a folder and registers it as a
  root without the folder picker; Core binds the thread before its run is
  admitted; a new durable record marks scratch folders, with a state DB and
  protocol bump, joining the reset lifecycle (ADR-0015).

Built: all of the above. State DB version 17 (`scratch_folders`, root kind
`scratch`), host protocol version 26 (`thread/workspace/scratch`, the root
kind and the roots' `scratch` flag), `HostPlatform.scratchFolders`, and Main's
`platform/workspace/trash-scratch-folder`.

Decisions the build made, which are not Sean's and which later work may
revisit:

- **The renderer asks, the host decides.** The new-thread first send calls
  `thread/workspace/scratch` before `run/start` when its draft has no folder
  and the window shows no open folder. The host makes nothing while a folder
  is open: its root registry checks, in its own order of changes, so a folder
  opened meanwhile is seen and the thread runs as before. A thread that
  already works in a folder keeps it; the answer names its scratch folder when
  that is the one.
- **Made outside Core's admission queue, bound through the binding's
  command.** The queue is shared by every thread, so the folder is made
  outside it, as Automatic isolation makes a worktree, and the binding
  commits through `updateWorkspaceBinding`, its only writer. A deletion of the
  thread or the host's close aborts the making; the binding is then refused.
- **One folder per thread, reused.** The store refuses a second scratch folder
  for a thread, and a scratch command repeated after the folder was made, but
  before the binding committed, finds the recorded folder and binds it.
- **Its root is the thread's own, like a managed worktree's.** It is recorded
  in the commit that records `scratch_folders`, so no other registration can
  make a root a scratch folder. It is live, mounted for its thread at every
  launch, never an open folder, never in Recents, has no project, and is
  refused as the window's project. It reaches the renderer marked `scratch`.
- **The Explorer shows only the active thread's.** The thread-checkout seam
  that puts the active thread's worktree in the Explorer now carries its
  scratch folder too (`ThreadCheckout.threadRootId`, renamed from
  `worktreeRootId`), with no Local folder. Every other thread's is left out,
  as other threads' worktrees are. Its header and the composer's
  where-control read `<folder> · Local`: the folder is a project with one
  checkout (decision 1), in the words a folder outside git already had.
- **A run with no folder of its own never sees another thread's scratch
  folder.** Main's admission roots leave scratch roots out, so a thread's
  trusted folder (and its instructions) never reach another thread's run. A
  thread bound to its scratch folder acquires it through its binding, and the
  folder may be that run's selected folder.
- **A run names the Explorer's focus only when its thread can see that
  folder:** an open folder, or one of the thread's own (its binding's).
  While the active thread shows no folder, the Explorer keeps its last focus,
  which can be another thread's scratch folder or worktree; a send then names
  no folder, rather than one admission refuses (`threadSelectionFolderId`).
  The Explorer's focus itself is left as it is, so a restore that has not
  mounted the folders yet keeps it.
- **Made at its canonical path.** The host resolves the scratch directory
  before naming a folder in it, so the root, its watch and its trust answer
  spell it one way (a profile reached through a symbolic link, as the OS
  temporary folder is on macOS, otherwise showed no changes in the Explorer).
- **Retired by thread, not by binding.** A deleted thread's scratch folder is
  the one recorded for it, so it goes even when the thread had moved to
  another folder. After the thread's rows are erased, outside the admission
  queue: the folder unmounts once its borrows end, its root and record are
  deleted together, its trust answer goes, and Main moves it to the Trash.
  Main moves only a folder directly inside `<userData>/scratch`, by canonical
  path. A folder already removed outside Brainstrike is logged and skipped.
  The thread is gone by then, so a failure (a volume with no Trash, a system
  with none) does not fail the deletion: it is logged, the deletion's answer
  names the folder and Main's reason (`scratchFolderNotRetired`), and the
  window says so in a notice, so the person can remove the folder.
- **The Threads panel lists every scratch thread in one Scratch section.** In
  Project grouping a thread whose folder is a scratch folder lists in one
  section labelled Scratch, after every project and folder section and before
  No project. Before, each listed in a section of its own named by its folder
  (`quiet-otter`), as if each were a project.
  - Its id is the sentinel `folder-scratch`, built like `folder-unassigned`,
    so no `project:`, `repository:` or `folder:` id can produce it. Its
    collapse state is kept like the other keys: the prune reads only
    `folder:` keys.
  - Which folders are scratch folders comes from their `roots` records: Main's
    `readRoots` answer marks a root of kind `scratch`
    (`ThreadCatalogRoot.scratch`), never a path or a name. The kind already
    reached Main on the catalog wire, so the host protocol is unchanged. The mounted roots'
    `scratch` flag was not used: it is missing until the folders are restored
    at each launch and for a folder that cannot be mounted, and either would
    list the thread under its folder's name again.
  - A scratch folder that has become a repository's own checkout still lists
    in Scratch until Turn into a project… makes it a project: it is still in
    the app's data folder. Its row's chip names its branch after the folder
    (`quiet-otter · main`, or `detached`), and its hover text says so too
    (`on branch main`, or `on a detached HEAD`), so two scratch repositories
    are told apart and the row says it is one (BST-2510). Build decisions:
    - The branch is the worktree listing's, which already walks scratch roots
      (`repositoryByThreadId`, from `mapThreadRepositories`). One function,
      `resolveThreadScratchFolder`, both places the thread in Scratch and gives
      its row the folder with that listing entry, so the row never asks git
      and the host protocol is unchanged.
    - The folder's name and its branch are two texts, each cut on its own, so
      a long branch never hides the name. Under 420px both wait, and the chip
      is its folder icon alone, as before.
    - A pinned scratch thread's chip names its branch too, in Project
      grouping, as it names its folder.
  - Each row's checkout chip names its folder instead of Local, because the
    section does not, so two scratch threads are told apart. Under 420px it is
    its folder icon alone, as a worktree's chip is its branch icon. Other
    groupings read no `roots` rows, so their chips still read Local.
  - The section offers no New thread here: a new scratch thread starts from
    the ordinary New thread with no folder open.

### Turning a scratch thread into a project

Built: the first half of "Turn into a project", a scratch thread's folder
becoming a project. These are build decisions, not Sean's answers, and later
work may revisit them:

- **Where.** The where-control (`workspace-bar-where-chip`) shows Turn into a
  project… while the thread works in a scratch folder, read from its folder's
  descriptor (`scratch`). Like every checkout change it waits for the thread's
  run to end: the row is disabled with the reason while the run is in
  progress. The host refuses too (`workspace.scratch-project-running`) while
  the thread or one of its workers has a run in progress, before the picker is
  shown and again once the person has chosen, since this checkout change moves
  the folder a run works in. That second check, the move and the binding
  update share one slot of Core's admission queue, which every run admission
  takes: a run asked for meanwhile is admitted after the move, at the folder's
  new place. A refusal is said under the row and in a toast, in the host's
  words.
- **Destination.** Main's native folder picker chooses a parent folder, through
  the host's `platform/workspace/pick-folder`, the route Open Folder, Add
  Folder and the open-folder list already use. The project folder is
  `<parent>/<scratch folder name>`. Refused, with nothing moved: a path that
  already holds anything (`workspace.scratch-project-exists`), a parent that is
  gone, and a parent among the scratch folders themselves.
- **Move.** One rename, by the host's scratch platform (`hostScratchFolders`
  in `scratch-folders.ts`), the folder's maker. It moves only a folder directly
  inside `<userData>/scratch`, both compared at their canonical paths, the
  guard Main's Trash uses (`scratch-folder-trash.ts`). A destination on another
  disk (`EXDEV`) is refused with the reason (`workspace.scratch-project-other-disk`:
  pick a folder on the same disk); nothing is copied instead. The root
  registry unmounts the folder first, once its borrows end (its terminals and
  language servers go, as a removed folder's do), and mounts it again at the
  new place under the same root id.
- **Record.** One new roots-domain operation, `scratch-to-project`, in one
  commit: the root keeps its id, its kind becomes `path`, its path, canonical
  path and name are the new ones, its `scratch_folders` row is deleted, and it
  gets the project recorded for its new place, or a new one, as `register`
  gives a folder its project. It is refused, changing nothing, for a root the
  store does not have, one that is not a scratch folder, and a place another
  record has, each a typed store refusal (`project.*`). No schema change.
- **It is an open folder now, and in Recents.** The operation opens it at the
  end of the open folders, as a folder the person adds is, and the registry
  records it in Recents and tells Main. A folder of the person's that is not
  open is not mounted at the next launch, so the thread's next run would be
  refused as for a removed folder.
- **The thread follows.** The root id is kept, so the thread's threads list,
  its Explorer mount and its binding's root stay. The binding's own command
  then rewrites its path and name (`operatingRootPath`,
  `operatingRootDisplayName`), because run admission checks that path against
  the mount. The window shows the folder at its new place by its path, as it
  shows a scratch folder the host made, and the Threads panel reads the root
  records again, so the thread leaves Scratch for its project's section.
- **Trust is asked at the new place.** The person chose that place, and the
  ruling that an app-made folder is trusted covered the scratch place only. No
  trust or hook record is written, as Locate folder… writes none. The answer
  the app wrote for the scratch place stays with that path, as a located
  folder's old place's does; nothing reads it unless a scratch folder is made
  there again, which the app trusts anyway.
- **Deleting the thread later leaves the project, and so does Clear
  Database.** A deleted thread's scratch folder goes to the Trash by its
  scratch record, which this folder no longer has, and Clear Database moves
  only folders inside `<userData>/scratch`.
- **Order and what a failure leaves.** Move first, then the record, then the
  binding. The host logs where it moves the folder before the rename.
  - A move that fails changes nothing: the folder is mounted again where it
    was, still the thread's scratch folder.
  - A record that fails after the move says where the folder now is
    (`workspace.scratch-project-unrecorded`); nothing is mounted there. The
    scratch record still names the old place, which is gone, so the thread's
    next run is refused, and the person adds the folder from where it is.
  - A record that commits but whose mount fails says so
    (`workspace.scratch-project-unmounted`); the folder is open, and mounts at
    the next launch or from Recents.
  - A binding that does not commit after the record says where the folder is
    (`workspace.scratch-project-unbound`). The binding still names the old
    path, so the thread's next run is refused until the folder is chosen for
    it again.
  - A host that stops between the rename and the record's commit leaves the
    first case without its message: the folder is at its new place, named in
    the host's log, and the scratch record names a place that is gone. One that
    stops between the record and the binding leaves the last case. Both windows
    are a few milliseconds; nothing retries or repairs them.
- **The host method** is `thread/workspace/scratch/project`, for the desktop's
  private client only (host protocol version 29), answering the folder where
  it now is, or null when the person cancelled the picker.

Not built:

- Cleaning up scratch folders on Clear Database. Their rows go with the
  roots; the folders stay in the profile until Factory Reset, as worktrees do.
  Built since (Clear Database retires the worktrees and scratch folders,
  below).
- Mounting only the scratch folders of open threads. Every one mounts at
  launch, as every managed worktree does, each with its own handle.

### A thread with no folder of its own gets a new project folder

Built (BST-2513): the second half of "Turn into a project". A thread first
sent while a folder was open runs against the open folders and has no binding,
so once they close its file tools refuse ("No folder is open in the
workspace…"). It has no folder to move, so it gets a new one the person
places. It takes Turn into a project…'s path: the platform's scratch folders,
Main's picker, the roots domain as the only writer of the project, and the
binding's own command in one admission slot. These are build decisions, not
Sean's answers, and later work may revisit them:

- **Where.** The where-control shows New project folder… for a sent thread
  whose binding names no folder, once its metadata has loaded: never for the
  new thread before its first send, which the host has not made. A scratch
  thread is bound to its scratch folder, so it is offered Turn into a project…
  instead. The row is the first under "Where this thread works", before the
  folder rows. Like every checkout change it waits for the thread's run to
  end: the row is disabled with the reason while the run is in progress. The
  host refuses too, before the picker is shown and again once the person has
  chosen, while the thread or one of its workers has a run in progress
  (`workspace.folder-running`) and for a thread that has a folder
  (`workspace.folder-has-binding`). A refusal is said under the row and in a
  toast, in the host's words.
- **Destination and name.** Main's picker chooses a parent folder, through
  `platform/workspace/pick-folder`, as for Turn into a project…. The folder is
  `<parent>/<name>`. The name is the thread's title, slugged: lowercase ASCII
  letters and digits, every other run of characters one `-`, accents dropped,
  at most 64 characters. A thread with no title, or one that leaves no letter
  or digit, is named as a scratch folder is (`generateWorktreeName`), avoiding
  the names already in the parent.
- **Made, never reused.** Only the leaf is made, never its parents, so it is
  always a folder that did not exist. Refused, with nothing made: a place that
  already holds anything (`workspace.folder-exists`), a parent that is gone
  (`workspace.folder-parent-missing`), a parent the person cannot write to
  (`workspace.folder-not-writable`), and a parent among the scratch folders
  (`workspace.folder-inside-scratch`), every one of which Clear Database moves
  to the Trash. The platform's scratch folders make it
  (`HostScratchFolders.newProjectFolder`, `project-folders.ts`).
- **Opened as a folder the person chose.** The registry adds it as it adds a
  folder chosen in the picker (`addRoot`, the grant `workspace/roots/pick`
  uses): the roots domain's `register` records it with a project of its own,
  at the end of the open folders, in Recents, and Main is told. Not
  `addRootByPath`, which opens only a folder already granted (recorded, in
  Recents, or a managed worktree) and would refuse one made a moment ago, nor
  `openRootByPath`, which closes the other open folders. No new store
  operation and no schema change.
- **Trust is asked there.** The person placed it, so its trust is asked as for
  any folder they open; no trust or hook record is written. The ruling that an
  app-made folder is trusted covers a folder the app places itself, under
  `<userData>/scratch`.
- **The thread follows.** The last check, the folder's making and opening, and
  the binding update share one slot of Core's admission queue (`admitted`,
  with the binding's `held`): a run asked for meanwhile is admitted after it,
  at the new folder. The window then shows the folder, and the Threads panel
  reads the root records again.
- **Deleting the thread later leaves the folder.** It is not a scratch folder:
  it has no scratch record, and Clear Database moves only folders inside
  `<userData>/scratch`.
- **Order and what a failure leaves.** Check, make, open, bind. The host logs
  the folder it made before the registry opens it.
  - A registry that refuses to open it leaves nothing: the empty folder is
    removed and the registry's refusal is said. One that cannot be removed is
    said too, with the refusal.
  - A binding that does not commit says where the folder is
    (`workspace.folder-unbound`): it is open, with its project, and the thread
    still has no folder until the person chooses it for the thread.
  - A host that stops between the making and the opening leaves an empty
    folder, named in the host's log; one that stops before the binding leaves
    the folder open and the thread with none. Nothing retries or repairs them.
- **The host method** is `thread/workspace/folder/new`, for the desktop's
  private client only (`workspace.folder-new-desktop-only`; host protocol
  version 32), answering the new folder, or null when the person cancelled the
  picker. A worker is refused (`workspace.folder-worker`): it works in the
  folder of the thread that dispatched it.

## Owner decision, 2026-11-12: setup script consent moves to the host

Sean's decision, approved: an approved change of owner.

- **Repository setup script consent moves from the renderer to the host.**
  The renderer kept it in its own storage, so the host skipped the script for
  every worktree it made itself (Automatic isolation, the model's
  `manageWorktree`), and the worktree said "Repository setup script consent is
  required before it can run." Now one host record answers for every
  creation: a repository approved at the script's current hash runs its setup
  for the worktrees the host makes too.

Built. The answer is still asked in the create sheet ("Run repository setup
script?", Allow script / Skip script), changed there, and revoked in
Settings › Workspace. Host protocol version 27.

Decisions the build made, which are not Sean's and which later work may
revisit:

- **One record, keyed by repository.** One state-store setting,
  `worktrees.setup.consent`, holds
  `{ [repositoryId]: { decision, scriptSha256, decidedAt } }`, as the trusted
  locations are one setting (ADR-0032): the store cannot list keys by prefix.
  The repository id is the realpath'd git common dir, as before, so every
  checkout of the repository shares the answer. An answer replaces the
  repository's earlier one, and changes are serialized per store so two
  answers never drop each other's. A record the host did not write fails the
  read instead of reading as no answer.
- **One reader and writer** (`worktree-setup-consent.ts` in host-capabilities'
  git cluster), which reaches the store through `createWorktreeWorkspace`.
  The writer resolves the root's repository, reads the script again and
  refuses an answer whose hash differs from the one the person was shown, as
  `hooks/trust` refuses one; nothing is recorded then. It is called only for
  a person's answer, never by a run.
- **Three host methods on the git cluster**, for the desktop's private client:
  `worktrees/setup-consent/decide { rootId, decision, scriptSha256 }`,
  `worktrees/setup-consent/list` (for Settings) and
  `worktrees/setup-consent/revoke { repositoryId }`.
  `worktrees/create-context` answers the standing decision with the script
  (`repositorySetup.decision`) only when it was given for the script's
  current hash, so the rule that an answer for other bytes asks again is the
  host's, not the renderer's.
- **The worktree service reads the record on every create**
  (`readRepositorySetupConsent`), so the person's own worktree, the branch
  menu's "Switch in a new worktree", the model's `manageWorktree` and
  Automatic isolation run setup alike. `worktrees/create` no longer takes a
  decision. `resolveSetupCommand` still re-hashes the script before it runs and
  fails closed to a visible skip. A record that cannot be read fails the
  worktree's setup, visibly, not its creation.
- **The script runs from a private copy of the approved bytes.** Setup reads
  the script once, checks that buffer's hash against the answer, writes that
  same buffer to a file in a private directory (`mkdtemp` under the OS temp
  directory, mode 0700, the file 0600) and runs `/bin/sh` on it, with the
  worktree as its working directory as before. The copy is removed however
  setup ends, timeout and failure included. So the script's `$0` is that copy,
  not `.brainstrike/worktree-setup.sh`, and it reaches the repository through
  its working directory and `BRAINSTRIKE_ROOT_PATH`. A review of the first
  build found the hole this closes: setup checked the file's hash and then
  opened it by path again, so a run that could write the source checkout
  could swap the script in between and have a worktree the host made run
  bytes the person never approved.
- **The sheet asks the host, then reads the host's answer back.** Allow and
  Skip call `decide` and then `create-context` again; a refusal (the script
  changed since the sheet opened) is shown in the sheet, which keeps asking.
- **No migration.** The renderer's record
  (`brainstrike:worktree-setup-consent.v1`) is no longer read or removed;
  Brainstrike is greenfield, as ADR-0032 did for hook records. Each repository
  is asked once more.
- **Reset.** The record is a host setting: Clear Database keeps it, as it keeps
  workspace trust and hook approvals, and Factory Reset deletes it with the
  state store. That is the lifecycle the renderer's record had.

A known cost: setup runs inside the worktree service's one-at-a-time lock,
with its 300-second timeout. So once a repository is approved, Automatic
isolation's refused first edit waits for the setup script to finish before
the turn carries on in the new worktree, and other worktree operations queue
behind it. No timer was added for it.

Not built: telling apart scripts that differ between a repository's
checkouts. The script is read from the checkout the worktree is made from,
and one answer per repository holds one hash, so approving one checkout's
script makes another checkout's different script ask again.

## Factory Reset archives the managed worktrees, 2026-11-12

Build decisions, not Sean's, which later work may revisit. Managed worktrees
live in `~/.brainstrike/worktrees` or the folder chosen in Settings, outside
userData, and their ledger is in the state DB. Factory Reset deleted the
ledger with the state DB and purged userData, but nothing removed the folders:
they stayed on disk, unknown to the app, still in each repository's
`git worktree list`, and possibly holding the person's uncommitted work.

- **Before the state DB goes, every active managed worktree is archived**
  through the worktree service's own archive, the one a person's Archive
  worktree… and the cap use. Its snapshot ref
  (`refs/brainstrike/worktree-archive/<id>`) keeps its uncommitted changes in
  its repository, the branch stays, and the folder and git's registration go,
  so the person's work survives the reset in their own repository.
- **It forces as the cap does**, with the archive preview's own confirmation
  of ignored files, which are deleted. Every thread goes with the reset, so a
  worktree a thread is bound to is archived too. A locked worktree, one with
  nested repositories and one a run is active in are never forced; they stay
  in place, as does one whose archive fails (`worktree-reset-archive.ts`).
- **The person is told before they confirm** (from review of the build).
  Sean's answer that archiving deletes ignored files covered the idle cap.
  The build extends it to the reset, and the Factory Reset dialog says so up
  front: managed worktrees are archived into their repositories, uncommitted
  work kept as a snapshot ref and branches kept, and their ignored files, such
  as `.env` files and installed dependencies, deleted. Confirming is then an
  informed choice. The option not taken was to leave every worktree with
  ignored files in place.
- **What stays is named, and never stops the reset.** Each worktree left on
  disk is named with its path and why in the reset's result
  (`managedWorktrees`) and in Main's log. When the archive cannot run at all
  (no host, or a store it cannot open) the outcome says why, and the reset
  still completes: the person chose it, and Factory Reset is how a damaged
  store is recovered. Nothing deletes a worktree folder outside the archive.
- **The window shows it** (from review of the build). The window that asked
  for the reset is replaced before the reset answers it, so no result reached
  the person. Main keeps the outcome, and the replacement window takes it
  once as it starts (`db:takeResetOutcome`, renamed below) and shows a notice: each
  worktree left on disk with its path and why, or why none could be archived,
  with a line that archived work is in each repository's
  `refs/brainstrike/worktree-archive/*` and its branch. A clean archive shows
  only how many were archived. A reset that fails after the archive does not
  keep the outcome; the log has it.
- **Where it runs.** Main owns the reset (ADR-0015). After the reset's
  background runtimes stop and before it retires the profile, the last moment
  the host still serves the ledger, Main asks the host it launched, starting
  it first if it is gone. The archives take one turn of the worktree
  service's queue, and the service makes and restores no worktree after it, so
  a run still in progress cannot make one the reset would leave unnamed; the
  host closes next.
- **Only Main can ask** (from the commit security review). The request
  (`reset/worktrees/archive`, renamed below) travels on Main's private platform
  connection to the host, where Main's MCP retire for the reset already goes,
  and Main sends it once the host has confirmed Main ready. It is not a client
  method: the desktop's client connection, which every window and Main's own
  client share as `desktop-ui`, has no such method, so a window cannot force
  every worktree's archive or stop the service making worktrees. The option
  not taken was a client origin of Main's own, which every desktop-only
  method would then have had to admit.
- **What it does not cover.**
  - A run in progress when the reset starts keeps its worktree, named as
    above: the host ends runs only when it closes, after this step.
  - A worktree a run's shell command makes after this step is not seen: the
    service did not make it.
  - A reset that fails after this step leaves the worktrees archived: the
    ledger says so, and their snapshot refs and branches hold the work.
  - Clear Database keeps settings and deletes the ledger rows, and still
    leaves the folders. It is out of scope. Built since (below).

## Clear Database retires the worktrees and scratch folders, 2026-11-12

Build decisions, not Sean's, which later work may revisit. Clear Database
keeps settings and deletes content, and with it the worktree ledger
(`brainstrike_worktrees`) and every scratch thread's rows (`threads`,
`roots`, `scratch_folders`). The folders stayed: the managed worktrees
outside userData, still in each repository's `git worktree list` and
possibly holding uncommitted work, and the scratch folders in
`<userData>/scratch`, which Clear Database keeps. Factory Reset covers the
first (above) and deletes userData, the second with it; Clear Database
covered neither.

- **The worktrees are archived as Factory Reset archives them.** After the
  clear's runtimes stop and before Main asks the host to clear content, Main
  asks the host for the same archive, on the same private platform
  connection, with the same rules: forced past ignored files with the
  preview's confirmation, as the idle cap is, and never past an active run, a
  lock or nested repositories. Both resets delete every thread, so none
  counts as bound. The host closes after the clear, so the service making no
  worktree after the archive lasts until then. The request is renamed
  `reset/worktrees/archive`, since both resets send it; it is still not a
  client method.
- **The scratch folders go to the Trash only once the clear succeeded.**
  Main lists `<userData>/scratch` and moves each folder directly inside it to
  the system Trash through the guard a deleted thread's folder goes through
  (`trashEveryScratchFolder` in `scratch-folder-trash.ts`), as Sean ruled
  for deleting a scratch thread. Never before the clear: a failed clear keeps
  the threads those folders belong to. A file or a link there is left alone,
  and a missing `scratch` folder is nothing to move.
- **What stays is named, and never fails the clear.** Each worktree left on
  disk is named with its path and why, each scratch folder the Trash refused
  with why, and so is a step that could not run at all (no host, or a
  `scratch` folder that cannot be read). The person chose the clear, and it
  completes.
- **One outcome path.** The reset's outcome now carries which reset ran,
  its worktrees and, for Clear Database, its scratch folders. Main keeps it
  and the replacement window takes it once (`db:takeResetOutcome`, renamed
  from `db:takeResetWorktreeOutcome`, `takeResetOutcome` on the bridge), and
  shows a notice for each: what stayed with why, or how many were archived
  or moved.
- **The person is told before they confirm.** The Clear content dialog says
  that managed worktrees are archived into their repositories, uncommitted
  work kept as a snapshot ref and branches kept, their ignored files deleted,
  and that scratch folders are moved to the Trash.
- **What it does not cover.** The same gaps as Factory Reset's archive
  (above). No host makes a scratch folder while they are moved: the clear
  closed the host, and the next one starts after the window is replaced.
  A clear that fails after the archive leaves the worktrees archived and
  every scratch folder in place.
- **Desktop E2E never reaches the system Trash (BST-2507).** In test mode
  (the folder picker's check), Main moves a scratch folder it trashes, a
  deleted thread's or a cleared one, into the folder
  `BRAINSTRIKE_E2E_TRASH_DIR` names (`scratch-trash-destination.ts`); the
  guard in `scratch-folder-trash.ts` still decides which folder may move.
  The Electron fixture names a disposable folder for every test, so a spec
  reads what moved there. A test-mode launch that names none, or a
  relative path, starts as before, and each move refuses with why: the
  folder stays and is named in the outcome, never sent to the machine's
  Trash instead.

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
