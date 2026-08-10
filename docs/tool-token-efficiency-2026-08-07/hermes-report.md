# hermes-agent: Token Efficiency in Coding-Agent Tools

Repository studied (read-only): `/Users/seandearnaley/Documents/GitHub/hermes-agent`

All citations are `path:line` against the repo state at the time of this study. All quoted strings/constants are verbatim from source.

---

## 1. Enumerate the built-in agent tools

Tools self-register via `registry.register(name=..., toolset=..., schema=..., handler=..., ...)` calls scattered across `tools/*.py` (`tools/registry.py:521-603`). A one-time AST scan (`tools/registry.py:67-118`, `_module_registers_tools`) discovers which files call `registry.register()` at module top level and imports only those. As of this study there are **92** `registry.register(` call sites across `tools/*.py` resolving to ~85 distinct tool names (some files register multiple related tools, e.g. `browser_tool.py` registers 9 browser_* tools).

### Core "coding agent" tools (the token-efficiency-relevant set)

| Tool | Toolset | Purpose | Source |
|---|---|---|---|
| `read_file` | `file` | Read a text file with pagination + line numbers, replaces `cat/head/tail` | `tools/file_tools.py:2576` (schema at `:2419`) |
| `write_file` | `file` | Full-file overwrite, replaces `echo`/heredoc | `tools/file_tools.py:2577` (schema at `:2433`) |
| `patch` | `file` | Targeted find/replace or V4A multi-file patch, replaces `sed`/`awk` | `tools/file_tools.py:2578` (schema at `:2451`) |
| `search_files` | `file` | ripgrep-backed content/file-name search, replaces `grep/rg/find/ls` | `tools/file_tools.py:2579` (schema at `:2502`) |
| `terminal` | `terminal` | Execute shell commands (local/Docker/SSH/Modal/Daytona backends) | `tools/terminal_tool.py:3587` (schema at `:3528`) |
| `process` | `terminal` | Manage background terminal sessions (poll/wait/kill) | `tools/process_registry.py:2931` |
| `close_terminal` / `read_terminal` / `focus_pane` / `open_preview` / `read_preview` / `react_to_message` | `desktop_ui` | Desktop-app terminal/preview pane control | `tools/close_terminal_tool.py:56`, `tools/read_terminal_tool.py:79`, `tools/focus_pane_tool.py:58`, `tools/open_preview_tool.py:86`, `tools/read_preview_tool.py:84`, `tools/react_to_message_tool.py:155` |
| `execute_code` | `code_execution` | Sandboxed code execution (Python etc.) | `tools/code_execution_tool.py:2063` |
| `delegate_task` | `delegation` | Spawn a subagent for a bounded piece of work | `tools/delegate_tool.py:4325` |
| `todo` | `todo` | Track a task checklist | `tools/todo_tool.py:327` |
| `memory` | `memory` | Read/write persistent agent memory | `tools/memory_tool.py:1223` |
| `clarify` | `clarify` | Ask the user a clarifying question | `tools/clarify_tool.py:255` |
| `skill_view` / `skills_list` / `skill_manage` | `skills` | Progressive-disclosure skill system | `tools/skills_tool.py:2044`, `:1881`, `tools/skill_manager_tool.py:1763` |
| `session_search` | `session_search` | Search prior session transcripts | `tools/session_search_tool.py:1143` |
| `cronjob` | `cronjob` | Schedule recurring agent runs | `tools/cronjob_tools.py:1583` |
| `web_search` / `web_extract` | `web` | Web search / URL-to-text extraction | `tools/web_tools.py:1213`, `:1223` |
| `x_search` | `x_search` | X/Twitter search | `tools/x_search_tool.py:543` |
| `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_back`, `browser_get_images`, `browser_press`, `browser_console`, `browser_vision` | `browser` | Playwright-style browser automation | `tools/browser_tool.py:5017-5091` |
| `browser_cdp` / `browser_dialog` | `browser-cdp` | Chrome DevTools Protocol backend | `tools/browser_cdp_tool.py:670`, `tools/browser_dialog_tool.py:136` |
| `computer_use` | `computer_use` | OS-level mouse/keyboard control | `tools/computer_use_tool.py:20` |
| `vision_analyze` / `video_analyze` | `vision`/`video` | Image/video understanding | `tools/vision_tools.py:1710`, `:2074` |
| `image_generate` | `image_gen` | Image generation | `tools/image_generation_tool.py:1658` |
| `video_generate`, `xai_video_edit`, `xai_video_extend`, `bfl_flux3_*` (6 tools) | `video_gen` | Video generation providers | `tools/video_generation_tool.py:565`, `tools/xai_video_tools.py:189,200`, `tools/flux3_video_tool.py:1185-1240` |
| `text_to_speech` | `tts` | Speech synthesis | `tools/tts_tool.py:3952` |
| `project_list` / `project_create` / `project_switch` | `project` | Multi-project workspace switching | `tools/project_tools.py:134,145,170` |

### Integration/platform tools (not central to token-efficiency analysis, listed for completeness)

`kanban_*` (12 tools, `tools/kanban_tools.py:2144-2243`), `discord`/`discord_admin` (`tools/discord_tool.py:1100,1109`), `homeassistant` `ha_*` (4 tools, `tools/homeassistant_tool.py:480-507`), `feishu_doc_read` / `feishu_drive_*` (5 tools), `yb_*` Yuanbao messaging (5 tools, `tools/yuanbao_tools.py`), plus dynamically-registered MCP server tools (`tools/mcp_tool.py:6245,6396,6429`).

