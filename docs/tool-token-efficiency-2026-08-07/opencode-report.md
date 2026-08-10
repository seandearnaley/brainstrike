# Token-efficiency design of opencode’s agent tools

Repository snapshot: branch `dev`, commit `284214c78d32a09fd9c729bdefc07be50f74eb40` dated 2026-08-07.

## Scope and architecture

This repository currently contains two tool stacks:

1. **SessionV1 / `packages/opencode` stack.** This is the stack used by the established prompt loop: it calls `SessionTools.resolve(...)`, which resolves tools from `packages/opencode/src/tool`. See [prompt.ts:1221](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/prompt.ts:1221).

2. **SessionV2 / `packages/core` stack.** This newer Location-scoped stack is also wired into the repository. `BuiltInTools.node` is part of Location services, and the V2 runner materializes its tool definitions. See [location-services.ts:66](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/location-services.ts:66) and [runner/llm.ts:203](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/session/runner/llm.ts:203). Its own source explicitly lists several remaining parity gaps. See [builtins.ts:18](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/builtins.ts:18).

The detailed behavior below begins with SessionV1 because it has the richer, mature coding-agent UX, then identifies relevant V2 differences.

---

## 1. Built-in agent tools

### SessionV1 tool inventory

The normal built-in ordering is declared at [registry.ts:224](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/registry.ts:224).

| Tool name | One-line purpose | Source |
|---|---|---|
| `invalid` | Internal fallback that reports malformed tool arguments; description says `Do not use`. | [invalid.ts:9](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/invalid.ts:9) |
| `question` | Ask the user structured questions and return selected labels. | [question.ts:14](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/question.ts:14) |
| `bash` / platform shell | Execute terminal commands with timeout, permission scanning, streamed progress, and tail-oriented output bounding. | [shell.ts:338](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:338) |
| `read` | Read text files, directories, images, and PDFs, with numbered text pagination. | [read.ts:64](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:64) |
| `glob` | Find files by glob pattern. | [glob.ts:17](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/glob.ts:17) |
| `grep` | Search file contents by regular expression and return matching lines. | [grep.ts:20](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.ts:20) |
| `edit` | Replace an exact or corrected string in one file. | [edit.ts:58](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/edit.ts:58) |
| `write` | Create or overwrite a complete file. | [write.ts:27](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/write.ts:27) |
| `task` | Delegate a complex task to a specialized subagent. | [task.ts:81](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/task.ts:81) |
| `webfetch` | Fetch one URL and return text, Markdown, HTML, or an image attachment. | [webfetch.ts:24](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/webfetch.ts:24) |
| `todowrite` | Persist and return the current structured task list. | [todo.ts:14](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/todo.ts:14) |
| `websearch` | Search the current web through Exa or Parallel Search. | [websearch.ts:99](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/websearch.ts:99) |
| `skill` | Load a named skill plus a sampled list of its resources. | [skill.ts:12](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/skill.ts:12) |
| `apply_patch` | Apply a structured multi-file add/update/delete/move patch. | [apply_patch.ts:22](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/apply_patch.ts:22) |
| `execute` | Experimental confined orchestration script over connected MCP tools. | [code-mode.ts:188](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/code-mode.ts:188) |
| `lsp` | Experimental LSP definitions, references, symbols, hover, implementations, and call hierarchy. | [lsp.ts:37](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/lsp.ts:37) |
| `plan_exit` | Experimental CLI-only transition from plan agent to build agent after user confirmation. | [plan.ts:15](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/plan.ts:15) |

Availability is deliberately filtered:

- `question` is enabled for app, CLI, and desktop clients, or by an explicit flag. [registry.ts:201](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/registry.ts:201)
- GPT models other than GPT-4/OSS receive `apply_patch`; other models receive `edit` and `write`. [registry.ts:286](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/registry.ts:286)
- `execute`, `lsp`, and `plan_exit` are experimental; `plan_exit` is CLI-only. [registry.ts:241](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/registry.ts:241)
- `websearch` is provider/feature gated. [registry.ts:287](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/registry.ts:287)

