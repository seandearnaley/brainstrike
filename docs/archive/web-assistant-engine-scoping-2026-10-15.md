# Scoping: what `apps/web`'s assistant endpoint runs on, and what it should

Date: 2026-10-15 · Base: `3a13e147c` · Decision document, no source changed.
Resulting proposal: [ADR-0022](../adr/0022-web-assistant-stateless-ai-sdk-proxy.md).

The web assistant route is the last production caller of the Mastra agent loop.
Until it is answered, the ~32.8K lines in `packages/agent/src/mastra/` cannot be
subtracted. This document establishes what the route actually does, what moving
it onto the host would cost, and how much of the engine each option retires.

Every number below was measured against the working tree, not inherited.

---

## 1. What the web assistant path does today

### The chain

| Hop | File |
| --- | --- |
| Vercel function | [`apps/web/api/assistant.ts`](../../apps/web/api/assistant.ts) — `VERCEL_ENV` gate, then dynamic import |
| Transport shell | [`route.ts`](../../apps/web/src/app/api/assistant/route.ts) — bounded body read (413), `last-event-id` → 409 |
| Decision core | [`web-assistant-post.ts:66`](../../apps/web/src/server/web-assistant-post.ts) `runWebAssistantPost` |
| Trust boundary | [`web-assistant-runtime.ts:104`](../../apps/web/src/server/web-assistant-runtime.ts) `filterWebAssistantPayload` |
| Shared prep | `@brainstrike/assistant-service/request` → `prepareAssistantPostRequest` |
| Stream build | [`web-assistant-stream.ts:46`](../../apps/web/src/server/web-assistant-stream.ts) |
| Adapter | `@brainstrike/agent/hosted-web` → [`message-utils.ts:301`](../../packages/agent/src/message-utils.ts) `toAiSdkStyleStream` |
| **Engine** | [`mastra/agent-streaming.ts:1800`](../../packages/agent/src/mastra/agent-streaming.ts) `streamMastraAgent` |
| Response | [`stream/data-stream.ts`](../../packages/agent/src/stream/data-stream.ts) `createStatelessAssistantDataStreamResponse` |

`src/hosted-web.ts` is a first-class tsup entry (`tsup.config.ts:8`) and
`apps/web` depends on `@brainstrike/agent` as `workspace:*`. This is shipped
code, not a dev path.

### Real capabilities

The capability envelope is set by the allow-list in
[`web-assistant-runtime-schema.ts`](../../apps/web/src/server/web-assistant-runtime-schema.ts),
not by the engine. It partitions wire fields three ways:

- **Forwarded** (`:164`) — workspace metadata only: `workspaceContext`,
  `mainRootPath`, `selectionFilePaths`, `projectId`, `tokenBudget`,
  `workspaceIndex*`. These become a prompt preamble via
  `injectWorkspaceRootManifestContext` (`workspace-root-manifest.ts:159`).
- **Accepted and ignored** (`:189`) — `model`, `modelSettings`, `agentLoop`,
  `enabledNativeToolIds`, `mcpEnabled`, `providerOptions`,
  `requestedReasoningEffort`. Accepted for desktop/web wire parity, never
  copied into the runtime.
- **Rejected** (`:255`) — everything else, 400 `unsupported`. This includes
  `mastraTools`, `mcpConfig`, `memory`, `personas` and `storage`.