### Meta/bridge tools (progressive tool disclosure — see §6)

`tool_search`, `tool_describe`, `tool_call` — dynamically injected bridge tools defined in `tools/tool_search.py` (not through the normal `registry.register()` path; see §6).

---

## 2. Search/grep tool (`search_files`) and file-listing/glob deep dive

### Schema (verbatim)

`tools/file_tools.py:2502-2519`:

```
"description": "Search file contents or find files by name. Use this instead of grep/rg/find/ls in terminal. Ripgrep-backed, faster than shell equivalents.

Content search (target='content'): Regex search inside files. Output modes: full matches with line numbers, file paths only, or match counts.

File search (target='files'): Find files by glob pattern (e.g., '*.py', '*config*'). Also use this instead of ls — results sorted by modification time."
```

Parameters: `pattern` (required), `target` (`content`|`files`, default `content`), `path` (default `.`), `file_glob`, `limit` (**default 50**), `offset` (**default 0**), `output_mode` (`content`|`files_only`|`count`, default `content`), `context` (default 0).

### Backend: ripgrep, with `grep`/`find` fallback

`ShellFileOperations._search_content` (`tools/file_operations.py:2505-2541`) tries `rg` first, then POSIX `grep`; `_search_files` (`:2373-2457`) tries `rg --files` then `find`. Neither engine is required to exist — a missing-binary error is surfaced explicitly rather than silently degrading (`"Content search requires ripgrep (rg) or grep. Install ripgrep: ..."`, `:2519-2522`).

### Exact ripgrep invocation

`_search_with_rg` (`tools/file_operations.py:2543-2586`) builds:

```
rg --line-number --no-heading --with-filename [--multiline] [-C <context>] [--glob <file_glob>] [-l | -c] <pattern> <path> | head -n <limit+offset[+200 if context]>
```

wrapped in `set -o pipefail; ...` so `rg`'s real exit code survives the `head` truncation (`:2586`, comment explains why: without `pipefail` the pipeline reports `head`'s exit status 0, masking `rg`'s error code 2).

### Output format (representative example)

Content mode with ≥5 matches is **densified** into a path-grouped text block (`SearchResult._densify_matches`, `tools/file_operations.py:269-295`, threshold `_DENSIFY_MIN_MATCHES: ClassVar[int] = 5`, `:267`):

```json
{
  "total_count": 7,
  "matches_format": "path-grouped: each file path on its own line, followed by indented '<line>: <content>' rows for matches in that file",
  "matches_text": "tools/file_tools.py\n  2419: READ_FILE_SCHEMA = {\n  2433: WRITE_FILE_SCHEMA = {\ntools/file_operations.py\n  158: class ReadResult:"
}
```

This is the model-visible envelope emitted by `SearchResult.to_dict(densify=True)` (`tools/file_operations.py:297-326`) — it deliberately repeats the `{"path","line","content"}` JSON keys only when there are **fewer than 5 matches**, because below that the verbose array is cheaper than the path-grouping header (comment at `:264-267`). Below 5 matches it falls back to:

```json
{"total_count": 3, "matches": [{"path": "a.py", "line": 10, "content": "..."}]}
```

Files mode returns `{"files": [...], "total_count": N, "truncated": bool}`; count mode returns `{"counts": {"path": n, ...}, "total_count": sum}`.

### Per-line truncation

Each match's `content` field is hard-capped at **500 characters** at parse time: `content=m.group(4)[:500]` (`tools/file_operations.py:2659`, and identically for context lines at `:2671`).

### Context-lines policy

`context` param maps to ripgrep `-C <n>` (`:2558-2559`). Context lines (dash-separated `file-lineno-content` rg output) are parsed by `_parse_search_context_line` (`tools/file_operations.py:420-448`) only when `context > 0`, to avoid misparsing ordinary dashes in content as context markers.

### Sorting / dedup

- **File search** (`target=files`) is sorted by **modification time, most-recent first**, via `rg --files --sortr=modified` (`tools/file_operations.py:2476-2477`), falling back to unsorted `rg --files` on rg < 13 (`:2486-2494`). The `find` fallback path sorts with `sort -rn` on a `%T@ %p` (epoch mtime + path) printf format (`:2412-2413`).
- **Content search** ordering is whatever ripgrep emits (path-ordered, all hits per file consecutive) — this ordering is explicitly relied on by the densifier's path-change grouping logic (comment, `:283-285`).
- No explicit dedup of duplicate matches; ripgrep itself does not emit duplicates.

### Pagination / continuation

`normalize_search_pagination` (`tools/file_operations.py:756-761`) clamps `offset >= 0` and `limit >= 1` (via `_coerce_int`, `:729-734`). Both content and file-name searches over-fetch (`fetch_limit = limit + offset [+ 200 for context mode]`) then Python-side slice `[offset:offset+limit]` (`:2496, 2675`) so `total_count` reflects the true count before truncation. When `result_dict["truncated"]` is set, `search_tool` appends an explicit continuation hint to the JSON payload (`tools/file_tools.py:2396-2400`):

```
[Hint: Results truncated. Use offset=100 to see more, or narrow with a more specific pattern or file_glob.]
```

### Exact numeric limits

