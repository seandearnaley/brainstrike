# User-defined slash commands — evidence

Supports `docs/agents/workspace-context.md` §
"USER-DEFINED SLASH COMMANDS".
Read before changing `/commands` discovery, frontmatter parsing, composer wiring, argument handling, or template expansion.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

Correction verified against the code on 2026-09-21, after this record was
written: the paired IPC test is
`apps/desktop/src/__tests__/ipc-domains/ipc-user-commands-handlers.integration.test.ts`,
not `ipc-user-commands-handlers.test.ts`.

## Record

Prompt-template `/commands` authored as `*.md` files, projected into the SAME
composer "/" menu as the built-in app commands (they are a second *kind* of entry
in the existing `SlashCommand[]` flowing through `unstable_useSlashCommandAdapter`
— no new autocomplete). **Desktop-only by construction**: discovery reads disk in
the main process; web has no `window.userCommands` bridge and the hook returns
`[]` (capability-gated, never `isElectron()`).

- **Discovery (main):** `apps/desktop/src/ipc-user-commands*.ts` +
  `assistant-server/user-slash-commands-loader.ts` scan `*.md` in PRIORITY order,
  first-name-wins: (1) `<root>/.brainstrike/commands/` per mounted root, (2)
  `~/.brainstrike/commands/`, (3) `<root>/.claude/commands/` (Claude Code compat),
  (4) `~/.claude/commands/`. Scan HIGHEST priority first (the mastra-code-ui
  reference inverted this — do not copy that bug). Recursive with directory
  namespacing (`git/commit.md` → `git:commit`); cross-root collision keeps the
  first-mounted + warns once (mirrors use-file-mentions.ts's warn-once set). Roots
  resolve via `loadWorkspaceRootsFromDatabase` (DB `roots.id`, never a raw path);
  a DB failure still loads GLOBAL commands (logged, not silent). Fs is
  dependency-injected for unit tests.
  Command `.md` files are UNTRUSTED repo content, so the scan is BOUNDED
  (`user-slash-commands-loader.ts`): a per-file cap `MAX_USER_COMMAND_FILE_CHARS`
  (64K) skips oversized files with a visible warn-once (the real-disk `readFile`
  also descriptor-gates so main never blocking-reads a giant file), and a
  `MAX_USER_COMMANDS` (500) count cap ignores the rest with a warn — never a
  silent truncation or a hard error that kills the whole scan. The real-disk
  adapter opens the canonical mounted root as a native `SecureRoot` capability
  (`@brainstrike/secure-fs-native`). POSIX traversal uses component-by-component
  `openat(..., O_NOFOLLOW)`; Windows uses handle-relative `NtCreateFile` with
  `RootDirectory`, `OBJ_DONT_REPARSE`, and `FILE_OPEN_REPARSE_POINT`. Directory
  enumeration and bounded file reads stay relative to that pinned handle, so
  roots cannot borrow one another's trust or win a parent-path swap race. There
  is no path-based fallback; missing native support fails closed.
- **Frontmatter:** hand-rolled `---\nkey: value\n---` parser
  (`parseUserCommandFile` in packages/assistant-contract — NO YAML dep) for
  `name`/`description` only; unknown keys ignored, and Claude Code multiline-YAML
  continuation lines (`- item` list entries, `# comments`) are TOLERATED/ignored
  (so real `.claude/commands` files with `allowed-tools:` lists load); a leading
  UTF-8 BOM is stripped before fence detection; other malformed/unterminated
  frontmatter fails CLOSED (skipped + visible error, never a silent half-parse).
  No frontmatter = whole file is the template. The id is path-derived
  (namespaced); `name` becomes the label only; `description` is fuzzy-searched by
  the popover adapter + shown as the item tooltip.
- **Composer wiring (renderer):** `packages/app-shell/src/use-user-defined-slash-commands.ts`
  is merged into `useAssistantSlashCommands(threadId)` via `mergeSlashCommands`
  (app commands first; a user command whose id COLLIDES with an app command is
  DROPPED with a warn-once — the pinned adapter's `onExecute` is find-first, so a
  listed collision would run the app command from the user's row). `execute()`
  reads the LIVE composer draft (the app-shell mirror
  `assistant-composer-command-store.draftTextByThreadId`, fed by
  `onComposerTextChange`), extracts any args, expands, and WRITES the expansion
  back via `enqueue({ mode:'replace' })` — never auto-sends (the user sees + edits
  before sending). `removeOnExecute: true`, uniform with app commands. No active
  thread → a visible toast (not console-only). The list reloads on mount, on
  mounted-root change, and on window `visibilitychange` (so a file edited while
  backgrounded appears without a full reload).
- **Arguments — placeholder-fill (F1, pinned-library constraint):** the pinned
  `@assistant-ui/react` trigger popover closes at the FIRST whitespace after
  `/id` (`detectTrigger` returns null), so INLINE `/cmd args` capture is
  UNREACHABLE in the live flow — the arg string is always empty at selection.
  `expandUserCommandTemplate` therefore leaves any unfilled `$ARGUMENTS`/`$N`
  token LITERAL as a VISIBLE placeholder the user fills in the composer before
  sending (never a silent empty blank). Do NOT re-document inline args as working,
  and do NOT add send-time expansion (no-silent-expansion is binding).
- **Expansion (pure, renderer-safe, `expandUserCommandTemplate`):** a SINGLE
  tokenizing pass (F2) so substituted argument text is NEVER re-scanned — a
  `$100` or `$1` the user types as an argument survives verbatim. `$ARGUMENTS` =
  full args (else visible placeholder); `$1..$N` positional (absent → visible
  placeholder). Template `@path` tokens become `:file[basename]{name=encoded}`
  directives via `encodeFileMentionId`, so the existing referenced-files pipeline
  resolves/reads/budgets them for free (NO new file-reading); args INSIDE a
  template `@…$1` path are substituted BEFORE serialization so a `}` in the arg is
  percent-encoded and cannot truncate the directive into a different file. Root
  binding: a root-scoped command binds to its `sourceRootId`; a GLOBAL command
  binds to the single mounted root, else leaves the token literal for the `@`
  popover (NO silent guessing). User-supplied `@` argument text stays literal —
  only template `@paths` convert.
- **SECURITY HARD LINE:** there is NO shell (!\`command\`) expansion, gated or
  not, ever — it passes through as inert text (proofs in the contract, loader,
  and hook specs). Do not add it.

Paired tests: packages/assistant-contract/src/__tests__/user-slash-commands.test.ts,
apps/desktop/src/__tests__/assistant-server/user-slash-commands-loader.test.ts +
ipc-domains/ipc-user-commands-handlers.test.ts,
packages/app-shell/src/__tests__/use-user-defined-slash-commands.test.tsx +
use-assistant-slash-commands.test.ts (F4 merge), and the REAL-trigger
packages/assistant-ui/src/__tests__/slash-commands.behavior.test.tsx
(F1 placeholder-fill through the actual popover + adapter + write-back).
Explicitly DEFERRED: shell expansion (never), web (no workspace-tool bridge),
namespaced/categorized popover grouping. (Mastra skills LANDED — see AGENT
SKILLS below; user-invocable skills are a THIRD slash-entry kind merged after
user commands. MCP server prompts are a FOURTH kind — see below.)