When an MCP server exposes resources, three additional host-defined tools appear:

| Tool | Purpose | Source |
|---|---|---|
| `list_mcp_resources` | List MCP resources, optionally for one server. | [session/tools.ts:140](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/tools.ts:140) |
| `list_mcp_resource_templates` | List parameterized MCP resource templates. | [session/tools.ts:222](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/tools.ts:222) |
| `read_mcp_resource` | Read an exact server/URI resource. | [session/tools.ts:305](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/tools.ts:305) |

Arbitrary MCP and plugin tools are dynamic extensions, not built-ins.

### SessionV2/Core inventory

The newer Core stack currently ships:

`apply_patch`, `bash`, `edit`, `glob`, `grep`, `question`, `read`, `skill`, `todowrite`, `webfetch`, `websearch`, and `write`. The complete static composition is at [builtins.ts:31](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/builtins.ts:31).

Its TODO explicitly says `task`, LSP, repository helpers, `plan_exit`, and code mode have not yet been ported. [builtins.ts:26](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/builtins.ts:26)

---

## 2. Grep/search and glob/file listing

## SessionV1 `grep`

### Exact model-facing text format

The formatter starts with:

```text
Found <N> matches
```

or, at the cap:

```text
Found <N> matches (more matches available)
```

It groups matches by absolute path, inserts a blank line between files, and formats each row as:

```text
  Line <line-number>: <matching-line>
```

Representative output:

```text
Found 3 matches

/Users/example/project/src/a.ts:
  Line 12: export const alpha = 1
  Line 38: export function beta() {

/Users/example/project/src/b.ts:
  Line 7: export type Result = string
```

The implementation is exact at [grep.ts:85](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.ts:85). No-result output is exactly:

```text
No files found
```

defined at [grep.ts:30](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.ts:30).

### Numeric limits

- Hard request limit: **100 matching lines**. [grep.ts:63](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.ts:63)
- A result length of exactly 100 is considered truncated. [grep.ts:80](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.ts:80)
- Each returned matching line is capped at **2,000 characters**, followed by `...`. [ripgrep.ts:260](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:260)
- Each raw ripgrep JSON record may be at most **64 KiB**. [ripgrep.ts:18](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:18), [ripgrep.ts:232](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:232)
- Ripgrep stderr capture is capped at **8 KiB**. [ripgrep.ts:18](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:18), [ripgrep.ts:112](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:112)
- At most **100 submatches** are retained inside a matched line’s structured record, although the SessionV1 formatter does not print submatch details. [ripgrep.ts:20](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:20), [ripgrep.ts:243](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:243)

The ripgrep adapter reads `limit + 1`, then returns the first `limit` rows. [ripgrep.ts:117](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:117) However, the adapter exposes only the resulting array to the legacy leaf, not its internal `truncated` flag. Therefore the leaf conservatively treats every 100-row response as “more matches available,” including the exact-100/no-more case.

### Context lines

There is **no before/after context option**. The command uses `rg --json` without `-A`, `-B`, or `-C`; it returns only matched lines. [ripgrep.ts:218](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:218)

### Sorting and ranking

There is:

- no relevance ranking;
- no post-sort;
- no `--sort` ripgrep flag;
- no mtime ranking.

Rows remain in ripgrep traversal/output order. The formatter merely groups consecutive rows that share a path. [grep.ts:89](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.ts:89)

### Deduplication

There is no explicit deduplication. Ripgrep’s JSON `match` record represents a matching line and may contain multiple submatches on that line; opencode emits one row per ripgrep match record. [ripgrep.ts:22](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:22)

### Pagination and continuation

There is no cursor, page, offset, or continuation token. When capped, the appended guidance is exactly:

```text
(Results truncated. Consider using a more specific path or pattern.)
```

[grep.ts:99](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.ts:99)

The intended continuation mechanism is a narrower `path`, regex, or `include` glob—not paging.