| Capability | Web today | Evidence |
| --- | --- | --- |
| Tools | **None.** Empty registry. | `mastraTools` unreachable; `web-assistant-stream.ts:16` "exposes no tool registry"; tests at `web-assistant-runtime.test.ts:57,67` |
| MCP | **None.** | `mcpConfig` rejected; `mcpEnabled` accepted-and-ignored |
| Memory | **None.** | `memory` rejected; no `storage` argument passed |
| Subagents / personas | **None.** | `personas` rejected |
| Approvals | **Refused, 409.** | `web-assistant-post.ts:123,133` — "requires durable workflow storage" |
| Server persistence | **None.** | No storage argument; `createStatelessAssistantDataStreamResponse` with `cleanupDelayMs: 0` |
| Stream resume | **Refused, 409.** | `route.ts:51` — "stateless streams cannot replay across Vercel instances" |
| Multi-turn history | **Yes, client-supplied.** | Full message array on every POST; server holds nothing |
| Client persistence | **Yes — in the browser.** | PGlite on IndexedDB (`idb://web-pg18`), `main.tsx` |
| Providers | openai, anthropic, google, openrouter | `assistant-config.ts:9` |
| Model | Server-owned provider default | `model` ignored; `PROVIDER_DEFAULT_MODELS` |
| Credentials | Server env keys only, `kind: 'api_key'` | `web-assistant-post.ts:96`; local providers rejected |
| Stream shape | AI SDK data stream v1 | `x-vercel-ai-data-stream: v1`, `text/plain` |

**What is stateless:** the server. No session, no store, no replay, no
cross-request affinity, nothing retained after the response.

**What is not stateless:** the user's data. Threads, workspace and embeddings
live in browser-side PGlite. The web data root is the browser.

### The finding that matters

Every stateful input the Mastra engine can consume is unreachable from the web
wire. Web runs a multi-step, tool-calling, memory-backed, approval-gated,
subagent-capable engine with **all of it switched off at the door** — as a
single-step `streamText` call with an empty tool map.

Independent corroboration: open PR #3621 is titled "cover the turn-driven
assistant cases web can no longer run."

---

## 2. What the host offers, and what a web client would need

The host protocol (`packages/agent-host/src/protocol.ts:365-545`) declares **44
methods** in its core request table; bound families (catalog, providers, MCP
settings/content/presentation, hook trust, permission policy, auth) bring the
surface to roughly 60.

A browser chat client would call, minimally:

| Need | Methods |
| --- | --- |
| Attach | `initialize` (32-byte token, constant-time compare) |
| Thread lifecycle | `thread/start`, `thread/list`, `thread/read`, `thread/update`, `thread/delete` |
| Run a turn | `run/start`, `run/input`, `run/stop`, `run/steer`, `run/regenerate` |
| Follow output | `log/subscribe {threadId, fromSeq}`, `log/unsubscribe` |
| Approvals / questions | `interaction/respond`, `interaction/resume` |
| Model selection | `thread/selection/read`, `thread/selection/set` (ADR-0019) |
| Workspace | `thread/workspace/read`, `thread/workspace/set`, `thread/workspace/binding/*` |
| Credentials | `auth/status`, `auth/login`, `auth/verify`, `providers/verify` |

That is 20-plus methods and a long-lived subscription, against the one stateless
POST web has now.

### What the host actually accepts as a transport

ADR-0017: "one schema over stdio, a local socket or Windows named pipe, or an
Electron MessagePort."

The code is narrower than prose might suggest. The endpoint is validated by a
regex in [`host-lease/src/record.ts:13-15`](../../packages/host-lease/src/record.ts):

```
/^(?:\/[^\r\n\0]+|\\\\\.\\pipe\\brainstrike-[a-f0-9]+)$/
```

An absolute filesystem path, or a Windows named pipe. Nothing else validates.
`host-lease/src/runtime.ts:83` builds the POSIX endpoint as a Unix domain socket
under `tmpdir()/bs-h-<sha256(root)[0:16]>/s` in an owner-only directory;
`:224` builds the Windows named pipe. `createServer` is `node:net`
(`runtime.ts:3`). Framing is `vscode-jsonrpc`'s `StreamMessageReader/Writer`
(`Content-Length`-delimited), not HTTP and not WebSocket.

**There is no TCP listener in the host. There is no port.**

`packages/agent-host/src/browser-client.ts` is not a counterexample: it is 33
lines of `vscode-jsonrpc/browser` over a **MessagePort**, which is the Electron
renderer bridge. It is in-process, not a network client.

So "make the web app a host client" requires a network transport that does not
exist, and the endpoint schema itself would have to change to admit one.

---

