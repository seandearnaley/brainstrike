# Cline: Token-Efficiency Architecture of Coding-Agent Tools

Repo studied: `/Users/seandearnaley/Documents/GitHub/cline`, HEAD `8ca3068b7` (2026-08-07). All paths below are relative to the repo root unless stated otherwise.

## 0. Architectural note (read this first)

This repo is **not** the classic Cline layout the prompt pointed at (`src/services/ripgrep`, `src/core/tools`). It has been restructured into a monorepo:

- `apps/vscode/` — the VS Code extension. It is now a thin **host**: it wires VS Code APIs (terminal, filesystem, webview) into a generic agent runtime as "executors," but does not itself implement tool logic anymore.
- `sdk/packages/core/` — a headless, provider-agnostic **`@cline/core`** agent SDK. This is where the actual tool definitions, executors, output caps, context-budget/compaction machinery, and system-prompt templates live. `apps/vscode` imports `createDefaultExecutors()` / `createDefaultTools()` from here (proof: `apps/vscode/src/sdk/vscode-file-read-executor.ts:1,16`, `apps/vscode/src/sdk/vscode-runtime-builder.ts`).
- `sdk/packages/shared/` — cross-cutting types + the base system-prompt text (`prompt/system.ts`, `prompt/cline.ts`).

The classic tool names (`read_file`, `write_to_file`, `replace_in_file`, `search_files`, `list_files`, `list_code_definition_names`, `execute_command`) still exist as **legacy identifiers only**, preserved for two purposes: (a) rendering old, already-persisted conversations in the webview (`apps/vscode/src/sdk/message-translator.ts:625-649`), and (b) an alias table that remaps a subagent config's legacy tool names onto the current tool set:

```ts
// sdk/packages/core/src/runtime/orchestration/runtime-builder.ts:90-101
const CONFIGURED_AGENT_TOOL_NAME_ALIASES: Record<string, string> = {
	apply_diff: "editor",
	attempt_completion: "submit_and_exit",
	bash: "run_commands",
	execute_command: "run_commands",
	list_code_definition_names: "search_codebase",
	list_files: "run_commands",
	read_file: "read_files",
	replace_in_file: "editor",
	search_files: "search_codebase",
	use_skill: "skills",
	write_to_file: "editor",
};
```

This confirms, factually, that `list_files` and `list_code_definition_names` (the tree-sitter code-outline tool) **no longer exist as live tools** — file listing folded into the general-purpose shell tool (`run_commands`, e.g. `ls`/`find`), and code-definition listing folded into `search_codebase` (regex/ripgrep). There is no tree-sitter-based code-outline tool anywhere in the active runtime; I searched `sdk/packages/core/src` and `apps/vscode/src` for `tree-sitter`/`treeSitter` and found none outside this alias comment.

The report below documents the **live, current** architecture, which is a materially different (and more aggressively token-optimized) design than the old XML-tool-call, giant-system-prompt Cline.

---

## 1. Built-in agent tools

Defined by `createDefaultTools()` in `sdk/packages/core/src/extensions/tools/definitions.ts:875-941`. Each tool is created by its own factory function and only included if enabled + an executor is supplied.

| Tool name | Purpose (one line) | Factory (file:line) | Executor (file) |
|---|---|---|---|
| `read_files` | Read one or more files (or an inclusive line range) at absolute paths, batched in one call | `definitions.ts:247` (`createReadFilesTool`) | `extensions/tools/executors/file-read.ts` |
| `search_codebase` | Regex pattern search across the codebase, ripgrep-backed with a JS-regex fallback | `definitions.ts:343` (`createSearchTool`) | `extensions/tools/executors/search.ts` |
| `run_commands` | Run non-interactive shell command(s) from the workspace root (also covers listing files, git, builds, tests) | `definitions.ts:457` (`createShellTool`) | `extensions/tools/executors/bash.ts` |
| `fetch_web_content` | Fetch a URL and analyze it against a caller-supplied prompt | `definitions.ts:518` (`createWebFetchTool`) | `extensions/tools/executors/web-fetch.ts` |
| `editor` | Controlled file edits: exact-match replace, line insert, or create-if-missing | `definitions.ts:660` (`createEditorTool`) | `extensions/tools/executors/editor.ts` |
| `apply_patch` | Alternative to `editor`: apply a unified "canonical patch grammar" (Codex/GPT-style) to one or more files. Mutually exclusive with `editor` — never both enabled at once (`definitions.ts:914-921`) | `definitions.ts:611` (`createApplyPatchTool`) | `extensions/tools/executors/apply-patch.ts` |
| `skills` | Invoke a configured skill/slash-command in-conversation | `definitions.ts:723` (`createSkillsTool`) | host-supplied |
| `ask_question` | Ask the user one clarifying question with 2–5 selectable options | `definitions.ts:780` (`createAskQuestionTool`) | host-supplied |
| `submit_and_exit` | Terminal "I'm done" tool for headless/YOLO runs; ends the run (`lifecycle: { completesRun: true }`, `definitions.ts:816-818`) | `definitions.ts:801` (`createSubmitAndExitTool`) | host-supplied |
| `spawn_agent` | Delegate a task to a sub-agent with its own system prompt/context | `sdk/packages/core/src/extensions/tools/team/spawn-agent-tool.ts:122` | — |
| team tools (`teams` catalog id) | Teammate management, task coordination, mailbox messaging, mission logs | `extensions/tools/runtime.ts:79-83` (catalog entry), impl under `extensions/tools/team/` | — |

Availability/mode gating for the catalog above lives in `extensions/tools/runtime.ts:29-84` (`BASE_TOOL_CATALOG`) and `extensions/tools/presets.ts:20-111` (per-mode presets: `act`, `plan`, `search`, `minimal`, `yolo`).

---

## 2. Search / grep and file-listing tools