| Constant | Value | Source |
|---|---|---|
| `DEFAULT_SEARCH_OFFSET` | 0 | `tools/file_operations.py:725` |
| `DEFAULT_SEARCH_LIMIT` | 50 | `tools/file_operations.py:726` |
| Per-match content cap | 500 chars | `tools/file_operations.py:2659,2671` |
| Densify threshold | 5 matches | `tools/file_operations.py:267` |
| `search_tool` overall result cap | 100,000 chars (`max_result_size_chars`) | `tools/file_tools.py:2579` |
| rg subprocess timeout | 60s | `tools/file_operations.py:2587` |
| zero-match probe timeout | 30s × up to 3 probes | `tools/file_operations.py:2312-2359` |

### Loop-breaking guard

Identical consecutive searches (same pattern/target/path/file_glob/limit/offset) are tracked per task; the 3rd repeat attaches a `_warning`, the 4th is hard-blocked and returns no results at all (`tools/file_tools.py:2326-2340`):

```
"BLOCKED: You have run this exact search {count} times in a row. The results have NOT changed. You already have this information. STOP re-searching and proceed with your task."
```

---

## 3. `read_file` tool deep dive

### Schema (verbatim)

`tools/file_tools.py:2419-2431`:

```
"description": "Read a text file with line numbers and pagination. Use this instead of cat/head/tail in terminal. Output format: 'LINE_NUM|CONTENT'. Suggests similar filenames if not found. Use offset and limit for large files. Reads exceeding ~100K characters are truncated on a line boundary and return a next_offset; continue with offset to read the rest. Jupyter notebooks (.ipynb), Word documents (.docx), and Excel workbooks (.xlsx) are auto-extracted to readable text; PDF, legacy Office (.doc/.ppt/.xls), OpenDocument, RTF, and EPUB convert too when the optional anydoc converter is available (auto-installed on first use where installs are permitted). NOTE: Cannot read images or other binary files — use vision_analyze for images."
```

Params: `path` (required), `offset` (default 1, min 1), `limit` (default 2000, **max 2000**).

### Line numbering — exact format

`LINE_NUM|CONTENT`, produced by `ShellFileOperations._add_line_numbers` (`tools/file_operations.py:919-943`):

```python
numbered.append(f"{i}|{line}")
```

Notably the gutter is **not** zero/space-padded (e.g. `34|foo`, not `  34|foo`). The docstring (`:922-932`) records a measured A/B result behind this design choice:

> "The padding was pure token overhead: on dense source the padded gutter cost ~48% more tokens than the bare content and ~16% more than the compact form... An A/B (Sonnet 4.6, 2 passes) showed the compact gutter matches the padded gutter on line-reference / patch / value-lookup / structure tasks (4/4 both), while dropping line numbers entirely regressed line-referencing (the model hand-counted and was off-by-one, 3/4) — so we keep the numbers, just not the padding."

### Offset/limit defaults and clamping

`DEFAULT_READ_OFFSET = 1`, `DEFAULT_READ_LIMIT = 2000` (`tools/file_operations.py:723-724`). `normalize_read_pagination` (`:737-753`) clamps `offset = max(1, ...)` and `limit = max(1, min(limit, get_max_lines()))`, where `get_max_lines()` reads config-overridable `tool_output.max_lines` (default 2000, `tools/tool_output_limits.py:40,103-105`).

### Max lines / max bytes / max line length

| Constant | Value | Source |
|---|---|---|
| `MAX_LINES` (read_file pagination cap) | 2000 | `tools/file_operations.py:720`, mirrored in `tools/tool_output_limits.py:40` (`DEFAULT_MAX_LINES`) |
| `MAX_LINE_LENGTH` (per-line char cap before `"... [truncated]"`) | 2000 | `tools/file_operations.py:721`, `tools/tool_output_limits.py:41` |
| `MAX_FILE_SIZE` | 50 KB (`50 * 1024`) | `tools/file_operations.py:722` (checked but not enforced as a hard block — read still attempted, `:1174-1177`) |
| `_DEFAULT_MAX_READ_CHARS` (whole-response char budget) | 100,000 | `tools/file_tools.py:60` |
| `_LARGE_FILE_HINT_BYTES` | 512,000 (512 KB) | `tools/file_tools.py:133` |

Per-line truncation happens inside `_add_line_numbers`: any line longer than `get_max_line_length()` (2000 by default) is cut and suffixed `"... [truncated]"` (`tools/file_operations.py:940-941`).

### Dual truncation: line-count vs char-budget

`read_file_tool` (`tools/file_tools.py:1516-1823`) enforces a **second**, char-based ceiling on top of the line-count `limit`, because "few but very long lines" (logs, wide CSVs, minified data) can blow the char budget while staying under the line-count limit (comment, `:1709-1715`). `_truncate_to_char_budget` (`:87-128`) trims to the last complete line that fits within `max_chars` (100K by default) and reports `lines_kept`; the caller computes `next_offset = offset + lines_kept` and attaches:

```
"Output truncated at the 100,000-char read budget after {N} line(s) (showing lines {offset}-{shown_end} of {total_lines}). Use offset={next_offset} to continue."
```

If even the first line alone exceeds the budget, it is clamped mid-line on a code-point boundary and a note is added: `"the first line alone exceeded the budget and was clamped mid-line; its remainder is not retrievable via offset."` (`:1732-1737`).

### Binary/image handling