## 3. ADR-0012: drift, or a step never taken?

ADR-0012's sentence is in **Consequences**, not Decision:

> `@mastra/core` stays Node-only and externalized from browser bundles. Web chat
> goes through a stateless serverless proxy running the AI SDK with hosted
> models and no tools.

Clause by clause against what is deployed:

| Clause | Deployed? | Evidence |
| --- | --- | --- |
| stateless | **Yes** | no session registry, no replay, 409 on `last-event-id`, `cleanupDelayMs: 0` |
| serverless proxy | **Yes** | Vercel function, `maxDuration: 300` |
| hosted models | **Yes** | four hosted providers; local/ollama/lmstudio rejected by the allow-list |
| no tools | **Yes** | empty tool registry, enforced at the boundary and under test |
| running the AI SDK | **Partly** | it reaches the AI SDK *through Mastra's agent loop*, not directly |

**Answer: neither, exactly — and the distinction is the whole point.**

It is not capability drift. Web's observable behaviour already matches ADR-0012
on every clause that describes what the endpoint *does*. The gap is one clause
about *how*: the proxy calls `streamText` via a 32.8K-line engine instead of
calling it directly.

It is also not simply "a step never taken", because the capability-shedding work
was done — deliberately, across BST-973-2, BST-1030 and BST-1352, with the
rejections written into the code as `ARCHITECTURAL`. What was never taken is the
*last* step: swapping the engine out from under a boundary that had already
stopped feeding it anything.

Supporting evidence that the engine is considered gone:
`docs/agents/mastra-boundary.md:8` says "Do not resurrect the removed agent loop"
— present tense, while it is live behind a shipped HTTP route.

---

## 4. Where serverless and the stateful host actually collide

Not gestures. Each is a specific mechanism that fails.

**1. The lease is per data root, and a web user has no data root on the server.**
ADR-0017: "One host per data root." The root is a filesystem path holding
`host.json` and a flock'd lock file. A web user's data lives in browser
IndexedDB (`main.tsx`, `idb://web-pg18`). Serving N web users means N roots, N
flocks and N host processes on real disk — inventing a server-side per-user data
root that the product does not currently have, and that nothing in the greenfield
data lifecycle (ADR-0020) accounts for.

**2. A Vercel function cannot hold the lease.** Functions are recycled between
requests and have no stable local disk. `host-lease.md`: "A live but unreachable
owner is refused, never killed, replaced or guessed stale." A function that dies
holding a flock leaves a root that the next function **must refuse**, by design.
The refusal is correct behaviour, and it is unrecoverable from inside the
serverless model — there is no process left to release it and no supervisor to
notice.

**3. `log/subscribe` is a follow, and the function has a 300-second ceiling.**
`apps/web/vercel.json:15` sets `maxDuration: 300`. `log/subscribe {threadId,
fromSeq}` replays then **follows indefinitely**, publishing after commit. A
follow inside a 5-minute function is a follow that ends at 5 minutes, mid-run,
with the host still running the turn. `fromSeq` makes resumption *possible* —
but only against a host that still exists and still holds the thread, which
returns to breakages 1 and 2.

**4. Recycling mid-stream orphans a committed run, which is worse than losing
it.** The host's whole value is that the run is durable: it keeps going and the
log keeps committing after the client leaves. In serverless, the client *is* the
function. A recycled function abandons a live run that no one is reading, on a
host no subsequent request can reach. Today's stateless route has no such
failure mode — there is no run to orphan.

**5. The browser cannot speak the protocol at all.** A Unix socket or named pipe
is not reachable from a browser. No `fetch`, no `WebSocket`, no `EventSource`
addresses AF_UNIX. A new WebSocket (or HTTP+SSE) transport would have to be
built, authenticated, and admitted by the endpoint schema.

**6. The deployed CSP forbids it even if the transport existed.**
`apps/web/vercel.json` sets `connect-src 'self' https://huggingface.co
https://*.hf.co`. A browser host client talking to a hosted host on any other
origin is blocked by the app's own Content-Security-Policy.