## SessionV1 `glob`

### Exact model-facing format

Every result is an absolute path on its own line:

```text
/Users/example/project/src/a.ts
/Users/example/project/src/components/button.ts
/Users/example/project/test/a.test.ts
```

This is produced by resolving each ripgrep-relative path against the requested directory. [glob.ts:53](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/glob.ts:53)

No result is exactly:

```text
No files found
```

[glob.ts:54](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/glob.ts:54)

### Limits and continuation

- Hard cap: **100 paths**. [glob.ts:49](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/glob.ts:49)
- Exactly 100 results are considered truncated. [glob.ts:51](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/glob.ts:51)
- Appended message:

```text
(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)
```

[glob.ts:57](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/glob.ts:57)

There is no offset or cursor. Narrowing the path or pattern is the sole continuation policy.

### Sorting, ranking, and deduplication

Like grep, glob uses `rg --files` with a glob and no sort flag, then preserves output order. [ripgrep.ts:154](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:154) There is no ranking or explicit deduplication.

`.git` is always excluded through:

```text
--glob=!**/.git/**
```

for both glob and grep. [ripgrep.ts:160](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:160), [ripgrep.ts:221](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/ripgrep.ts:221)

## Directory listing through `read`

Reading a directory is a separate file-listing path. It:

- sorts names lexicographically;
- appends `/` to directories and symlinks that resolve to directories;
- paginates by `offset` and `limit`.

Sorting and suffix behavior are at [read.ts:101](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:101).

Its exact envelope is:

```text
<path>/absolute/directory</path>
<type>directory</type>
<entries>
a/
b.ts
c.txt

(3 entries)
</entries>
```

If truncated:

```text
(Showing 2000 of 4500 entries. Use 'offset' parameter to read beyond entry 2001)
```

The envelope and message are at [read.ts:264](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:264).

Unlike `glob`, directory `read` has pagination. The default limit is 2,000, but the SessionV1 schema does not impose a hard maximum on a caller-supplied limit. Directory output also does not have `read`’s 50 KiB text-file cap. [read.ts:28](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:28), [read.ts:264](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:264)

## SessionV2 search differences

The V2 grep and glob schemas expose a model-controlled optional `limit`; absent a value, they pass `Number.MAX_SAFE_INTEGER` to ripgrep. [core grep.ts:95](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/grep.ts:95), [core glob.ts:75](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/glob.ts:75)

Their text formats remain concise:

- V2 grep uses `Found N matches`, path headings, and `  Line N: text`. [core grep.ts:37](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/grep.ts:37)
- V2 glob emits one path per line. [core glob.ts:31](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/glob.ts:31)

They do not append leaf-specific truncation advice; the V2 generic output store supplies the final safety bound.

---

## 3. File-read behavior

## Line numbering and exact format

SessionV1 text-file output begins:

```text
<path>/absolute/path/file.ts</path>
<type>file</type>
<content>
1: first line
2: second line
3: third line

(End of file - total 3 lines)
</content>
```

Every line uses the exact prefix `<line-number>: `. [read.ts:338](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:338)

The description also teaches this format with a miniature example. [read.txt:10](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.txt:10)

## Offset and limit

- Offset is 1-based.
- Default offset: **1**.
- Default limit: **2,000 lines**.
- Both schema values are non-negative integers. [read.ts:28](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:28)
- Runtime uses `params.offset || 1`, so an offset of `0` behaves as `1`. [read.ts:331](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:331)
- SessionV1 does not clamp a caller-supplied limit to 2,000. The effective hard bound for text is normally the byte cap.

## Byte and per-line caps

- Text returned per call: **50 KiB** (`50 * 1024` bytes). [read.ts:13](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:13)
- Individual line: **2,000 characters**, then:

```text
... (line truncated to 2000 chars)
```

[read.ts:14](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:14), [read.ts:162](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:162)
- Binary/media sniff sample: **4,096 bytes**. [read.ts:18](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:18)