There is **one** search tool, `search_codebase`, implemented in `sdk/packages/core/src/extensions/tools/executors/search.ts`. There is **no separate `list_files` tool** — listing is delegated to `run_commands` (see §0), so this section covers search in depth and notes the file-index helper that backs both search's fallback path and would back any listing.

### Ripgrep path (primary)

Availability is probed once and cached (`rgAvailable`, `search.ts:123-156`, 1s timeout). When available, ripgrep is invoked exactly as:

```ts
// search.ts:168-177
spawn("rg", ["--json", `--context=${contextLines}`, "--max-count=1", "-i", query], { cwd, ... })
```

Key facts:
- **`--max-count=1`**: caps ripgrep to **one match per file** — this is a hard per-file result cap, not just a display cap; it bounds work at the source.
- **`-i`**: case-insensitive by default.
- **`--context=N`**, default **`contextLines = 2`** (`search.ts:317`) lines before/after each match.
- **`maxResults` default `100`** (`search.ts:316`) — enforced while parsing the ripgrep JSON stream (`if (matches.length >= maxResults) break;`, `search.ts:230`).
- Ripgrep's own 5000ms timeout (`search.ts:344`, param `timeoutMs = 5000`) — on timeout, silently falls back to the manual regex path rather than erroring.

### Manual regex fallback (no ripgrep, or ripgrep failed/timed out)

Uses a cached fast file index (`getFileIndex(cwd)` from `services/workspace/file-indexer.ts:315`, see below) filtered by `shouldIncludeFile` (`search.ts:273-295`) against:
- `DEFAULT_INCLUDE_EXTENSIONS` — 38 extensions (ts/tsx/js/jsx/mjs/cjs/json/md/mdx/txt/yaml/yml/toml/py/rb/go/rs/java/kt/swift/c/cpp/h/hpp/css/scss/less/html/vue/svelte/sql/sh/bash/zsh/fish/ps1/env/gitignore/dockerignore/editorconfig) — `search.ts:50-91`.
- `DEFAULT_EXCLUDE_DIRS` — node_modules, .git, dist, build, .next, coverage, __pycache__, .venv, venv, .cache, .turbo, .output, out, target, bin, obj — `search.ts:93-110`.
- `maxDepth = 20` directory levels (`search.ts:318`, enforced `search.ts:283-285`).
- Same `maxResults = 100` and `contextLines = 2` as the ripgrep path.

### Exact output format returned to the model

Both paths build the same textual shape (representative example, ripgrep path, `search.ts:350-367`):

```
Found 2 results for pattern: handleClick

src/components/Button.tsx:42:10
  40: function setup() {
  41:   const el = ref.current
> 42:   el.addEventListener("click", handleClick)
  43:   return () => el.removeEventListener("click", handleClick)
  44: }

src/components/Menu.tsx:12:3
> 12: const handleClick = () => setOpen(false)
  13: return <div onClick={handleClick}>

(Showing first 100 results. Refine your search for more specific results.)
```

- Header line: `` `Found ${n} result${n===1?"":"s"} for pattern: ${query}` `` — singular/plural handled explicitly.
- Each match: `file:line:column` header line, then context lines prefixed `>` for the matching line, ` ` (space) for context lines, each as `` `${prefix} ${lineNumber}: ${text}` ``.
- Blank line between matches.
- If capped: trailing hint line `` `(Showing first ${maxResults} results. Refine your search for more specific results.)` `` (`search.ts:361-365`, `search.ts:468-472` for the fallback path).
- No-match message (fallback path only, ripgrep path returns `null`→falls through to regex on 0 matches so the message always comes from the fallback branch): `` `No results found for pattern: ${query}\nSearched ${totalFilesSearched} files.` `` (`search.ts:452-453`) — this is the "empty-result messaging" the model sees, with a concrete count so it can judge whether the pattern/scope was too narrow.

### Per-query output cap and truncation policy

`MAX_SEARCH_OUTPUT_CHARS = 48_000` (`extensions/tools/executors/output-limits.ts:50`). Applied by `capSearchOutput` (`search.ts:485-497`):

