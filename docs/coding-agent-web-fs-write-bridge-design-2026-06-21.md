# Web Assistant FS-Write Renderer↔Node Bridge — Design (2026-06-21)

> P2 of the coding-agent ledger. Resolves "web FS-Access write" — letting the WEB
> assistant write files. Produced by a judge-panel design workflow + verification
> against the branch. **Step 1 (the adapter primitive) is DONE (#PR, commit
> `8bf960fd7`); steps 2–9 below are the bridge build.**

## The problem
The web assistant loop runs in the Vite dev/preview **middleware (Node)** —
`apps/web/src/assistant-stream-helpers.ts` (`handleAssistantEndpoint`) +
`apps/web/src/app/api/assistant/route.ts`. It streams SSE to the browser. But
File System Access handles (`createWritable`) live ONLY in the browser renderer.
So a write tool in the Node loop must **delegate** the write to the renderer and
get the result back.

## Chosen architecture: SSE-out + POST-back, mediated by a module-singleton Map
NOT a WebSocket (`ViteDevServer.httpServer` is nullable in middlewareMode; a WS
adds a `ws` dep + a second connection lifecycle for zero benefit). Instead reuse
the topology already proven on this branch:
- **Proof it works:** `assistantDataStreamSessions` (`packages/agent/src/stream/data-stream.ts`)
  is already a module-singleton `Map` that a request A populates and a LATER
  request B reads — same Vite single-module lifecycle. A `pendingFsWrites` Map is
  a direct copy of this in-production mechanism.
- **Proof the renderer-posts-back loop exists:** the tool-approval notice
  (`assistant-tool-approval-notice.tsx`) `append`s a `runConfig` payload that the
  route reads + resumes on. The FS-write channel reuses this out(SSE)/back(POST)
  shape on a SEPARATE endpoint so it never collides with suspend/resume.

### Data flow
```
Node tool.execute(path, content)
  → size-check (2_000_000) → createPendingFsWrite(correlationId) [module-singleton Map]
  → emit SSE 'aui-data' part name 'fs-write-request' { correlationId, path, root, contentBase64, byteLength }
     on the run's ALREADY-OPEN stream
  → await deferred (AbortSignal-linked to the run signal; timeout)
[browser] DataStreamMapper routes 'fs-write-request' → headless sink
  → queryPermission({mode:'readwrite'}) → WebFileSystemAdapter.writeFileByPath
  → createWritable → write → close → non-fatal web reindex
  → POST { correlationId, ok, created?, bytesWritten?, error? } to /api/fs-write
[Node] middleware → web-fs-write-bridge.resolvePendingFsWrite(correlationId, result)
  → Map lookup resolves/deletes deferred → tool.execute returns structured result
  → Mastra serializes the tool result back into the SAME SSE stream.
```

## Permission arming — the load-bearing decision
FSA `readwrite` needs a **user gesture**; a cold `requestPermission` inside the
async sink is auto-denied by Chrome (a silent no-write). Resolution
(no-silent-fallback):
- The web write tool is an **'edit'-risk tool → permission engine marks it 'ask'
  → it SUSPENDS for an Approve click** (the P1 flow). **That Approve click is a
  fresh user gesture** — call `requestPermission({mode:'readwrite'})` on the
  active root handle THERE, before releasing the resume.
- Secondary arm: eager `requestPermission` at composer-submit (also a gesture).
- At sink time, `queryPermission({mode:'readwrite'})` first; if not `'granted'`,
  POST `{ok:false, error:'fs_write_permission_denied'}` → the tool throws a
  visible FAILED tool event, never a silent no-op.

**This is why P1 (#1293, web suspend/resume) is the prerequisite — and it has
LANDED on feat/coding-agent**, so the gesture path exists (the design agent's
"web returns 501" risk is STALE; my P2 branch is rebased onto #1293).

## Build steps (1 done, 2–9 remain)
1. ✅ `WebFileSystemAdapter.writeFileByPath` (commit `8bf960fd7`): `{create:true}`
   walk + readwrite upgrade + 2MB cap + createWritable. (Add a `..`-segment
   reject as a hardening follow-up — the FSA walk can't escape the root by
   construction, but reject `..` defensively.)
2. `apps/web/src/server/web-fs-write-bridge.ts`: module-singleton
   `pendingFsWrites` Map + `createPendingFsWrite`/`resolvePendingFsWrite`
   (no-throw on miss) + AbortSignal-linked timeout.
3. The web write tool (`packages/agent/src/tools/web-fs-write-tool.ts` or a web
   branch in the factory): size-check → createPendingFsWrite → emit the data part
   → await → return. Register via `runtime.mastraTools` where the web middleware
   builds `toAiSdkStyleStream` options; full multi-registry plumbing
   (schemas/category/description) per AGENTS.md.
4. `POST /api/fs-write` in `apps/web/vite.config.mts` `createApiMiddleware` →
   `handleFsWriteEndpoint` in assistant-stream-helpers.ts →
   `resolvePendingFsWrite`.
5. Register the `'fs-write-request'` route in **`packages/agent/src/stream/data-stream-mapper.ts`**
   (NOT packages/ui — the design's first guess; the judge corrected this) →
   dispatch to the headless renderer sink.
6. The headless sink in `packages/ui/src/assistant-ui-panel`: queryPermission →
   writeFileByPath → non-fatal reindex (`applyManagedCacheBatch` via the
   app-shell workspace-collection-sync path) → POST result.
7. Wire the Approve handler in `assistant-tool-approval-notice.tsx` to
   `requestPermission({mode:'readwrite'})` before releasing resume.
8. Wire the sink in `packages/app-shell` with the WebFileSystemAdapter + reindex.
9. Tests: (a) live-loop over the real `createApiMiddleware` harness + real
   WebFileSystemAdapter (round-trip a REAL delegation per AGENTS.md, not a mocked
   sink); (b) denied-permission → FAILED tool event; (c) timeout → deferred
   rejects + Map entry deleted (no leak); (d) stale correlation ignored; (e)
   Playwright in real Chrome: grant folder, prompt edit, Approve, assert on-disk
   change.

## Top risks / invariants
- **Permission-arming is load-bearing**; build the tool against the 'ask'/Approve
  gesture path (now present), never a cold requestPermission.
- **DataStreamMapper is in `packages/agent/src/stream/`**, not packages/ui — wire
  there or the route silently never registers.
- **Single-process Vite ONLY**: the Map lookup works because there's one module
  instance. dev/preview-only; never promote this transport to a multi-worker prod.
- **2MB cap enforced on BOTH sides** (Node before delegating, renderer before
  createWritable) so oversize never reaches disk. contentBase64 inflates ~2.7MB
  in-stream — keep MAX at 2_000_000; move bytes to a side-channel GET if it grows.
- Web currently wires native tools only for settings DISPLAY — the write tool
  needs FIRST-CLASS `runtime.mastraTools` registration, easy to half-wire so it
  passes display but never executes.