The reader streams the file and stops upstream as soon as its byte budget is exhausted; it does not read the rest merely to calculate a total. [read.ts:137](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:137)

## Truncation and continuation messages

Byte cap:

```text
(Output capped at 50 KB. Showing lines <start>-<last>. Use offset=<next> to continue.)
```

Line limit:

```text
(Showing lines <start>-<last> of <observed-count>. Use offset=<next> to continue.)
```

Complete file:

```text
(End of file - total <count> lines)
```

[read.ts:341](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:341)

An out-of-range offset fails with:

```text
Offset <offset> is out of range for this file (<count> lines)
```

[read.ts:331](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:331)

## Missing-path hinting

On a missing path, opencode scans the parent directory for names where either lowercase basename contains the other. It returns at most **three** suggestions:

```text
File not found: /path/foo.ts

Did you mean one of these?
/path/Foo.ts
/path/foo.test.ts
```

[read.ts:76](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:76)

This is substring filtering, not edit-distance ranking.

## Images, PDFs, and other binaries

Supported image MIME types are JPEG, PNG, GIF, and WebP. [read.ts:19](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:19)

For a recognized image or PDF, SessionV1:

- reads the entire file;
- returns `Image read successfully` or `PDF read successfully`;
- attaches a base64 data URL;
- does not apply the 50 KiB text limit.

[read.ts:300](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:300)

SessionV1 has no explicit image/PDF ingestion-byte limit in this tool.

Other binary files are rejected. Detection combines:

- a fixed extension denylist including archives, executables, Office formats, object files, Wasm, and bytecode;
- immediate rejection on a NUL byte;
- rejection when more than 30% of sampled bytes are non-printable control bytes.

[read.ts:182](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:182)

The exact error is:

```text
Cannot read binary file: <path>
```

[read.ts:327](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:327)

## SessionV2 read differences

V2 makes several bounds stricter:

- Hard maximum **2,000 lines** in the input schema.
- **50 KiB** text-page cap.
- **2,000 characters** per line.
- **20 MiB** maximum image ingestion.

[read-filesystem.ts:11](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/read-filesystem.ts:11), [read-filesystem.ts:72](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/read-filesystem.ts:72)

V2 supports the same four image types but rejects PDF and listed binary extensions. [read-filesystem.ts:136](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/read-filesystem.ts:136), [read-filesystem.ts:212](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/read-filesystem.ts:212)

V2 directory pages are sorted with directories first, then lexical path order, and expose an exact next offset. [read-filesystem.ts:324](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/read-filesystem.ts:324)

---

## 4. Bash/shell output handling

## SessionV1 shell

### Combined output and stderr

The tool consumes `handle.all`, so stdout and stderr are merged in process emission order. [shell.ts:481](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:481)

Tests explicitly verify both stdout and stderr appear in the output. [shell.test.ts:1081](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/test/tool/shell.test.ts:1081)

### Model-output limits

Shell uses the configured global limits:

- default **2,000 lines**;
- default **50 KiB**.

[shell.ts:438](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:438), [truncate.ts:14](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/truncate.ts:14)

It retains the **tail**, not the head. The tail walker moves backward until either line or byte capacity is exhausted. If one line alone exceeds the byte limit, it preserves the UTF-8-safe suffix of that line. [shell.ts:225](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:225)

This is a material token-efficiency decision: terminal failures and summaries commonly appear at the end.

### Full-output retention

Once accumulated output exceeds the byte limit, the tool creates a managed output file, streams all subsequent chunks into it, and clears the in-memory full string. [shell.ts:500](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:500)

The model-facing prefix is exactly:

```text
...output truncated...

Full output saved to: <path>

<retained tail>
```

[shell.ts:575](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:575)

When output is line-truncated but never crossed the byte limit, the final retained raw output is written at completion. [shell.ts:568](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:568)

### Streaming preview

Live metadata retains only the last **30,000 characters**, prefixed with `...\n\n` after overflow. [shell.ts:27](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:27), [shell.ts:220](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:220)