- Images are **never inlined**: `ShellFileOperations.read_file` detects images via `_is_image` and returns `ReadResult(is_image=True, is_binary=True, hint="Image file detected. Automatically redirected to vision_analyze tool...")` (`tools/file_operations.py:1179-1189`).
- Binary files (by extension, checked pre-I/O via `has_binary_extension`) are rejected outright: `"Cannot read binary file '{path}' ({ext}). Use vision_analyze for images, or terminal to inspect binary files."` (`tools/file_tools.py:1594-1599`).
- A content-sample binary sniff (`head -c 1000` + `_is_likely_binary`) provides a second layer at the shell-ops level: `"Binary file - cannot display as text..."` (`tools/file_operations.py:1196-1201`).
- Structured documents (`.ipynb`, `.docx`, `.xlsx`, and optionally `.pdf`/legacy Office/OpenDocument/RTF/EPUB via an "anydoc" converter) are auto-extracted to text **before** the binary-extension guard runs (`tools/file_tools.py:1536-1590`).

### Truncation messaging (large-file nudge)

Independent of the hard char-budget truncation, if the file is large (>512KB) and the caller requested a wide window (`limit > 200`) and the result came back truncated anyway, a soft nudge is appended (`tools/file_tools.py:1747-1754`):

```
"This file is large ({file_size:,} bytes). Consider reading only the section you need with offset and limit to keep context usage efficient."
```

### Read-dedup / loop-breaking

Identical `(resolved_path, offset, limit)` reads are cached by mtime (`tools/file_tools.py:1626-1677`). A repeat read of an unchanged region returns a stub instead of content:

```json
{"status": "unchanged", "message": "File unchanged since last read. The content from the earlier read_file result in this conversation is still current — refer to that instead of re-reading.", "path": "...", "dedup": true, "content_returned": false}
```

(message constant `_READ_DEDUP_STATUS_MESSAGE`, `tools/file_tools.py:1129-1133`). 2 consecutive dedup stubs escalate to a hard block (`:1656-1667`); independently, 4 consecutive **real** reads of the same region are hard-blocked (`:1805-1813`), with a warning injected at the 3rd (`:1814-1819`).

---

## 4. Bash/shell tool (`terminal`) output handling

### Byte cap

`MAX_OUTPUT_CHARS = get_max_bytes()` (config-overridable `tool_output.max_bytes`, default **50,000** chars — `DEFAULT_MAX_BYTES = 50_000`, `tools/tool_output_limits.py:39`), applied at `tools/terminal_tool.py:3154-3163`.

### Head vs tail retention — exact split

```python
if len(output) > MAX_OUTPUT_CHARS:
    head_chars = int(MAX_OUTPUT_CHARS * 0.4)  # 40% head (error messages often appear early)
    tail_chars = MAX_OUTPUT_CHARS - head_chars  # 60% tail (most recent/relevant output)
    omitted = len(output) - head_chars - tail_chars
    truncated_notice = (
        f"\n\n... [OUTPUT TRUNCATED - {omitted} chars omitted "
        f"out of {len(output)} total] ...\n\n"
    )
    output = output[:head_chars] + truncated_notice + output[-tail_chars:]
```
(`tools/terminal_tool.py:3155-3163`) — a fixed **40% head / 60% tail** split, rationale stated inline (errors surface early; recent output is usually most relevant).

### Spill-to-disk for the omitted middle

Separately from the in-message head/tail truncation, a lower-level "bounded collector" can write the **full, untruncated** output to a spill file when it overflows the capture window; the terminal tool surfaces that file back to the model (`tools/terminal_tool.py:3216-3239`):

```json
{
  "output_total_chars": 812345,
  "full_output_path": "/tmp/hermes-.../spill_xyz.txt",
  "truncation_note": "Output exceeded the capture window (head+tail shown). Full output (812,345 chars) saved to /tmp/.../spill_xyz.txt — search it with search_files or page it with read_file instead of re-running the command."
}
```
Before being reported, the spill file is re-redacted with the same secret-redaction pass used on the visible output (`:3222-3229`), so nothing unmasked lands on disk.

### Other output-handling layers, in order

1. ANSI escape stripping (`strip_ansi`, `:3168`) — "prevents it from copying escapes into file writes."
2. Secret redaction (`redact_terminal_output`, `:3179-3180`) — env-dump commands get the KEY=value credential pass; source dumps skip it to avoid false positives.
3. Exit-code interpretation (`_interpret_exit_code`, `:3184`) — maps benign non-zero codes (e.g. `grep`=1 "no matches", `diff`=1 "files differ") to an `exit_code_meaning` field instead of leaving the model to guess.
4. Failure-hint annotation (`tools/terminal_hints.annotate_failure`, `:3191-3197`) — maps known error *shapes* (command-not-found, `ModuleNotFoundError`, `gh` field drift, merge conflicts) to a `hint` field so the model fixes root cause on the next call instead of spending a turn re-diagnosing.
5. `cwd` echo (`:3210-3215`) — when a command changes the session's working directory, the result carries a `cwd` field; comment cites production mining showing "60% of terminal calls carry a defensive `cd X &&` prefix because the model can't see cwd state," which this removes the need for.

### Error surfacing

