# Brainstrike Agent Package (`@brainstrike/agent`)

## Purpose and scope

This `agent` package contains the runtime, types and utilities used by the **Brainstrike  
Assistant**. It wraps the Mastra agent core,  
OpenAI’s SDK and the Model‑Context Protocol (MCP) client to provide a fully streamed  
assistant experience with deterministic tool calls. The package exposes helpers for  
converting UI messages into agent messages, dispatching local tools, validating  
inputs with `zod` and merging in remote  
tools discovered via MCP. It is **not** a general‑purpose AI framework but the  
glue that powers the IDE’s assistant. All instructions here apply only to this  
package – the root of the mono repo may contain its own AGENTS.md that  
describes high‑level project conventions.

## Project overview

At a high level the package is responsible for:

- Providing **typed message structures** (`AgentMessage`, `AgentMessagePart`, etc.) and  
    helpers (`convertAssistantUiMessages`) to normalise arbitrary UI messages  
    into a canonical agent format. These types ensure that streaming payloads are  
    strongly typed and always serialisable.
    
- Creating an **agent runtime** via `createMastraAgentRuntime()`. This helper  
    resolves the OpenAI API key from `runtime.apiKey` or the `OPENAI_API_KEY` or  
    `AI_OPENAI_API_KEY` environment variables, merges local tools with MCP tools  
    discovered at runtime, sanitises tool IDs and configures the underlying  
    Mastra agent with streaming enabled.
    
- Implementing a small set of **web tools** (`web.echo`, `web.searchDocs` and  
    `web.docSummary`) that run in the browser and use zod to validate inputs.
    
- Exposing a **retrieval tool** (`brainstrike.retrieveContext`) that fetches
    semantic matches from the local embedding store, packs them under a token
    budget, and returns citation-ready metadata for the assistant.
    
- Exposing a simple **in‑memory memory store** for development and testing; this  
    can be replaced with a more sophisticated store (e.g. backed by a DB or  
    summarisation service) by swapping the exported `InMemoryMemoryStore`.
    
- Adapting tool progress and results into a uniform `StreamChunk` format so  
    that the UI can render consistent progress indicators and final results.
    

## Set‑up and development

### Install dependencies

This package relies on `pnpm` and the workspace is  
configured as a **TurboRepo**. From the repository root, install all  
dependencies once:

`pnpm install`

### Building and watching

- **Build once**: run `pnpm build` from this package’s directory. It runs  
    `tsup` to compile TypeScript to both ESM and CJS in the `dist` folder and  
    emits type declarations. It also runs `tsc` to ensure type correctness.
    
- **Watch for changes**: run `pnpm dev` to rebuild on file changes.
    

### Testing

We use Vitest for unit tests. To run the test suite  
once, execute:

`pnpm test`