The internal rolling chunk list targets twice the configured byte limit, while final model output is reduced to the single configured limit. [shell.ts:438](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:438)

### Empty output, exit codes, timeouts, and aborts

- Empty output becomes exactly `(no output)`. [shell.ts:575](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:575)
- The exit code is stored in `metadata.exit`; a non-zero exit does not itself discard output. [shell.ts:585](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:585)
- Default timeout is **120,000 ms**, configurable through `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS`. [shell.ts:347](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:347)
- Timeout appends a `<shell_metadata>` block telling the model to retry with a larger timeout if appropriate. [shell.ts:561](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:561)
- Abort appends `User aborted the command`. [shell.ts:567](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:567)
- Spawn/runtime defects surface as tool errors through `Effect.orDie`; normal non-zero exits remain ordinary completed tool results. [shell.ts:481](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:481)

Persisted tool replay uses the output string, not general metadata. [message-v2.ts:290](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/message-v2.ts:290)

## SessionV2 bash differences

V2 bash defines:

- default timeout: **120,000 ms**;
- maximum timeout: **600,000 ms**;
- process capture limit: **1 MiB**.

[core bash.ts:18](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/bash.ts:18)

The process collector retains the **first** 1 MiB and marks later data truncated. [process.ts:121](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/process.ts:121)

It appends:

```text
[output capture truncated at the in-memory safety limit]
```

[core bash.ts:186](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/bash.ts:186)

Afterward, the generic V2 50 KiB/2,000-line layer produces a balanced head-and-tail preview. It cannot recover shell bytes already dropped past the 1 MiB process cap; the source keeps this limitation as an explicit TODO. [core bash.ts:76](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/bash.ts:76)

V2 always adds either `Command exited with code N.` or `Command timed out before completion.` to the model result. [core bash.ts:51](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/bash.ts:51)

---

## 5. Tool description prompts

## Storage and delivery

Most SessionV1 descriptions live in adjacent `.txt` files and are imported as strings—for example, read at [read.ts:7](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:7), grep at [grep.ts:7](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.ts:7), and edit at [edit.ts:11](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/edit.ts:11).

The registry sends these descriptions alongside schemas, and permits plugins to transform them before delivery. [registry.ts:305](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/registry.ts:305)

Stored base-description sizes at this commit:

| Tool | Lines | Words | Bytes |
|---|---:|---:|---:|
| `skill` | 5 | 68 | 399 |
| `glob` | 6 | 89 | 517 |
| `grep` | 8 | 108 | 657 |
| `write` | 8 | 108 | 623 |
| `question` | 10 | 111 | 657 |
| `edit` | 10 | 231 | 1,369 |
| `webfetch` | 13 | 130 | 750 |
| `plan_exit` | 13 | 107 | 579 |
| `read` | 14 | 211 | 1,158 |
| `websearch` | 14 | 157 | 1,033 |
| `task` | 19 | 412 | 2,305 |
| shell base template | 21 | 204 | 1,269 |
| `lsp` | 24 | 196 | 1,303 |
| `apply_patch` | 33 | 187 | 1,098 |
| `todowrite` | 44 | 337 | 2,012 |

These counts exclude JSON-schema field descriptions.

### Dynamic descriptions

The final shell description is substantially longer than its 21-line base template. It injects OS, shell, timeout, output limits, temporary directory, shell-specific rules, file-tool routing, parallel-call advice, and Git/PR rules. Rendering occurs at [shell/prompt.ts:273](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell/prompt.ts:273); the Bash-specific usage block is at [shell/prompt.ts:78](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell/prompt.ts:78).

The task description also grows dynamically:

- the registry appends a sorted list of available subagent types and descriptions; [registry.ts:260](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/registry.ts:260)
- experimental background-task instructions are conditionally appended. [task.ts:350](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/task.ts:350)

Code mode appends an MCP tool catalog when applicable. [registry.ts:275](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/registry.ts:275)

## Few-shot examples and usage rules

Descriptions are not merely one-line API summaries. They deliberately contain model-training guidance:

- `read` includes an exact line-numbering example and advises larger windows instead of repeated 30-line slices. [read.txt:10](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.txt:10)
- `glob` and `grep` include example patterns. [glob.txt:2](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/glob.txt:2), [grep.txt:3](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.txt:3)
- `edit` explains how to strip the displayed line-number prefix and how to recover from ambiguous matches. [edit.txt:4](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/edit.txt:4)
- `apply_patch` embeds a complete add/update/move/delete patch example. [apply_patch.txt:15](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/apply_patch.txt:15)
- `todowrite` contains positive and negative task examples. [todowrite.txt:32](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/todowrite.txt:32)
- shell contains `<good-example>` and `<bad-example>` blocks and explicit command-routing rules. [shell/prompt.ts:95](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell/prompt.ts:95)
- `websearch` injects the current year and shows a correct/incorrect recency query example. [websearch.txt:13](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/websearch.txt:13)

V2 generally uses shorter inline paragraphs instead. For example, V2 grep is one concise paragraph. [core grep.ts:63](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/grep.ts:63) Question and skill retain longer behavioral prompts. [core question.ts:14](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/question.ts:14), [core skill.ts:27](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/skill.ts:27)

---

## 6. Global output budgets and context-window management

## SessionV1 generic tool-output bounding

Defaults:

- **2,000 lines**
- **50 KiB**
- default retention direction: **head**

[truncate.ts:14](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/truncate.ts:14), [truncate.ts:85](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/truncate.ts:85)

These values are configurable through:

```json
{
  "tool_output": {
    "max_lines": 2000,
    "max_bytes": 51200
  }
}
```

The schema and descriptions are at [config.ts:136](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/v1/config/config.ts:136).

When truncated:

1. the full text is saved under the global `tool-output` data directory;
2. only the bounded preview is returned;
3. a guidance string tells the model how to inspect the saved file.

With task access:

```text
The tool call succeeded but the output was truncated. Full output saved to: <path>
Use the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.
```

Without task access:

```text
The tool call succeeded but the output was truncated. Full output saved to: <path>
Use Grep to search the full content or Read with offset/limit to view specific sections.
```

[truncate.ts:124](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/truncate.ts:124)

Managed files are retained for **seven days**. Cleanup begins after one minute and repeats hourly. [truncate.ts:12](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/truncate.ts:12), [truncate.ts:143](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/truncate.ts:143)

### Important leaf/global interaction

The common wrapper applies generic truncation only when `result.metadata.truncated` is absent. If the leaf supplies either `true` or `false`, its own policy is trusted. [tool.ts:130](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/tool.ts:130)

Consequently:

- `read`, `glob`, `grep`, and shell bypass the generic wrapper because they set `metadata.truncated`;
- read and shell have explicit byte/line management;
- grep’s 100 rows × 2,000-character line previews can theoretically exceed the generic 50 KiB threshold because even `truncated: false` bypasses it;
- ordinary built-ins without leaf truncation receive the global head preview automatically;
- plugin tools are explicitly run through the truncator at the registry boundary. [registry.ts:149](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/registry.ts:149)

## Context-window and output-token budgets

Provider completion output is globally capped at **32,000 tokens**, or the model’s smaller output limit. [transform.ts:18](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/provider/transform.ts:18), [transform.ts:1412](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/provider/transform.ts:1412)

The LLM request passes that calculated maximum to the provider. [request.ts:114](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/llm/request.ts:114)

Overflow calculation reserves:

- configured `compaction.reserved`, or
- the smaller of **20,000 tokens** and the provider output allowance.

[overflow.ts:8](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/overflow.ts:8)

Automatic compaction triggers once reported total usage reaches the usable context threshold. [overflow.ts:22](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/overflow.ts:22)

## SessionV1 tool-output pruning and compaction

Compaction constants:

- individual tool output serialized into the compaction prompt: **2,000 characters**;
- protect the newest **40,000 estimated tool-output tokens**;
- prune only when more than **20,000 estimated tokens** would be removed;
- `skill` output is protected from this pruning;
- default verbatim tail: **2 user turns**;
- default recent-tail budget: 25% of usable context, clamped to **2,000–8,000 tokens**.

[compaction.ts:28](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/compaction.ts:28), [compaction.ts:116](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/compaction.ts:116), [compaction.ts:224](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/compaction.ts:224)

Old pruned tool output is replayed as exactly:

```text
[Old tool result content cleared]
```

[message-v2.ts:290](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/session/message-v2.ts:290)

## SessionV2 generic output bounding

V2 centralizes bounding in `ToolRegistry.settle`; every successful canonical tool output flows through `ToolOutputStore.bound`. [core registry.ts:62](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/registry.ts:62)

Defaults remain 2,000 lines and 50 KiB. Unlike SessionV1’s default head-only preview, V2 divides the preview approximately equally:

- `ceil(maxLines / 2)` head lines;
- `floor(maxLines / 2)` tail lines;
- or half the bytes for each side when byte-limited.

[tool-output-store.ts:74](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool-output-store.ts:74)

The marker is:

```text
... output truncated; full content saved to <path> ...
```

[tool-output-store.ts:138](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool-output-store.ts:138)

Media parts are preserved outside the text budget. [tool-output-store.ts:140](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool-output-store.ts:140)

V2 compaction defaults are:

- **20,000-token** context buffer;
- **8,000 recent tokens** retained;
- **2,000-character** tool result serialization;
- **4,096-token** maximum compaction summary.

[core compaction.ts:12](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/session/compaction.ts:12)

---

## 7. Diagnostics and edit confirmation

SessionV1 does **not** echo complete edited files back to the model.

### `edit`

The direct model-facing success is:

```text
Edit applied successfully.
```

If LSP finds errors in that file, it appends:

```text
LSP errors detected in this file, please fix:
<diagnostics ...>
```

[edit.ts:196](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/edit.ts:196)

A unified diff, addition/deletion counts, and diagnostics are retained in metadata for UI/permission rendering, but the success text itself does not contain the diff. [edit.ts:175](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/edit.ts:175)

### `write`

Success is:

```text
Wrote file successfully.
```

followed by current-file diagnostics and diagnostics from at most **five other files**. [write.ts:18](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/write.ts:18), [write.ts:74](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/write.ts:74)

It does not echo the written content or diff to the model.

### `apply_patch`

The result is a status-only file list:

```text
Success. Updated the following files:
A new-file.ts
M changed-file.ts
D deleted-file.ts
```

followed by per-edited-file LSP errors when present. [apply_patch.ts:273](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/apply_patch.ts:273)

The complete aggregate diff and per-file patches remain metadata. [apply_patch.ts:295](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/apply_patch.ts:295)

### Diagnostic caps

Only severity-1 LSP errors are emitted. Each file is capped at **20 errors**, with:

```text
... and <N> more
```

[LSP diagnostic.ts:3](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/lsp/diagnostic.ts:3), [LSP diagnostic.ts:20](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/lsp/diagnostic.ts:20)

### V2 edit confirmation

V2 is more explicit but still bounded. Exact edit returns:

```text
Edited file successfully: <path>
Replacements: <N>
```diff
-<old preview>
+<new preview>
```
```

Each side is limited to **six lines**, and each preview line to **240 characters**; an extra `...` row indicates omitted lines. [core edit.ts:66](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/edit.ts:66), [core edit.ts:73](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/edit.ts:73)

V2 write returns only `Wrote file successfully: <path>` or `Created file successfully: <path>`. [core write.ts:38](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/write.ts:38)

V2 patch returns only an `A`/`M`/`D` list. [core apply-patch.ts:37](/Users/seandearnaley/Documents/GitHub/opencode/packages/core/src/tool/apply-patch.ts:37)

---

## 8. In-context-learning and narrowing guidance

The implementation repeatedly teaches the model how to avoid high-token follow-ups.