- Timeouts return `{"output": "", "exit_code": 124, "error": "Command timed out after {N} seconds"}` (`:3066-3070`).
- Backend connection failures (`EnvironmentConnectionError`) are, by default (`TERMINAL_DEGRADED_MODE=warn`), converted to a structured non-traceback result: `{"output": "", "exit_code": -1, "status": "degraded", "reason": ..., "retry_hint": ..., "error": "Terminal backend degraded: {reason}"}` (`:3308-3323`) — deliberately hides the Python traceback from the model by default; `TERMINAL_DEGRADED_MODE=fail` restores the old traceback-carrying error shape (`:3296-3306`).
- Uncaught exceptions fall through to a generic `{"output": "", "exit_code": -1, "error": ..., "traceback": ..., "status": "error"}` (`:3325-3335`).

### Overall registered cap

`max_result_size_chars=100_000` at registration (`tools/terminal_tool.py:3594`) — this is the *outer* per-tool-result persistence threshold (§6), distinct from the 50,000-char in-message truncation applied inside the tool itself.

---

## 5. Tool description prompts

Descriptions are plain Python string literals embedded directly in each tool's schema dict inside `tools/*.py` — there is no separate prompt-template store or external markdown file for tool descriptions (unlike system-prompt fragments, which do live in separate files elsewhere in the repo).

### Length and style samples

| Tool | Approx. length | Notable content |
|---|---|---|
| `terminal` (`TERMINAL_TOOL_DESCRIPTION`, `tools/terminal_tool.py:1070-1079`) | ~850 chars, 6 short paragraphs | Explicit "Do NOT use X (use Y)" tool-routing rules, background-vs-foreground usage rules, PTY guidance |
| `read_file` (`tools/file_tools.py:2421`) | ~700 chars, single paragraph | Output format spec, numeric truncation threshold, auto-extraction format list, explicit binary redirect instruction |
| `search_files` (`tools/file_tools.py:2504`) | ~550 chars | Explicit shell-tool replacement framing, mode-by-mode breakdown |
| `patch` (`tools/file_tools.py:2453-2461`) | ~550 chars, structured with a REQUIRED-PARAMETERS callout per mode | Names the fuzzy-matching strategy count ("9 strategies") as a reliability signal |
| `write_file` (`tools/file_tools.py:2435`) | ~550 chars | Explicitly tells the model **not** to re-read to verify: `"The result's verified:true means the on-disk content hash was confirmed — do NOT re-read the file to check the write landed."` |
| `browser_navigate` (`tools/browser_tool.py:1984`) | ~700 chars | Tool-routing guidance toward cheaper tools: `"For simple information retrieval, prefer web_search or web_extract (faster, cheaper)."`; and cost-avoidance: `"prefer curl via the terminal tool or web_extract; the browser stack is overkill and much slower"` |
| `browser_snapshot` (`tools/browser_tool.py:1998`) | ~600 chars | States its own truncation policy inline: `"Snapshots over 15000 chars are truncated or LLM-summarized; when that happens the complete snapshot is saved to a file..."` |

### Embedded examples/usage rules pattern

Every description in the core file/terminal tools follows the same shape: (1) a "use this instead of `<shell command>`" framing that steers the model away from cheaper-looking-but-actually-more-expensive terminal invocations, (2) inline numeric limits (`"~100K characters"`, `"default: 50"`, `"max: 2000"`), and (3) explicit anti-patterns (`"do NOT re-read the file"`, `"Reserve terminal for: builds, installs, git..."`). The `patch` schema additionally embeds a literal V4A patch-format template inside the `patch` parameter's own description (`tools/file_tools.py:2489-2491`):

```
"REQUIRED when mode='patch'. V4A format patch content. Format:\n*** Begin Patch\n*** Update File: path/to/file\n@@ context hint @@\n context line\n-removed line\n+added line\n*** End Patch"
```

### Storage