**7. The host bundle does not run on Vercel.** It requires compiled native
addons: `better-sqlite3` (`state-store/src/sqlite.ts:4`),
`@brainstrike/secure-fs-native` (`binding.gyp`, provides the `flock(2)` call),
`@brainstrike/windows-job-native`, `@napi-rs/keyring`. Plus `node:net`,
`node:worker_threads`, `node:fs`. The state store's only writing connection
lives in a worker thread (`state-store.ts:5-7`).

---

## 5. Options

### Option A — rebuild the stateless proxy directly on AI SDK 7

Replace `toAiSdkStyleStream` → `streamMastraAgent` with a direct `streamText`
call behind the same `StreamChunk` iterator the data-stream mapper already
consumes. No host, no Mastra, no new infrastructure.

**Cost.** Small, and bounded by the capability envelope that already exists.
What must be reproduced: provider/model resolution for four hosted providers,
message conversion to AI SDK format, and `StreamChunk` emission matching
`DataStreamMapper`'s expectations. What need *not* be reproduced — because the
boundary already refuses it — tools, MCP, memory, personas, approvals, resume,
persistence, multi-step loops. The workspace preamble
(`injectWorkspaceRootManifestContext`) is independent of the engine and moves
unchanged. Risk concentrates in stream-shape parity, and PR #3618 is already
restoring web assistant e2e on the hosted data-stream transport — the harness to
prove parity is being built now.

**Unblocks.** The last production caller of the loop goes away. `apps/web` stops
pulling `@mastra/core`/`@mastra/memory` through `@brainstrike/agent`, shrinking
what Vercel traces into the function. Makes the engine deletion a mechanical
follow-up rather than a blocked one.

**Forecloses.** Nothing that web has. It does **not** give web tools, memory,
persistence or approvals, and it does not make web a host client. If the product
later wants a true hosted agent, that is Option B and this work is not thrown
away — the stateless proxy remains the correct thing for a no-tools web chat
regardless.

**Retires:** **82 of the 98 files, ~27,808 lines** — the loop-only set. See §6.

### Option B — web talks to a real hosted host

**Cost.** Every item in §4 becomes a build:

- A network transport (WebSocket or HTTP+SSE) for a protocol that has only
  stream sockets today, plus an endpoint-schema change to admit it.
- Per-user server-side data roots with real disk, and a lifecycle for creating,
  resetting and deleting them — which ADR-0020's greenfield reset lifecycle must
  then cover.
- A host supervisor: process-per-user or per-session placement, lease ownership
  outside any request, idle reclamation, and recovery for a host that dies
  holding a flock.
- Authentication and identity. Web has none today: there is no user account, and
  credentials are server env keys. The host's 32-byte token is a local-trust
  mechanism, not multi-tenant auth.
- Credential custody per user, where today a single server env key serves
  everyone.
- A CSP change, and an origin/CORS story for the new transport.
- A runtime that can load native addons — i.e. not Vercel functions. A container
  or VM platform, which the project does not operate.

This is a hosted-product programme, not an endpoint migration. Nothing in the
brief or in the ADRs says a hosted backend is wanted, and ADR-0012 explicitly
declined the adjacent move: "A Mastra server adapter would move ownership of
auth, CORS, secrets and the desktop loopback lifecycle for no capability
Brainstrike lacks." The same reasoning applies with more force here, because
this version also acquires per-user storage and multi-tenancy.

**Unblocks.** Genuine parity: web gets tools, memory, approvals, subagents,
durable runs and cross-device threads. This is the only option that does.

**Forecloses.** Local-first as the product's defining property, for web users.
It introduces a server that holds user data, which is a product decision with
privacy, cost and operational consequences well beyond this scope.

**Retires:** **82 files, ~27,808 lines** — the same set as A. Option B retires
no more engine code than A does; it costs an order of magnitude more to reach
the same subtraction, because the subtraction depends only on web ceasing to
call `streamMastraAgent`, not on what replaces it.

### Option C — run a host in the browser