### Search narrowing

Grep cap:

```text
(Results truncated. Consider using a more specific path or pattern.)
```

[grep.ts:99](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.ts:99)

Glob cap:

```text
(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)
```

[glob.ts:57](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/glob.ts:57)

The descriptions further route open-ended repeated search to `Task`, while keeping single-file or exact-symbol searches in cheaper direct tools. [grep.txt:6](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.txt:6), [task.txt:5](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/task.txt:5)

### Empty-result messaging

- Grep and glob: `No files found`. [grep.ts:33](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/grep.ts:33), [glob.ts:54](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/glob.ts:54)
- LSP: `No results found for <operation>`. [lsp.ts:105](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/lsp.ts:105)
- Shell: `(no output)`. [shell.ts:575](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell.ts:575)

### “Did you mean” and recovery hints

- Missing read paths return up to three `Did you mean one of these?` suggestions. [read.ts:76](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.ts:76)
- Ambiguous edit:

```text
Found multiple matches for oldString. Provide more surrounding context to make the match unique.
```

[edit.ts:728](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/edit.ts:728)

- Failed exact edit:

```text
Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.
```

[edit.ts:723](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/edit.ts:723)

- Unsafe fuzzy expansion:

```text
Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.
```

[edit.ts:709](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/edit.ts:709)

- Invalid schema input:

```text
The <tool> tool was called with invalid arguments: <detail>.
Please rewrite the input so it satisfies the expected schema.
```

[tool.ts:24](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/tool.ts:24)

### Delegation as context preservation

The generic truncator explicitly tells capable agents not to read a huge saved result themselves:

```text
Use the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.
```

[truncate.ts:129](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/truncate.ts:129)

### Parallelism guidance

Descriptions instruct the model to batch independent tool calls:

- glob calls this “speculatively perform multiple searches as a batch”; [glob.txt:6](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/glob.txt:6)
- read says to call in parallel for known multiple files; [read.txt:12](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/read.txt:12)
- shell says independent commands should be separate parallel calls in one message. [shell/prompt.ts:107](/Users/seandearnaley/Documents/GitHub/opencode/packages/opencode/src/tool/shell/prompt.ts:107)

This reduces conversational round trips without increasing individual tool-result size.

---

# Key token-efficiency techniques, ranked by impact

1. **Global bounded tool-output storage:** ordinary results are capped at 2,000 lines/50 KiB, while full text is saved for targeted grep/read follow-up. SessionV2 strengthens this with balanced head-and-tail sampling.

2. **Automatic context compaction and old-tool-result pruning:** old outputs are replaced with a tiny marker, recent turns are retained under a bounded token budget, and compaction summaries see only 2,000 characters per tool result.

3. **Early leaf-level search caps:** grep and glob stop after 100 results instead of generating an arbitrarily large model result.

4. **Paged, byte-bounded file reads:** numbered lines, offsets, explicit continuation hints, a 50 KiB call cap, and 2,000-character per-line previews make large files inspectable without full ingestion.

5. **Tail retention for terminal output:** SessionV1 shell preserves the end of logs, where failure details usually occur, while streaming the full output to a searchable managed file.

6. **Compact mutation acknowledgements:** edit/write/patch report success, affected paths, bounded snippets, and capped diagnostics instead of echoing entire files or full diffs.

7. **Prompt-level routing to cheaper tools:** descriptions tell the model to use direct read/grep/glob for precise questions, Task for genuinely open-ended exploration, and dedicated filesystem tools instead of verbose shell commands.

8. **Actionable truncation strings:** every capped path teaches the next efficient operation—narrow the pattern, increase the read offset, grep the saved result, or delegate its analysis.

9. **Empty-result and repair-oriented errors:** terse `No files found`, “Did you mean,” exact-match guidance, and schema-rewrite instructions reduce blind retries.

10. **Dynamic tool visibility:** model-, client-, permission-, provider-, and feature-based filtering avoids paying prompt tokens for tools that cannot or should not be used.