```ts
function capSearchOutput(text: string): string {
	if (text.length <= MAX_SEARCH_OUTPUT_CHARS) return text;
	const headLimit = Math.ceil(MAX_SEARCH_OUTPUT_CHARS / 2);
	const tailLimit = Math.max(1, MAX_SEARCH_OUTPUT_CHARS - headLimit);
	return (
		`${text.slice(0, headLimit)}\n` +
		`[... search output truncated: ${text.length} chars total. ` +
		"Narrow the pattern or scope to view the elided matches ...]\n" +
		text.slice(-tailLimit)
	);
}
```

This is a **middle-truncation**, not head or tail: first half preserved verbatim, last half preserved verbatim, elided middle replaced with an explicit char-count + actionable guidance ("Narrow the pattern..."). The doc comment at the top of `output-limits.ts:1-15` explains why: *"Every character returned by an executor is re-sent to the model on each subsequent request, so oversized outputs cost quadratically over the remaining run."* — this framing (quadratic cost of leaving big blobs in history) is the stated rationale for every cap in this file.

Multiple queries in one `search_codebase` call run in parallel (`Promise.all`, `definitions.ts:372-395`); the tool description explicitly encourages batching independent searches into one call (`definitions.ts:353-354`).

### File index used by the fallback search (and any listing)

`services/workspace/file-indexer.ts:315` `getFileIndex(cwd)`:
- Backed by `rg --files --hidden -g '!.git'` when ripgrep is present (`file-indexer.ts:85`), else a manual `readdir` walk.
- Runs in a **worker thread** (`isMainThread`/`Worker`, `file-indexer.ts:5,57-63`) so indexing a large repo doesn't block the tool-execution loop.
- **15s TTL cache** (`DEFAULT_INDEX_TTL_MS = 15_000`, `file-indexer.ts:7`) keyed by cwd, plus a **10-minute stale-entry eviction** (`STALE_CACHE_EVICTION_MS`, `file-indexer.ts:8`) so cwd caches for closed workspaces don't leak memory.
- Default excludes (separate, smaller list than the search tool's): `.git, node_modules, dist, build, .next, coverage, .turbo, .cache, target, out` (`file-indexer.ts:10-21`).

No pagination cursor exists for search — the model is expected to re-issue a narrower query, which is exactly what the truncation/cap messages instruct it to do (a deliberate in-context-learning nudge, see §8).

---

## 3. File-read tool and code-definition listing

### `read_files` (`extensions/tools/executors/file-read.ts`)

Line numbering (default on, `includeLineNumbers = true`, `file-read.ts:52-56`), format built in `readTextWindow` (`file-read.ts:161-170`):

```ts
const maxLineNumWidth = String(captured[captured.length - 1]?.lineNumber ?? totalLines).length;
const body = captured
	.map(({ lineNumber, text }) =>
		includeLineNumbers
			? `${String(lineNumber).padStart(maxLineNumWidth, " ")} | ${text}`
			: text,
	)
	.join("\n");
```

Representative output for a 3-line window starting at line 98 of a 1500-line file:

```
 98 | function example() {
 99 |   return true;
100 | }

[Showing lines 98-100 of 1500. Use start_line/end_line to read other sections.]
```

(Line numbers right-padded to the width of the largest number in the captured window, so columns stay aligned even as line numbers grow to 3–5 digits — `file-read.ts:103-105,161-163`.)

Defaults and caps (`extensions/tools/executors/output-limits.ts`):
- **`MAX_READ_LINES = 2_000`** lines per read (`output-limits.ts:41`).
- **`MAX_LINE_CHARS = 2_000`** chars kept per line — longer lines get `` ` [line truncated]` `` appended (`file-read.ts:140-142`); comment: *"defangs minified files"* (`output-limits.ts:43`).
- **`MAX_READ_OUTPUT_CHARS = 48_000`** total chars per read window (`output-limits.ts:47`); enforced incrementally while streaming lines (`file-read.ts:144-148`), not by a post-hoc slice, so a read that would blow the char budget stops capturing lines early even if the 2,000-line cap hasn't been hit.
- Unranged reads (no `end_line`) are additionally capped in *lines scanned* at **`MAX_UNRANGED_LINE_SCAN = 50_000`** (`file-read.ts:59,92-94`) to bound how far the stream-reader walks into a huge file before giving up; if that cap is hit, the reported total becomes an approximation: `` `${totalLines}+ lines` `` (`file-read.ts:180-182`).
- Footer message when the file has more content than was returned: `` `[Showing lines ${start}-${last} of ${total}. Use start_line/end_line to read other sections.]` `` (`file-read.ts:184-188`) — omitted entirely when the whole requested window fit (`file-read.ts:171-179`), so short files/ranges get no boilerplate.
- Requests may specify an inclusive one-based `start_line`/`end_line` for pagination (`schemas.ts:19-42`); `path` aliases (`file_path`, `filePath`, `paths`, `file_paths`, `files`) are all tolerantly accepted and normalized (`schemas.ts:75-106`), and orphan `{start_line, end_line}` objects emitted as a separate array element by some models are coalesced back onto the preceding path entry (`helpers.ts:80-135`) — a defensive normalization so a malformed tool call doesn't need a round trip to fix.

Binary/large-file handling (`file-read.ts:220-258`):
- Files with an image extension (`.gif .png .jpg .jpeg .webp`, `IMAGE_MEDIA_TYPES`, `file-read.ts:21-27`) go through a separate path: read whole, base64-encoded, returned as `[{type:"text", text:"Successfully read image"}, {type:"image", data, mediaType}]` (`file-read.ts:241-251`). Gated on `context.metadata?.modelSupportsImages === true`, else throws `"Current model does not support image input"` (`file-read.ts:237-239`) — the model is not silently given a broken/degraded image.
- Image size cap: `maxFileSizeBytes` default **10 MB** (`DEFAULT_FILE_READ_OPTIONS.maxFileSizeBytes = 10_000_000`, `file-read.ts:53`), else `` `Image file too large: ${size} bytes (max: ${max} bytes).` `` (`file-read.ts:232-235`).
- Non-image, non-text-streamable size cap: `MAX_TEXT_STREAM_BYTES = 100_000_000` (100 MB, `file-read.ts:58`) — above that, the read is refused with actionable guidance: `` `Text file too large to stream safely: ${size} bytes (max: ${max} bytes). Use a targeted command such as sed, grep, head, or tail to inspect specific sections.` `` (`file-read.ts:254-258`). "Binary files that are not image and large files are not supported" is stated directly in the tool description (`definitions.ts:259`).
- Reads run through `createReadStream`/`readline` (`file-read.ts:107-118`), so a 48,000-char cap does not require loading the whole file into memory first — streaming stops as soon as caps are hit.
- Abort support: an `AbortSignal` destroys the stream mid-read (`file-read.ts:112-118`) rather than letting a huge read run to completion after the caller gave up.

`read_files` accepts multiple file requests per call and executes them concurrently (`Promise.all`, `definitions.ts:300-333`); the tool description explicitly tells the model to batch known files into one call (`definitions.ts:256-258`).

### Code-definition listing (tree-sitter)

**Does not exist as a live tool.** There is no tree-sitter dependency or code-outline executor anywhere under `sdk/packages/core/src` or `apps/vscode/src`. The classic tool id `list_code_definition_names` survives only as a legacy alias that now routes to `search_codebase` (`runtime-builder.ts:95`, quoted in §0) and as a webview-rendering case for replaying old conversation history (`message-translator.ts:673-679`). Do not assume tree-sitter outlining is present in this codebase today.

---

## 4. Command-execution output handling (`run_commands`)

Executor: `extensions/tools/executors/bash.ts`. Spawns via Node `child_process.spawn` (not a shell string eval unless a plain string command is given — structured `{command, args}` input bypasses shell parsing entirely, `bash.ts:333-352`).

### Streaming collection with bounded memory

`createRollingCollector(maxChars)` (`bash.ts:87-125`) is the retention policy: it keeps the **first half** of the char budget verbatim as `head`, and rolls a **tail** buffer of the remaining half so the *most recent* output always survives, discarding the earliest-dropped middle as it goes — this happens incrementally as stdout/stderr stream in, not as a post-hoc string slice, so a runaway command doesn't need its full output buffered in memory first. A `node:string_decoder` `StringDecoder` is used specifically so multibyte UTF-8 sequences split across chunk boundaries aren't corrupted (`bash.ts:90-92,111`), and it's explicitly flushed at end-of-stream (`decoder.end()`, `bash.ts:117`) so trailing non-ASCII bytes aren't silently dropped.

### Cap and truncation format

`MAX_COMMAND_OUTPUT_CHARS = 48_000` (`output-limits.ts:18`), same middle-truncation shape as search:

```ts
// output-limits.ts:20-38
export function truncateCommandOutput(text, { maxChars, totalChars }) {
	...
	return (
		`${text.slice(0, headLimit)}\n` +
		`[... output truncated: ${totalChars} chars total. ` +
		"Refine the command (grep, head, tail) to view the elided middle ...]\n" +
		text.slice(-tailLimit)
	);
}
```

stdout and stderr are combined by default (`combineOutput = true`, `bash.ts:326`) as `` `${stdout}\n[stderr]\n${stderr}` `` when stderr is non-empty (`bash.ts:253,272`).

### Error surfacing

- Non-zero exit: result text is prefixed `` `[Command exited with code ${exitCode}]\n${output}` `` (or just the bracket if output is empty) and thrown as a `CommandExitError` (`bash.ts:21-29,265-269`) carrying `.exitCode` and `.output`; the tool-definitions layer catches this specifically and reports `{query, result: error.output, error: error.message, success: false}` rather than losing the partial output (`definitions.ts:218-224`).
- Timeout: `TimeoutError` triggers a full process-tree kill — POSIX via `process.kill(-pid, "SIGKILL")` on the negative (group) pid since the child is spawned `detached` (`bash.ts:144,203-206`), Windows via `taskkill /PID <pid> /T /F` with its own 5s watchdog (`bash.ts:176-199`) — before rejecting, so timed-out children don't linger as zombie output producers.
- Default timeout **30_000ms** (`ShellExecutorOptions.timeoutMs` default, `bash.ts:44-45,324`), doubled at the tool-call layer for the outer race (`timeoutMs * 2`, `definitions.ts:482`) to give the inner kill sequence room to finish before the outer promise gives up.
- The full executed command is echoed back in the `query` field of the result **only up to `RUN_COMMAND_QUERY_PREVIEW_LIMIT = 200` chars** (`helpers.ts:191`), with the rest replaced by `` ` ... [command truncated: ${n} more chars; full command is in the tool call input]` `` (`helpers.ts:198-207`). Rationale stated directly in the doc comment: *"The full command already exists in the assistant tool-call input, so repeating it in the result only duplicates tokens in the provider request (expensive for large heredoc/file-generation commands)."* — this is a pure token-dedup optimization, not a correctness fix.
- Multiple commands per call run concurrently via `Promise.all` (`definitions.ts:194-236`), and adjacent heredoc-delimited command strings that a model split across array elements are coalesced back into one multi-line command before execution (`coalesceAdjacentStringHeredocs`, `definitions.ts:153-178`) — another defensive repair that avoids a wasted failed-call round trip.

---

## 5. Tool DESCRIPTION prompts (what the model sees as "the tool")

This is the most structurally different piece versus classic Cline. Tools are sent to the provider as **native function/tool-calling schemas** (`zodToJsonSchema(...)`, e.g. `definitions.ts:261,357,481,530,621,675,791,815`) — there is **no XML-tag tool-use protocol and no giant per-tool usage-example block baked into the system prompt**. Each tool's entire "prompt surface" is its `description` string plus its Zod-derived JSON Schema (whose field `.describe()` calls double as inline per-parameter documentation, e.g. `schemas.ts:29-42`).

Representative full description strings (verbatim, with computed constants resolved):

- `read_files` (`definitions.ts:255-260`): *"Read the content of text or image files at the provided absolute paths, or return only an inclusive one-based line range when start_line/end_line are provided on the same file entry as its path. When you already know multiple files you need, read them together in one call, and call this tool in the same response as other independent tool calls. Each read returns at most 2000 lines / ~47k characters; longer files report their total line count, page through them with start_line/end_line on that file's entry. Binary files that are not image and large files are not supported. Returns file contents or error messages for each path."*
- `search_codebase` (`definitions.ts:352-356`): *"Perform regex pattern searches across the codebase. Supports multiple parallel searches. When several search patterns could be useful and do not depend on each other, run them together in one call, and call this tool in the same response as other independent tool calls. Use for finding code patterns, function definitions, class names, imports, etc. Output beyond ~48k characters per query is middle-truncated; narrow patterns beat broad ones."*
- `run_commands` — description is **built dynamically per shell kind** by `buildRunCommandsDescription(shellKind, isWindows)` (`definitions.ts:410-440`), with different quoting/sequencing guidance for PowerShell/cmd vs POSIX shells, plus a WSL-specific mount-path note. It is re-derived via a JS getter at send-time when the configured shell is a provider function (`definitions.ts:501-509`), so a runtime shell change is reflected in the very next model request rather than only at session start.
- `editor` (`definitions.ts:669-673`): *"An editor for controlled filesystem edits on the text file at the provided path. Provide `insert_line` to insert `new_text` at a specific line number. Otherwise, the tool replaces `old_text` with `new_text`, or creates the file with `new_text` if file does not exist. Use this tool for making small, precise edits to existing files or creating new files over shell commands. If several edits to different files or non-overlapping regions are already known, emit multiple editor tool calls in the same response instead of serializing them across turns."*
- `apply_patch` (`definitions.ts:568-604`, `APPLY_PATCH_TOOL_DESC`) is the one tool with a **large, example-bearing description** (~35 lines) — it spells out the full canonical patch grammar (`*** Begin/Update/Add/Delete File`, `@@` section markers, `-`/`+` diff lines) with a worked example. This is deliberate: it's only enabled for models trained on that exact format (see model-tool-routing below), so the extra prompt tokens are paid only when they buy reliability.
- `skills` (`definitions.ts:729-735`) description is also dynamic: a JS getter appends `` `Available skills: ${names.join(", ")}.` `` from the currently configured, non-disabled skills (`definitions.ts:758-770`) — so the model only ever sees skills that actually exist for this session, not a static catalog.

All descriptions live in `sdk/packages/core/src/extensions/tools/definitions.ts` (factories) and `schemas.ts` (per-field `.describe()`), i.e. in **code**, not in a separate prompt-template file — they are generated fresh per tool-set construction, so mode/shell/skill-set changes are reflected without touching a prompt string by hand.

### Base system prompt is intentionally tiny

`sdk/packages/shared/src/prompt/system.ts:1-36` (`DEFAULT_CLINE_SYSTEM_PROMPT`) is ~30 lines / roughly 2,000 characters, with **zero tool-specific instructions or examples** — it covers identity, an environment block (`{{PLATFORM_NAME}}`, `{{CURRENT_DATE}}`, `{{IDE_NAME}}`, `{{CWD}}`), a short list of behavioral rules (parallel-tool-call encouragement, "always use absolute paths," etc.), and two placeholders (`{{CLINE_RULES}}`, `{{CLINE_METADATA}}`) filled in per-session. The YOLO variant (`system.ts:38-68`) is similarly short. Mode-specific content is **additive and conditional**, not baked into the base prompt:
- `MODE_TAG_INSTRUCTIONS` (`sdk/packages/shared/src/prompt/cline.ts:21`) explaining the `<user_input mode="...">` wrapper.
- `PLAN_MODE_INSTRUCTIONS` / `PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH` (`cline.ts:34,42-45`) — only appended when the session is actually in plan mode, and the manual-switch variant is used specifically for hosts (VS Code) that don't expose a `switch_to_act_mode` tool, so the model isn't told about a tool it can't call.

Net effect: the token cost of "explaining the toolset" is paid once, compactly, via the provider's native tool-schema channel (which many providers cache/optimize separately from prompt text) rather than duplicated as prose inside the system prompt — a structural token-efficiency choice, not just a size tweak.

---

## 6. Global token-budget machinery

Two independent layers exist: (A) per-tool-result caps applied by the executors themselves (§§2–4, all ~48,000 chars), and (B) a message-history-wide budget system that runs on **every** provider request build, downstream of whatever the executors returned. Layer B lives in `sdk/packages/core/src/session/services/message-builder.ts` (`MessageBuilder`, 1,727 lines) and `sdk/packages/core/src/extensions/context/`.

### Layer B1 — unconditional per-tool-result cap (tighter than the executor cap)

`DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000` (`message-builder.ts:27`). This is applied to **every** `tool_result` block, every time `buildForApi()` runs — not just under budget pressure:

```ts
// message-builder.ts:268-271
// Truncation is default-on for every tool result: MCP and custom SDK
// tools produce payloads just as large as the built-in ones, and any
// allowlist gate silently exempts them.
nextContent = this.truncateToolResultContent(nextContent);
```

So while an executor may return up to ~48,000 chars (and that full text is what gets *persisted* in session history / shown in the UI), the text actually sent to the model on the request immediately following the tool call — and on every later request that still includes that turn — is re-clamped to 8,000 chars via the same middle-truncation shape (`truncateMiddleByChars`, marker `` `\n\n...[truncated ${n} chars]...\n\n` ``, `message-builder.ts:52,1125-1131`). This closes a gap the comment names explicitly: a naive design might only cap the *known* built-in tools, letting MCP-server or custom-SDK tool results balloon unchecked; capping unconditionally at the message-builder layer covers all of them uniformly. Configurable via env var `CLINE_MESSAGE_BUILDER_MAX_TOOL_RESULT_CHARS` (`message-builder.ts:44,93-95`).

Other per-turn caps in the same class, all with the same "default-on every build" semantics:
- `DEFAULT_MAX_FILE_CONTENT_CHARS = 50_000` (`message-builder.ts:28`) — looser cap specifically for top-level `file` content blocks (user-attached files), kept separate from the tool-result cap "so the aggressive tool-result limit does not mutilate content the user explicitly supplied" (`message-builder.ts:233-235`).
- `DEFAULT_MAX_ASSISTANT_TEXT_CHARS = 200_000` (`message-builder.ts:35`) and `DEFAULT_MAX_ASSISTANT_TOOL_MARKUP_CHARS = 12_000` (`message-builder.ts:36`) — assistant messages get a much looser general cap, but a **much tighter** cap (12k) kicks in specifically when `hasRepeatedToolCallMarkup` detects ≥8 tool-call-shaped repeats in one assistant text block (`REPEATED_TOOL_CALL_MARKUP_THRESHOLD = 8`, `message-builder.ts:41,1148-1160`) — a heuristic for catching a model stuck emitting repetitive tool-call-like text and clamping the damage harder than normal prose would need.

### Layer B2 — aggregate total-text-byte budget (rare overflow valve)

`DEFAULT_MAX_TOTAL_TEXT_BYTES = 6_000_000` (`message-builder.ts:34`) UTF-8 bytes across the whole built request. The comment is explicit about why this is set so much higher than the per-result cap would suggest is ever needed:

> *"The aggregate budget intentionally stays far above what the per-result cap usually produces: budget truncation rewrites bytes mid-transcript, which invalidates provider prefix caches from the first rewritten block onward, so it must remain a rare overflow valve rather than the steady state."* (`message-builder.ts:31-34`)

i.e. this cap is a last-resort backstop, not the primary control — the primary controls (executor caps + the 8k per-result cap) are tuned to almost never need it, specifically to avoid invalidating a provider's prompt-prefix cache (which would make every subsequent request in the run more expensive, not less). When it *does* trigger, `truncateToTotalTextBudget` (`message-builder.ts:1162-1201`) walks a prioritized candidate list and shaves bytes off the least-important entries first until under budget.

### Layer B3 — stale-read rewriting ("outdated file content")

This is the file-context-tracking mechanism referenced in §7 below — when a file is re-read (in whole or by overlapping range) later in the conversation, the **earlier, now-superseded** `read_files`/`read` tool-result text is rewritten to a short placeholder rather than being repeated verbatim on every subsequent request:

```ts
// message-builder.ts:48
const OUTDATED_FILE_CONTENT = "[outdated - see the latest file content]";
```

Batching, not eager rewriting: rewrites are only *committed* once the reclaimable bytes across all newly-stale locators cross `DEFAULT_MIN_OUTDATED_REWRITE_BYTES = 65_536` (64 KB, `message-builder.ts:38-39,404-406`). The comment: *"Batch stale-read rewrites to avoid breaking provider prefix caches on every re-read. 64KB is roughly 8 provider-capped read results; set to 0 for eager rewriting."* (`message-builder.ts:38-39`, logic in `commitOutdatedRewrites`, `message-builder.ts:336-418`). Rollback is supported: if a locator that was marked outdated becomes current again (e.g. history was rewound), it's un-committed (`message-builder.ts:367-377`).

### Compaction / auto-condense (context-window management)

Constants in `extensions/context/compaction-shared.ts:13-22`:

| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_MAX_INPUT_TOKENS` | 128,000 | fallback model input budget when the model's own limit is unknown |
| `CONTEXT_WINDOW_INPUT_RATIO` | 0.9 | when only a context-window size is known (no explicit input-token limit), usable input = 90% of it |
| `COMPACTION_TRIGGER_RATIO` | 0.9 | compact once the transcript reaches 90% of the usable input budget |
| `DEFAULT_TARGET_RATIO` | 0.7 | compaction target: shrink back down to 70% of budget |
| `DEFAULT_PRESERVE_RECENT_TOKENS` | 20,000 | recent tail always protected from compaction |
| `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` | 1,024 | cap on the compaction summary itself |
| `TOOL_RESULT_CHAR_LIMIT` / `FILE_CONTENT_CHAR_LIMIT` | 2,000 each | tighter caps used specifically when serializing history *into* the summarizer's own input |
| `LONG_CONVERSATION_TARGET_RATIO` | 0.5 (`compaction.ts:89`) | more aggressive target ratio path for very long-running conversations |

Two compaction strategies (`extensions/context/compaction.ts:150+`, dispatch table `BUILTIN_COMPACTION_STRATEGIES`):
- **Agentic** (`agentic-compaction.ts`): calls the *active* model (or a separately configured summarizer model, `resolveSummarizerConfig`, `compaction-shared.ts:688-728`) to produce a structured continuation summary. Prompt template (`compaction-shared.ts:652-679`, `buildSummaryRequest`) asks for fixed sections — `## Goal`, `## State` (Done/In Progress/Blocked), `## Highlights`, `## Next`, `## Files` (Read/Edited) — a schema chosen so the summary is compact and directly re-usable as future context rather than freeform prose. Minimum summarizer input budget floor: `MIN_AGENTIC_SUMMARY_INPUT_TOKENS = 1_024` (`agentic-compaction.ts:28`).
- **Basic** (`basic-compaction.ts`): deterministic, non-LLM fallback — walks tool activity and produces a mechanical summary (`formatToolActivitySummary`/`summarizeToolActivity`, `compaction-shared.ts:544-628`) instead of asking a model to write one.
- **Forced/deterministic recovery path**: `overflowRecovery` (`compaction.ts:44-51`) is set by the runtime when the *provider itself* rejected the previous request as context-window-exceeded — this forces compaction regardless of the token-estimate trigger and **specifically uses the basic (non-LLM) strategy**, because "recovery must not depend on another successful LLM request" (comment at `compaction.ts:47-49`) — i.e. don't try to fix an overflow by asking the (currently-overflowing) model to summarize itself.
- Compaction summaries are injected back as a tagged user message (`buildSummaryMessage`, `compaction-shared.ts:729-753`) carrying `metadata.kind: "compaction_summary"` so the UI can render it distinctly from a normal user turn (`displayRole: "system"`).

### Token estimation

`CHARS_PER_TOKEN = 3` (`sdk/packages/core/src/../llms/tokens.ts:8` — package `@cline/llms`, file `llms/tokens.ts:8`). Notably conservative: real English averages closer to ~4 chars/token, so dividing by 3 systematically **over-estimates** token counts, biasing the compaction trigger to fire earlier rather than risk an actual provider overflow.

### Budget projection

`extensions/context/budget-projection/project.ts` computes which messages/blocks would need to be dropped or rewritten to hit a target token count, under one of three named policy intents (`resolveProjectionPolicy`, `project.ts:22-40`): `agentic_summary` / `basic_compaction_projection` (aggressive — protects only the latest typed user message and the live tail, drops thinking blocks and anything unsafe outside the tail) vs `normal_provider_request` (conservative — protects the live tail but doesn't drop thinking blocks). This shared projection function is reused by both compaction strategies and by normal request-building, so the "what's safe to drop" logic isn't duplicated.

---

## 7. Edit tools: confirmation format and file-context tracking

### `editor` tool confirmation — diff, not full-file echo

Implemented in `extensions/tools/executors/editor.ts`. For an existing-file replace (`replaceInFile`, `editor.ts:170-200`), the tool result is a **line-numbered unified-style diff snippet**, not the full new file content:

```ts
// editor.ts:198-199
const diff = createLineDiff(content, updated, maxDiffLines);
return `Edited ${filePath}\n${diff}`;
```

`createLineDiff` (`editor.ts:87-149`) trims the common prefix/suffix so only the actually-changed region is emitted (avoids re-showing unchanged lines around the edit), splits a shared line budget between removed/added lines when both together exceed the cap, and formats as:

```diff
-42: old line here
+42: new line here
```

wrapped in a ` ```diff ` fence. Default cap **`maxDiffLines = 200`** (`editor.ts:34`, `EditorExecutorOptions.maxDiffLines`); if the actual diff is larger, a summary line is appended instead of silently cutting output: `` `... diff truncated (${omittedRemoved} more removed, ${omittedAdded} more added lines) ...` `` (`editor.ts:141-144`). File **creation** returns a one-line confirmation, `` `File created successfully at: ${filePath}` `` (`editor.ts:158`), not an echo of the new file's content. **Insert** returns `` `Inserted content at line ${insertLineOneBased} in ${filePath}.` `` (`editor.ts:223`) — again no content echo.

Guardrails that keep the *input* side small too: `old_text`/`new_text` are capped at `INPUT_ARG_CHAR_LIMIT = 6_000` chars each (`schemas.ts:10,205,210`), enforced pre-execution by `getEditorSizeError` (`helpers.ts:20-33`) with actionable guidance — *"Split the edit into smaller tool calls so later tool calls are less likely to be truncated or time out."* — rather than letting an oversized edit attempt and fail mid-write.

`old_text` must match **exactly once** in the file; zero or multiple matches both throw (`editor.ts:183-191`) rather than guessing which occurrence was meant — this avoids a whole class of silently-wrong edits that would otherwise need a corrective follow-up round trip. Line-ending normalization (`detectLineEnding`/`normalizeLineEndings`, `editor.ts:68-85`) rewrites the model's LF-only edit text to match the file's actual CRLF/LF convention before diffing/writing, since the read path always strips `\r` — so the model naturally emits LF, and this reconciles it.

### `apply_patch` — its confirmation is the applied unified diff

`apply_patch` (used instead of `editor` for Codex/GPT models, see model-tool-routing below) parses and applies the canonical patch format via `apply-patch-parser.ts`/`apply-patch.ts`; its tool description already models diff-based editing directly in the input format (§5), and the tool never asks for a full-file echo either.

### File-context tracking to avoid re-reads

This is layer B3 from §6 (`message-builder.ts`): a per-conversation index tracks, for every path, which prior `read_files`/`read` tool-result block currently "owns" the latest full-content view (`latestFullContentOwnerByPathCache`, populated in `reindex()`, `message-builder.ts:278-333`) and which locator (path + line range) each historical read call covered (`readLocatorsByToolUseIdCache`, `latestReadToolUseByLocatorCache`). When a later read supersedes an earlier one — a full-file re-read, or a range that's now covered by a fresher read — the earlier tool-result's text is not deleted from history but **rewritten in place** to `"[outdated - see the latest file content]"` (`OUTDATED_FILE_CONTENT`, `message-builder.ts:48`, applied by `replaceOutdatedReadContent`, `message-builder.ts:912-970`) once the batching threshold (64 KB reclaimable, §6) is crossed. This means: the model is never told "don't re-read X" directly — instead, if it *does* re-read, the system automatically dedupes the stale copy out of future requests rather than paying for both the old and new copies of the same file content forever. Edits (`editor`) also update this bookkeeping implicitly, since an edited file's next read produces a new "current" locator.

### Model-specific edit-tool routing

`extensions/tools/model-tool-routing.ts:60-75` (`DEFAULT_MODEL_TOOL_ROUTING_RULES`):

```ts
{ name: "openai-native-use-apply-patch", mode: "act",
  providerIdIncludes: ["openai-native"], enableTools: ["apply_patch"], disableTools: ["editor"] },
{ name: "codex-and-gpt-use-apply-patch", mode: "act",
  modelIdIncludes: ["codex", "gpt"], enableTools: ["apply_patch"], disableTools: ["editor"] },
```

For OpenAI-native/Codex/GPT models, `editor` is swapped out for `apply_patch` automatically — these models are trained on the apply_patch grammar, so this reduces malformed-edit tool calls (and the retry/repair round trips those cause) rather than forcing every model onto one uniform edit format.

---

## 8. In-context-learning tricks: narrowing guidance, empty-result messaging, focus-chain/todo

### Narrowing / recovery guidance embedded in truncation and error text

Every truncation notice in this codebase pairs the fact ("N chars/lines elided") with an instruction for what to do next, and that instruction is tool-specific:

| Situation | Guidance text | Source |
|---|---|---|
| Search output over cap | "Narrow the pattern or scope to view the elided matches" | `search.ts:494` |
| Command output over cap | "Refine the command (grep, head, tail) to view the elided middle" | `output-limits.ts:35` |
| File too large to read | "Use a targeted command such as sed, grep, head, or tail to inspect specific sections." | `file-read.ts:256` |
| Legacy `@mention` content over 400KB | "Use search_files to find specific patterns, or execute_command with grep/head/tail for targeted reading." | `apps/vscode/src/shared/content-limits.ts:31` (legacy extract-text path, `apps/vscode/src/integrations/misc/extract-text.ts`) |
| Editor input over 6,000 chars | "Split the edit into smaller tool calls so later tool calls are less likely to be truncated or time out." | `helpers.ts:25,29` |
| Read window larger than cap | "Use start_line/end_line to read other sections." | `file-read.ts:187` |
| Unknown tool selected | Lists the actual available tool ids in the error: `` `Unknown tool "${id}". Available tools: ${catalog...join(", ")}` `` | `extensions/tools/runtime.ts:239-241` |

The consistent pattern: never truncate silently, and never truncate without telling the model *which tool/parameter* to use to get the missing part.

### Empty-result messaging

`search_codebase` fallback path returns a count-bearing negative result rather than an empty string: `` `No results found for pattern: ${query}\nSearched ${totalFilesSearched} files.` `` (`search.ts:452-453`) — the file count gives the model a concrete signal about whether it searched a meaningfully large scope (worth trying a different pattern) or a suspiciously small one (worth checking `cwd`/exclude filters).

### Guidance appended to results generally

Beyond truncation notices: the read-window footer (§3) always states the *total* line count even when only a slice was returned, so the model can decide up front whether paging further is worthwhile, instead of discovering the file is huge only after several blind `start_line`/`end_line` guesses.

### Focus-chain / todo device

A markdown-checklist convention (`ClineDefaultTool.TODO = "focus_chain"`, `apps/vscode/src/shared/tools.ts:25`) exists in the legacy VS Code layer: list items matching `- [ ]` / `- [x]` / `- [X]` are recognized as checklist entries (`isFocusChainItem`, `apps/vscode/src/shared/focus-chain-utils.ts:11-13`), backed by a settings toggle (`apps/vscode/src/shared/FocusChainSettings.ts`) and a file-open command (`apps/vscode/src/core/controller/file/openFocusChainFile.ts`). I could not find this wired into the current `sdk/packages/core` tool catalog (`extensions/tools/runtime.ts`'s `BASE_TOOL_CATALOG` has no `focus_chain`/todo entry) or into `definitions.ts` — it appears to be a **VS Code-extension-only, legacy-era feature** (persisted markdown task file + pattern matcher), not a first-class tool in the current SDK tool set. I'm flagging this rather than asserting its current prompt-injection behavior, since I could not locate the code path that actually re-injects the checklist into the live system prompt/context in the current architecture — only the settings plumbing and the pattern-matching utility remain clearly traceable.

### Parallel tool-call encouragement (reduces round trips, not per-call size)

Every tool description that logically supports batching says so explicitly and consistently across the whole toolset, e.g.: *"call this tool in the same response as other independent tool calls"* appears in `read_files` (`definitions.ts:257`), `search_codebase` (`definitions.ts:354`), `run_commands` (`definitions.ts:436`), `fetch_web_content` (`definitions.ts:529`). The base system prompt reinforces this as a general rule, not just a per-tool hint: *"You can call multiple tools in a single response. Before using tools, identify every independent read, search, command, or edit needed for the next step and emit all of those tool calls now... Do not split independent reads, searches, checks, or edits across separate turns."* (`sdk/packages/shared/src/prompt/system.ts:22-23`). This is a round-trip-reduction technique (fewer model turns = fewer repeated system-prompt/tool-schema/history payloads billed), distinct from the per-call output caps but working toward the same goal.

---

## Key token-efficiency techniques, ranked by impact

1. **Native provider tool-calling instead of an XML/prose tool protocol** (§5) — the entire per-tool "how to use this" burden is carried by the provider's structured tool-schema channel, not duplicated as prose in the system prompt. The base system prompt is ~2,000 chars with zero tool-usage examples (`sdk/packages/shared/src/prompt/system.ts`). This is the single biggest structural difference from the classic Cline design and dwarfs any individual truncation constant in total tokens saved across a whole session.

2. **Unconditional two-layer tool-result capping**: ~48,000-char executor-level caps (`output-limits.ts`) plus an unconditional, always-on 8,000-char re-cap at the message-builder layer applied to *every* tool result on *every* request build (`message-builder.ts:27,268-271`) — explicitly designed to also catch MCP/custom tools that bypass the built-in executors. This bounds the dominant per-turn cost (tool output) regardless of which tool produced it.

3. **Stale-read rewriting ("outdated file content")** (§6/§7) — once a file is re-read, the earlier copy collapses to a 40-character placeholder instead of being re-sent on every subsequent request for the rest of the run. For a long session that re-reads the same hot files repeatedly, this is a compounding, session-length-scaling saving, deliberately batched (64 KB threshold) to avoid invalidating provider prompt-prefix caching.

4. **Middle-truncation everywhere, never head-only or silent** (search, commands, file reads, tool results) — preserves the start (identifying context/headers) and the end (often where the actionable signal is, e.g. build/test failures) while eliding the costly middle, with an explicit, tool-specific "how to get the rest" instruction baked into the elision marker itself. This turns a lossy cap into an in-context-learning signal rather than a dead end.

5. **Compaction (auto-condense) triggered at 90% of budget, targeting 70%, with a 20,000-token protected recent tail** (§6) — keeps the model from ever hitting an actual provider context-window rejection in the common case, and falls back to a deterministic (non-LLM) summarizer specifically during provider-reported overflow recovery so the fix doesn't depend on a request that's already failing.

6. **Diff/one-line confirmations for edits, never full-file echo** (§7) — `editor` returns a capped unified-diff snippet (200 lines default) or a one-line "created"/"inserted" confirmation, never the whole new file content, keeping edit-tool results cheap regardless of file size.

7. **Command-echo dedup in tool results** (§4) — the executed command is repeated in the result's `query` field only up to 200 chars, with an explicit note that the full command is already present in the tool-call input, avoiding pointless duplication for large heredoc/script commands.

8. **Result-count caps at the source, not just at display time** — ripgrep's own `--max-count=1` per file and the `maxResults=100` cap enforced while parsing the JSON stream (§2) mean oversized result sets are never fully computed only to be truncated afterward; the work itself is bounded.

9. **Model-aware tool routing (apply_patch vs editor)** (§7) — swapping edit-tool format per model family (Codex/GPT → apply_patch) reduces malformed tool calls and their retry/repair token cost, rather than universally optimizing for one format.

10. **Parallel/batched tool-call encouragement across every tool description and the base system prompt** (§8) — reduces the number of model turns (and thus repeated context/history payload) needed to complete independent work, complementing but distinct from the per-call size caps above.