**Not feasible.** Checked against the bundle rather than assumed.

`packages/agent-host` and its dependencies require compiled native addons
(`better-sqlite3`, `secure-fs-native`, `windows-job-native`, `@napi-rs/keyring`)
and Node builtins that have no browser equivalent — `node:net` for the socket
server, `node:worker_threads` for the state store's single writing connection,
`node:fs` for the root and the flock. The lease's core guarantee is `flock(2)`
on a file descriptor (`secure-fs-native/index.d.ts:42`); a browser has no such
primitive. ADR-0012 and `mastra-boundary.md` independently forbid a browser
runtime without an owner decision.

A browser-only re-implementation of the host over PGlite and Web Locks would be
a second host — a second loop, a second permission system, a second persistence
owner. That is precisely what ADR-0012 and AGENTS.md's "one authoritative writer
per durable fact" exist to prevent.

**Retires:** not applicable; the option is rejected on feasibility.

### Option D — considered and rejected: leave it

Keeping Mastra for web is the only option that retires nothing. It is not
absurd: the route works and the engine is stable. But it holds 32.8K lines and a
pinned `@mastra/core` + `@mastra/memory` pair alive to serve a single-step
no-tools call, keeps a second loop in the tree against ADR-0012, and leaves
documentation (`mastra-boundary.md:8`) stating something false. Stated plainly so
the comparison is honest: **this option retires 0 files.**

---

## 6. How much each option actually retires

Measured by transitive import walk over non-test TypeScript in
`packages/agent/src/mastra/` (script: relative-specifier resolution with
`.ts`/`.tsx`/`/index.ts` candidates, static and dynamic imports).

| Set | Files | Lines |
| --- | ---: | ---: |
| `src/mastra/` non-test, total | 100 | 32,847 |
| Reachable from the web chain (`src/hosted-web.ts`) | 98 | 32,791 |
| Reachable from the loop entry (`agent-streaming` + `agent-runtime`) | 98 | 32,791 |
| Reachable from the tool-projection cluster | 16 | 4,983 |
| **Loop-only — retirable** | **82** | **~27,808** |
| `src/pglite-mastra-memory/` reached by web | 5 | 573 |

The two sets reachable from web and from the loop entry are identical, which
confirms the web route pulls the entire loop and nothing less.

**`src/mastra/` is not one thing.** Sixteen files in it are tool-projection,
sanitisation and output-shaping modules that the **new** host loop consumes —
`tool-sanitizer`, `tool-output-artifact-reader`/`-settlement`,
`tool-projection-input-rejected`, `tool-model-output`, `tool-call-telemetry`,
`shell-output-stream`, `grep-model-format`, `mcp-task-tool-result`,
`mcp-app-tool-call` and their closure. That closure reaches **zero** PGlite files
and never re-enters the loop. They are misfiled, not retired: they belong in
`src/tool-projection/`, and moving them is safe under every option.

### What else holds the engine alive

- `packages/agent/src/index.ts` re-exports engine symbols from 29 `./mastra/*`
  modules (31 export statements, `:175` onward), so the root `.` entry reaches
  **99** files / 32,873 lines.
- Outside `packages/agent/src`, **every** consumer of
  `createMastraAgentRuntime` / `streamMastraAgent` and siblings is a **test** —
  nine files, all under `apps/desktop/src/__tests__/`.
- `src/evaluation/agent-behavior-eval-runner.ts` reaches 71 engine files, but it
  is **not** exported from `src/evaluation/index.ts`, not a tsup entry and not in
  `package.json` exports. Its only consumer is
  `src/__tests__/agent-behavior-eval.spec.ts`. (A prior session's note put this
  on the public export surface; it is not. `evaluation/index.ts` reaches zero
  engine files.)

**So the full retirement sequence is:** (1) web stops calling the loop, (2) move
the 16 tool-projection files out of `src/mastra/`, (3) drop the root re-exports
and re-point the nine desktop tests, (4) delete the remaining 82 files. Step 1 is
the only one that needs this decision. Steps 2-4 are mechanical once it is made.