For watch mode use `pnpm test:watch`. To check coverage across all exported  
code, use `pnpm test:coverage`. All tests should pass before you merge; the  
CI checks in `.github/workflows` will block failing builds. To focus on a  
specific test you can use `pnpm vitest run -t "<test name>"`[agents.md](https://agents.md/#:~:text=,t%20%22%3Ctest%20name).

### Type checking and linting

TypeScript is configured in **strict mode** – treat all `tsconfig` warnings as  
errors. The repo uses a combination of ESLint and Biome for formatting.  
Before committing, run:

`pnpm lint pnpm type-check`

We follow a few simple rules: single quotes, no semicolons and prefer  
functional patterns. See the root `eslint.config.js` for details. Editors  
should be configured to respect the project `.editorconfig` and prettier rules.

## Architecture and best practices

### Runtime creation

`createMastraAgentRuntime(options)` is the primary entry point. It accepts  
instructions, model configuration and optional runtime settings (`apiKey`,  
`mcpConfig`, tool overrides, etc.) and returns an object containing a Mastra  
agent and optional MCP client. Under the hood it resolves the OpenAI API key  
using the provided runtime or environment variables; if no key is found, it  
throws a `mastra_agent_missing_api_key` error. The runtime merges local tools  
with any tools discovered via MCP, sanitises tool identifiers to avoid  
collisions, and exposes a disposable `agent` ready to stream responses.

When adding new configuration fields, make sure they are serialisable; runtime  
data is eventually passed over WebSockets or process boundaries. For example  
`AbortSignal` is safe, while complex classes should be converted to plain  
objects.

### Tools

Tools are the main extension point. A tool is an object with an `id`, a  
human‑readable `description`, an optional `inputSchema` and an `execute`  
function. Within this package the local tools live in `src/mastra/web‑tools.ts`.  
When adding a new tool:

1. **Design a clear API**. Prefer small, composable tools over monoliths.  
    Each tool should do one thing well (e.g. search docs, summarise a document,  
    read the filesystem). The description should be concise and written in  
    natural language so that the LLM can choose the tool correctly.
    
2. **Validate inputs**. Define a `zod` schema and assign it to  
    `inputSchema`. Use types like `z.string().min(1)` to avoid empty queries or  
    unreachable paths. All external inputs must be validated before use.
    
3. **Report progress**. Long‑running tools should emit progress updates via  
    the `normalizedProgress` helper from `src/tools/progress‑adapter.ts`. Even  
    simple tools can append periodic messages to keep the UI responsive.
    
4. **Stream output**. When possible, stream results incrementally rather than  
    returning one large payload. This keeps memory usage low and makes the  
    assistant feel responsive. Use the `StreamChunk` types to emit `text‑delta`  
    chunks and `tool‑event` chunks for progress and completion.
    
5. **Name sanitation**. Tool IDs are sanitised to contain only `[a‑zA‑Z0‑9_-]`.  
    If two tools sanitise to the same base name, a stable hash suffix is  
    appended automatically. Use descriptive IDs in your source code but be  
    aware that the runtime may rename them internally; the original name is  
    preserved in `runtime.toolNameMap`.
    
6. **Document your tool**. Update this AGENTS.md to describe any new tools,  
    their purpose, limitations and usage. If the tool proxies to an external  
    service, document rate limits and fallback behaviour.
    
### `brainstrike.retrieveContext` tool

Purpose: fetch semantically relevant chunks from the active embedding set,
respect selection constraints, and pack them under a token budget for chat.

Input (zod-validated):
- `query` (string, required): the user query to embed and retrieve against.
- `limit` (number, optional): max retrieval candidates before packing.
- `threshold` (number, optional): similarity threshold (0-1).
- `tokenBudget` (number, optional): max tokens to pack.
- `maxChunks` (number, optional): hard cap on packed chunks.
- `embeddingSetId` (string, optional): override active set (runtime wins).
- `filePaths` (string[], optional): allowlist (runtime wins).
- `selectionSnapshotId` (string, optional): snapshot allowlist id.

Behavior/constraints:
- Requires an active embedding set; errors if missing.
- Hosted embedding providers only; local models are rejected (renderer-only).
- Selection constraints are enforced using runtime-provided file paths/snapshot.
- Creates selection snapshots when the allowlist exceeds inline limits.

Output:
- `context` (string): concatenated context with file headers.
- `chunks` (array): packed chunks with `filePath`, `chunkIndex`, `tokenCount`,
  `score`, and `offsets` when available.
- `totalTokens`, `budget`, `remainingTokens`, `skipped`.

Errors:
- Safe, user-facing messages only (no secrets or raw file contents).


### Remote tools via MCP

The Model‑Context Protocol allows tool providers to be run as separate  
processes or remote HTTP services and discovered at runtime. You can configure
servers in an `mcp.config.json` adjacent to where `createMastraAgentRuntime` is
invoked. Every server requires a unique `name` and one explicit transport:
`stdio`, `streamable-http`, or legacy `sse`. The transport is never inferred
from the URL and there is no automatic HTTP-to-SSE fallback.

Use Streamable HTTP for new remote servers:

```json
{
  "servers": [
    {
      "transport": "streamable-http",
      "name": "remote-api",
      "url": "https://your-host.example.com/mcp"
    }
  ]
}
```

Use `transport: "sse"` only for a server that explicitly implements the legacy
HTTP+SSE transport, typically at an `/sse` endpoint. `stdio` entries require
`command`; both HTTP variants require `url` and accept the same optional
`headers`. When the agent starts, it attempts to discover tools from all
configured servers with a default timeout of 5 seconds. If discovery times  
out, the agent logs a warning and continues with local tools only.

The protocol-faithful remote client is exported from the dedicated
`@brainstrike/agent/mcp-client` entrypoint. It uses the official MCP SDK and
constructs only the configured HTTP transport; it never probes, rewrites paths,
or falls back. Remote URLs must be HTTP(S), must not contain credentials, and
configured headers that conflict with protocol-required values fail loudly.
Connections are lazy and concurrency-safe. A failed initial connection can be
retried with a fresh transport, while `close()` is terminal and idempotent. For
a stateful Streamable HTTP connection, close attempts session termination before
locally closing and still completes local cleanup if termination fails.

`createMastraAgentRuntime` partitions the configured servers before discovery:
Mastra's MCP client receives only `stdio`; each HTTP entry uses the explicit SDK
client above. Their toolsets then rejoin the unchanged namespace/sanitize,
output-bound, guard, hook, and permission pipeline. HTTP tool progress is emitted
as a transient custom stream part; a progress-writer failure is logged but never
overrides the remote tool's primary result or error.

Tips for MCP integration:

- Keep remote tool processes isolated and sandboxed. Avoid passing  
    unvalidated user input to remote commands.
    
- Do not include secrets directly in `mcp.config.json` – instead, supply  
    credentials via environment variables and read them in the remote process.
    
- Use the MCP hot reload mechanism to 
    rebuild remote clients on changes; this emits progress events so the UI  
    remains responsive.
    

### Memory and conversation management

The package exports `InMemoryMemoryStore`, which stores conversations keyed by  
conversation ID. It is suitable for development and unit tests but not for  
production: messages are lost on restart and unbounded growth can exhaust  
memory. For production you should implement a durable store (e.g. SQLite,  
browser IndexedDB or a server‑side database). A store should provide  
methods to **append** messages, **retrieve** a conversation and **list**  
recent conversations; optional summarisation can keep token usage under  
control. When persisting to disk, always encrypt user data at rest.

### Streaming and progress

All agent responses are streamed. The `streamMastraAgent()` helper wraps  
Mastra’s `agent.streamVNext()` and converts each Mastra part into one of four  
`StreamChunk` variants: `text‑delta` (plain assistant text), `tool‑event`  
progress/status chunks, `message‑finish` markers and `finish` markers. A  
custom UI should iterate over the returned `AsyncIterable` and render  
partials as they arrive. Remember to call `runtime.dispose()` when the  
stream ends to free underlying resources.

Progress messages emitted by tools can be normalised with  
`normalizeProgressPayload()`. It accepts diverse shapes—percentages,  
fractions, string statuses—and converts them into a consistent `{ step, percent, note }` structure. Use this to build a progress bar in your UI.

## Security and guardrails

### Core Security Requirements
* **No secrets in client bundles.** Period. Use environment variables, secure desktop storage, or secure injection patterns.
* **Input validation** for all user-provided data using zod schemas before processing.
* **Proper error handling** without information leakage—don't expose internal paths, API keys, or stack traces.
* **Dependencies scanned** for vulnerabilities using `pnpm audit` and automated scanning in CI.

### AI Agent Security
AI agents have access to file systems, external APIs and potentially sensitive data. Follow these rules:

* **Validate all inputs** with zod before they reach your tool logic. Reject invalid paths, excessively long strings and unsupported encodings early.
* **Never echo secrets**. Filter out API keys and tokens from tool outputs.
* **Limit payload sizes**. Cap the number of results returned by search tools and impose maximum byte counts when reading files. If your tool proxies to an external service, enforce request size limits and strip unneeded fields.
* **Sanitize outputs** - ensure tool outputs don't contain executable code or sensitive information.

### MCP Integration Security
Tips for MCP integration:

* Keep remote tool processes isolated and sandboxed. Avoid passing unvalidated user input to remote commands.
* Do not include secrets directly in `mcp.config.json` – instead, supply credentials via environment variables and read them in the remote process.
* Use the MCP hot reload mechanism to rebuild remote clients on changes; this emits progress events so the UI remains responsive.
* **Transport security** - ensure MCP transports use secure protocols and proper authentication.
* **Least privilege** - grant MCP servers only the minimum permissions required.

### Development Security Practices
* **Secret management warnings** - prominently display warnings about hardcoded credentials.
* **Dependency security scanning** - run `pnpm audit` before commits and in CI.
* **Error boundary implementation** - prevent sensitive information from leaking through error messages.
* **Secure defaults** - all security-sensitive features should default to the most secure option.
* Keep secrets out of version control. API keys should be loaded via environment variables or secure desktop storage; never commit them to code or tests.
    
- **Emit progress** updates for long‑running operations so the UI doesn’t  
    appear hung. In the absence of progress updates the assistant may be  
    cancelled by the user.
    
- **Log usage**. When instrumenting the assistant, capture latency, token  
    usage and errors. Use these metrics to tune prompts and identify  
    bottlenecks.
    
- **Fallback behaviours**. Define how your tool should behave if a remote  
    API fails or returns invalid data. Return a structured error via a  
    `tool‑event` with status `error` rather than throwing uncaught exceptions.
    
- **User guidance**. Add helpful messages to your tools’ descriptions so  
    that the language model selects them appropriately and does not attempt to  
    hallucinate unsupported functionality.
    

## Contributing guidelines

Coding agents will read this file and use it to automatically run commands and  
verify their work[agents.md](https://agents.md/#:~:text=,t%20%22%3Ctest%20name). Humans should also follow these guidelines when  
contributing:

1. **Stay within scope**. Avoid coupling this package to unrelated parts of  
    the monorepo; import only from `@brainstrike/utils`, `@mastra/core` and  
    other explicitly allowed packages. The agent package must remain  
    framework‑agnostic—no React or Electron imports.
    
2. **Write tests first**. Any new feature or bugfix should be accompanied by  
    unit tests in `src/__tests__`. Tests document expected behaviour and  
    prevent regressions. Use Vitest and the existing mocks (e.g. in  
    `mastra-streaming.spec.ts`) as examples.
    
3. **Document new tools and runtime options** by updating this file. Include  
    usage examples and edge cases. Tools with side effects must be clearly  
    marked so that agents ask for confirmation.
    
4. **Run the full suite** (`pnpm test`, `pnpm type-check` and `pnpm lint`) before  
    opening a pull request. CI will reject commits that fail.
    
5. **Commit conventions**. Use the format `[agent] <title>` for commit and PR  
    titles[agents.md](https://agents.md/#:~:text=). Describe what changed and why. Explain any  
    breaking changes or behaviour differences in the body.
    
6. **Keep secrets out of version control**. API keys should be loaded via  
    environment variables or secure desktop storage; never commit them to  
    code or tests.

## Recommended reading and future work

- Review the source code in `src` for idiomatic patterns. Functions like  
    `sanitizeTools()`, `mapMastraToolEvent()` and `normalizeProgressPayload()`  
    illustrate how to handle untrusted inputs and convert them into safe  
    structures.
    
This file should evolve alongside the package. Treat it as **living  
documentation**: update it whenever build commands change, new tools are  
added or security considerations evolve. Keeping AGENTS.md accurate will  
ensure that coding agents and human contributors alike can work effectively  
with the Brainstrike Agent package.