All schemas live as module-level dict literals (`READ_FILE_SCHEMA`, `WRITE_FILE_SCHEMA`, `PATCH_SCHEMA`, `SEARCH_FILES_SCHEMA`, `TERMINAL_SCHEMA`, etc.) directly beside the handler in the same tool file, then wired via `registry.register(schema=..., ...)`. `ToolRegistry.get_definitions()` (`tools/registry.py:676-723`) wraps each into the OpenAI-format `{"type": "function", "function": {...}}` envelope on every call, applying any `dynamic_schema_overrides` (used e.g. by `delegate_task` so its description can reflect the operator's currently-configured `max_concurrent_children`/`max_spawn_depth`, comment at `tools/registry.py:183-189`).

---

## 6. Global token-budget / output-budget machinery, context management, per-tool trimming layers

Hermes-agent documents this explicitly as a layered defense in `tools/tool_result_storage.py:1-23`:

> "1. **Per-tool output cap** (inside each tool)... 2. **Per-result persistence** (`maybe_persist_tool_result`)... 3. **Per-turn aggregate budget** (`enforce_turn_budget`)..."

### Layer 1 — per-tool output cap

Each tool truncates its own output before returning (§§2-4 above): `search_files` at 500 chars/match + 50-result default page, `read_file` at 100K chars / 2000 lines, `terminal` at 50K chars with 40/60 head/tail.

### Layer 2 — per-result persistence (`maybe_persist_tool_result`, `tools/tool_result_storage.py:144-200`)

If a tool's raw output exceeds its **registered threshold** (`registry.get_max_result_size`, capped by `BudgetConfig.default_result_size`), the full content is written into the sandbox at `/tmp/hermes-results/{tool_use_id}.txt` (or `$TMPDIR/hermes-results/...` on Termux) via `env.execute()` with content pushed over **stdin** rather than embedded in the shell command string — explicitly to dodge Linux's `MAX_ARG_STRLEN` (128 KB) argv ceiling (`:100-116`). The in-context replacement is a `<persisted-output>...</persisted-output>` block:

```
<persisted-output>
This tool result was too large (342,510 characters, 334.5 KB).
Full output saved to: /tmp/hermes-results/abc123.txt
Use the read_file tool with offset and limit to access specific sections of this output.

Preview (first 1500 chars):
...
</persisted-output>
```
(built by `_build_persisted_message`, `tools/tool_result_storage.py:119-141`). `read_file` is **pinned to never be persisted itself** (`PINNED_THRESHOLDS = {"read_file": float("inf")}`, `tools/budget_config.py:11-13`) — comment: "prevents infinite persist->read->persist loops."

### Layer 3 — per-turn aggregate budget (`enforce_turn_budget`, `tools/tool_result_storage.py:203-254`)

After all tool results in one assistant turn are collected, if their **combined** size exceeds `turn_budget` (default 200,000 chars, `DEFAULT_TURN_BUDGET_CHARS`, `tools/budget_config.py:18`), the largest non-persisted results are force-persisted (threshold override `0`) one at a time, largest first, until under budget — catching the case where many *individually small* results sum to an overflow.

### Context-window-scaled budgets

`budget_for_context_window(context_length)` (`tools/budget_config.py:84-114`) scales all three thresholds to the active model's window rather than using fixed defaults everywhere: `per_result = 15%` of the window (in chars, at 4 chars/token), `per_turn = 30%`, clamped between a floor (`_MIN_RESULT_SIZE_CHARS=8,000`, `_MIN_TURN_BUDGET_CHARS=16,000`) and the historical default ceiling (100K/200K) — "so large models are unchanged [and] tiny models stay usable" (`:105-108`). Comment cites the motivating bug: "on a 65K-token model a single tool result persisted at the 100K-char threshold... can by itself approach or exceed the whole window" (`:89-91`, referencing issue #23767).

### Conversation compaction (`agent/context_compressor.py`, `agent/context_engine.py`)

`ContextEngine` (`agent/context_engine.py`) is a pluggable ABC (config key `context.engine`, default `"compressor"`); the default `ContextCompressor` (`agent/context_compressor.py:1356`+) triggers lossy summarization once token usage crosses `threshold_tokens` — a percentage of the model's context window (`threshold_percent`), resolvable per-model via substring match (`resolve_model_threshold`, `:1330-1353`, "longest matching key wins"). Key derived budgets:
- `tail_token_budget = threshold_tokens * summary_target_ratio` (`:1607-1610`), with `summary_target_ratio` clamped to `[0.10, 0.80]` (`:2372`).
- `max_summary_tokens = min(context_length * 0.05, _SUMMARY_TOKENS_CEILING)` where `_SUMMARY_TOKENS_CEILING = 10_000` (`:1617-1622`, `:415`).

Before summarizing, a **pre-compression pruning pass** replaces large tool call/result pairs with 1-line, tool-aware summaries via `_summarize_tool_result` (`agent/context_compressor.py:1167-1327`), e.g.:

```
[terminal] ran `npm test` -> exit 0, 47 lines output
[read_file] read config.py from line 1 (1,200 chars)
[search_files] content search for 'compress' in agent/ -> 12 matches
[skill_view] name=foo (8,432 chars) <ghost-skill marker>
```

This function is wrapped so a malformed historical tool-arg (bad JSON, wrong type) can never crash compression — `_summarize_tool_result` catches all exceptions from `_summarize_tool_result_unguarded` and falls back to a generic `f"[{tool_name}] ({len:,} chars result)"` (`:1187-1192`). After compaction, `reset_file_dedup` (`tools/file_tools.py:1828+`) is called to clear the read-dedup cache, because the original file content the dedup guard was tracking has now been summarized away and a re-read must return real content, not a stub (docstring, `:1829-1834`).

### Progressive tool disclosure (`tools/tool_search.py`) — schema-token budget, distinct from output-token budget

Separate from output truncation, hermes-agent bounds the **input** side: the token cost of the tool-definitions array itself. When MCP/plugin tools are present, they are hidden behind 3 bridge tools (`tool_search`, `tool_describe`, `tool_call`; `TOOL_SEARCH_NAME`/`TOOL_DESCRIBE_NAME`/`TOOL_CALL_NAME`, `tools/tool_search.py:55-59`) rather than being listed eagerly — "Core Hermes tools never defer... the moment ANY deferrable (MCP/plugin) tools are present, they hide behind the bridge" (`:10-13`). Docstring defines 3 disclosure tiers (`:14-24`):
- Tier 0: no deferrable tools — pure passthrough.
- Tier 1: catalog listing fits budget (`min(threshold_pct% of context, listing_max_tokens)`) — full name+description manifest, degrading to names-only if over budget.
- Tier 2: even names-only is over budget (example cited: Cloudflare's ~3,300-tool surface, "~32K tokens" for names alone) — bare bridge plus one line per MCP server (name + tool count).

Defaults (`tools/tool_search.py:97-154`): `threshold_pct = 5.0` (% of context window), `listing_max_tokens = 4000`, `search_default_limit = 5`, `max_search_limit = 20` (clamped `[1,50]`), token estimation via `CHARS_PER_TOKEN = 4.0` (`:67`). The catalog is explicitly rebuilt from the live registry on every assembly rather than cached/session-keyed, citing a regression class from a sibling project ("OpenClaw's cron regression... a session-keyed catalog that drifts out of sync with the live tool registry produces silent tool dropouts," `:26-29`).

---

## 7. Edit tools: how edits are confirmed back to the model

Neither edit tool echoes the full file back. Both use compact, purpose-built confirmation shapes:

### `patch` → unified diff, not full-file echo

`ShellFileOperations.patch_replace` (`tools/file_operations.py:1657-1802`) generates the confirmation via Python's stdlib `difflib.unified_diff` (`_unified_diff`, `:1128-1137`):

```python
diff = difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{filename}", tofile=f"b/{filename}")
```

`PatchResult.to_dict()` (`tools/file_operations.py:203-240`) returns only non-empty fields — typically `{"success": true, "diff": "<unified diff text>", "files_modified": [...], "lint": {...}}`. There is **no full-content field** in the shape at all.

Special case — **success-shaped no-op**: if the requested edit is detected as already applied (`is_already_applied`), the tool returns `success: true, no_change: true` with **no diff at all**, plus a `note` explaining why (`tools/file_operations.py:1704-1721`):

```
"File already contains the target text — the edit appears to be already applied to {path}. No write performed; do not re-send this patch."
```

`patch_tool` also runs post-write verification by re-reading and byte-comparing the file (line-ending-normalized) before returning success (`tools/file_operations.py:1750-1780`) — the model is told the outcome (success/error), never handed the file bytes back.

### `write_file` → hash-verification flag, not content echo

`WriteResult.to_dict()` (`tools/file_operations.py:178-199`) returns `{"bytes_written": N, "dirs_created": bool, "verified": true|false|None, "lint": {...}, "lsp_diagnostics": "...", ...}` — the confirmation is a **byte count + a sha256 on-disk verification boolean**, never the written text. The schema description makes this an explicit anti-pattern warning to the model (`tools/file_tools.py:2435`): `"The result's verified:true means the on-disk content hash was confirmed — do NOT re-read the file to check the write landed."`

### Auto-lint delta, not raw linter output

Both `write_file` and `patch` run syntax/lint checks and use a **delta** filter (`_check_lint_delta`, `tools/file_operations.py:1922`+) so only *newly introduced* errors are surfaced — pre-existing lint failures in the file are filtered out (schema text, `tools/file_tools.py:2435`, `:2456`): "only NEW errors introduced by this write are surfaced (pre-existing errors are filtered out)."

### Escalating failure guidance (in-context learning, tied to edits)

A per-path consecutive-failure counter (`_record_patch_failure`, `tools/file_tools.py:1090-1106`) drives an escalating hint when `old_string` repeatedly fails to match: after 3 consecutive failures on the same path, the generic "not found" hint is replaced with (`tools/file_tools.py:2276-2291`):

```
"This is failure #{N} patching '{path}'. Stop retrying with variations of the same old_string. Either: (1) re-read the file fresh to verify current content, (2) use a longer / more unique old_string with surrounding context lines, or (3) use write_file to replace the entire file if the targeted region is hard to anchor."
```

---

## 8. In-context-learning tricks

### Narrowing-query guidance embedded directly in results

- Search truncation hint (`tools/file_tools.py:2398-2400`): `"[Hint: Results truncated. Use offset={N} to see more, or narrow with a more specific pattern or file_glob.]"`.
- Large-file read hint (`tools/file_tools.py:1750-1754`): `"This file is large ({file_size:,} bytes). Consider reading only the section you need with offset and limit to keep context usage efficient."`
- read_file continuation hint after char-budget truncation (`:1727-1731`): `"Output truncated at the 100,000-char read budget after {N} line(s)... Use offset={next_offset} to continue."`

### Empty-result messaging (zero-match steering)

`ShellFileOperations._zero_match_probe` (`tools/file_operations.py:2299-2371`) fires only on a genuine zero-match content search, and is explicitly motivated by a measured production stat in its own docstring: **"13.9% of production content searches return zero matches and give the model nothing to steer by."** It runs up to 3 bounded, count-only `rg` probes (case-insensitive, hidden/gitignored, literal-string) and returns one of:

```
"0 exact matches, but {N} case-insensitive match(es) in {M} file(s) — the pattern's casing may be wrong."
"0 matches in visible files, but {N} match(es) in {M} hidden or gitignored file(s) — these are excluded by default. Search the hidden path explicitly to include them."
"0 regex matches, but {N} literal match(es) — the pattern contains regex metacharacters that likely need escaping (or pass a simpler substring)."
```

### Path-not-found recovery, not a bare error

`ShellFileOperations.search` (`tools/file_operations.py:2202-2242`) and `read_file`'s `_suggest_similar_files` both convert a missing-path failure into a **best-effort directory listing** of similarly-named entries (substring/prefix match against the parent directory), appended as `"Similar paths: ..."` / `"similar_files"` rather than leaving the model to guess a corrected path from nothing.

### Multi-path recovery (defensive parsing of malformed model output)

`_try_multi_path_search` (`tools/file_operations.py:2250-2297`) detects when a model has stuffed several paths into one `path` argument ("dir1 dir2 dir3" or comma-separated) — explicitly called out as a **measured production pattern**: "models frequently pass several paths in one string" — and searches each existing one, merging results and reporting which were skipped, instead of failing the whole call.

### Loop-breaking via escalating warnings then hard blocks

A consistent 3-tier pattern across `read_file`, `search_files`, and `patch`: warn at N repeats, hard-block at N+1, with an explicit instruction to stop and use context already provided rather than re-issuing the call (`tools/file_tools.py:1656-1667` dedup stubs; `:1805-1819` real reads; `:2333-2340` searches; `:2276-2291` patch failures). All four share the same voice: *"You already have this information... STOP... proceed with your task."*

### Tool-routing steering (push the model toward cheaper tools)

- `browser_navigate` description (`tools/browser_tool.py:1984`): `"For simple information retrieval, prefer web_search or web_extract (faster, cheaper)... prefer curl via the terminal tool or web_extract; the browser stack is overkill and much slower for these."`
- `terminal` description (`tools/terminal_tool.py:1072`): `"Do NOT use cat/head/tail (use read_file), grep/rg/find/ls (use search_files), sed/awk (use patch), or echo/heredoc file creation (use write_file)."` This actively steers the model away from unstructured, unbounded terminal output toward the tools with the layered truncation/dedup machinery documented in §§2-4.

### Anti-verification-loop instruction

`write_file`'s description explicitly forbids a common wasteful pattern — reading a file back to confirm a write succeeded — by exposing a trust signal instead: `"verified:true means the on-disk content hash was confirmed — do NOT re-read the file to check the write landed."` (`tools/file_tools.py:2435`).

### Internal-content write guard (defense against a specific token-wasting bug class)

`write_file_tool` rejects attempts to write `read_file`'s own `LINE_NUM|CONTENT` display format back to disk as if it were real file content (`tools/file_tools.py:2030-2035`): `"Refusing to write internal read_file display text as file content. Strip read_file line-number prefixes or reconstruct the intended file contents before writing."` — this both saves a wasted write/lint/verify round trip and prevents corrupting the file with line-number gutters.

---

## Key token-efficiency techniques, ranked by impact

1. **Three-layer output-budget system** (`tools/tool_result_storage.py`, `tools/budget_config.py`) — per-tool cap → per-result sandbox persistence with in-context preview → per-turn aggregate spill of the largest remaining results. This is the single mechanism that bounds worst-case context blowup across *every* tool uniformly, and it scales proportionally to the model's actual context window (15%/30% fractions, floored/ceilinged) rather than using one-size-fits-all constants.

2. **Progressive tool disclosure for schemas** (`tools/tool_search.py`) — bounds the *input*-side token cost of the tools array itself (not just outputs) via a 3-tier degrading catalog (full listing → names-only → bare bridge), essential once MCP servers can add thousands of tool definitions (cited example: ~32K tokens for names alone on a 3,300-tool surface).

3. **Dual-axis read/search truncation with explicit continuation cursors** — every truncation point (`read_file`'s char-budget + line-limit, `search_files`' offset/limit) returns a `next_offset`/`offset=N` hint in the same response rather than silently dropping data or forcing the model to guess a smaller window, converting what would otherwise be a wasted round-trip into a single deterministic follow-up call.

4. **Read/search-loop hard-blocking with escalating warnings** — repeated identical `read_file`/`search_files`/`patch` calls are throttled (warn at 3, block at 4) with an instruction to use information already in context. This directly targets a known LLM failure mode (retry loops) that would otherwise consume tool-call budget and context linearly with no new information gained.

5. **Diff/hash confirmation instead of content echo for edits** — `patch` returns a unified diff, `write_file` returns a verified sha256 boolean; neither ever echoes the file body back, and the schema text actively tells the model not to re-read to double-check ("do NOT re-read the file to check the write landed").

6. **Compact line-number gutter, empirically justified** — dropping fixed-width zero-padding from `LINE_NUM|CONTENT` (`34|foo` not `  34|foo`) measured at ~16-48% fewer tokens on dense source than a padded gutter, while an A/B test showed keeping bare line numbers (vs. removing them) avoided model off-by-one errors — a rare case of a token-efficiency decision backed by a documented empirical trade-off rather than intuition.

7. **Search result densification** — content matches ≥5 collapse into a path-grouped `matches_text` block (path printed once, indented `line: content` rows) instead of repeating `{"path","line","content"}` JSON keys per match, with a self-describing `matches_format` field so the model never has to guess the shape.

8. **Zero-match and multi-path recovery probes** — cheap, bounded (≤3 subprocess calls) diagnostic probes convert a dead-end "0 results" turn into an actionable hint (wrong case / hidden file / needs escaping), backed by a measured 13.9%-of-searches-return-zero-matches production statistic; similarly, malformed multi-path arguments are recovered rather than failed outright.

9. **Tool-routing steering in descriptions** — explicit "use X instead of shell command Y" and "prefer cheaper tool Z" language in `terminal`/`browser_navigate`/`read_file` descriptions pushes the model toward the tools that actually have the truncation/dedup/budget machinery, rather than falling back to unbounded raw shell output.

10. **Context-window-proportional compaction** (`agent/context_compressor.py`) — conversation-level compaction with a pre-compression pruning pass that replaces large tool call/result pairs with tool-aware 1-line summaries (e.g. `[terminal] ran 'npm test' -> exit 0, 47 lines output`) before falling back to full LLM summarization, and a model-substring-keyed threshold override table so different models compress at different fill percentages.