---

## 7. Recommendation

**Option A.**

The reasoning, in order:

1. **It is already the accepted decision.** ADR-0012 says web is a stateless
   serverless proxy on the AI SDK with hosted models and no tools. Three of
   those four clauses are deployed. Option A completes the fourth. No option
   requiring a new ADR to *authorise* it should win over one that merely
   finishes an accepted one.

2. **The engine provides web nothing.** This is the decisive fact, and it is
   measurable rather than argued: the allow-list rejects every stateful input
   the engine can consume. Removing a dependency that contributes no behaviour
   is subtraction, not a trade.

3. **It retires exactly as much as Option B does.** 82 files either way. The
   expensive option buys no additional deletion, because the deletion is gated
   on web ceasing to call `streamMastraAgent`, not on what replaces it.

4. **Option B is a product decision wearing an engineering costume.** It
   requires a network transport, per-user server data roots, multi-tenant auth,
   credential custody, a host supervisor, a CSP change and a non-Vercel runtime.
   None of that is implied by "retire the Mastra loop". ADR-0012 already
   declined a smaller version of the same move for the same reason. If a hosted
   backend is wanted, it should be decided on its own merits, with its own ADR,
   and not arrived at as a side effect of a deletion.

5. **Option C is closed on evidence**, not on preference: native addons and
   `flock(2)`.

6. **The risk is parity, and it is being de-risked already.** The one real
   hazard in Option A is the stream shape — `StreamChunk` emission the
   `DataStreamMapper` consumes. PR #3618 is restoring web assistant e2e on
   exactly that transport. Sequencing A behind it makes the parity provable
   rather than asserted, with no fallback path and no silent degradation: if the
   direct `streamText` adapter cannot produce a chunk the mapper needs, that is
   a visible failure to fix, never a quiet reversion to the old engine.

What this recommendation does **not** claim: that web should stay tool-less
forever. It claims that the way to give web tools is a deliberate product
decision about a hosted backend, and that keeping a retired engine alive in the
meantime buys nothing toward it.

---

## Sources

All at working tree `3a13e147c`.

- Route and boundary: `apps/web/api/assistant.ts`,
  `apps/web/src/app/api/assistant/route.ts:33,51`,
  `apps/web/src/server/web-assistant-post.ts:44,75,123,133`,
  `apps/web/src/server/web-assistant-runtime.ts:29,104`,
  `apps/web/src/server/web-assistant-runtime-schema.ts:164,189,255`,
  `apps/web/src/server/web-assistant-stream.ts:16`,
  `apps/web/src/server/assistant-config.ts:9,28`
- Engine: `packages/agent/src/message-utils.ts:301`,
  `packages/agent/src/mastra/agent-streaming.ts:1800`,
  `packages/agent/src/index.ts:175`, `packages/agent/src/hosted-web.ts`,
  `packages/agent/tsup.config.ts:8`,
  `packages/agent/src/workspace-root-manifest.ts:159`
- Host: `packages/agent-host/src/protocol.ts:365-545`,
  `packages/agent-host/src/ports.ts:386`,
  `packages/agent-host/src/browser-client.ts`,
  `packages/agent-host/src/runtime.ts:217`
- Lease and store: `packages/host-lease/src/record.ts:13-15`,
  `packages/host-lease/src/runtime.ts:3,83,224`,
  `packages/state-store/src/state-store.ts:5-7`,
  `packages/state-store/src/sqlite.ts:4`,
  `packages/secure-fs-native/index.d.ts:42`
- Deployment: `apps/web/vercel.json:15` (`maxDuration`), CSP `connect-src`;
  `apps/web/src/main.tsx` (browser PGlite `idb://web-pg18`)
- Decisions: ADR-0012, ADR-0017, ADR-0019, ADR-0020;
  `docs/agents/mastra-boundary.md:8`
- In flight: #3618 (web assistant e2e on the hosted data-stream transport),
  #3621 ("cases web can no longer run"), #3625 (web composer memory gate)
