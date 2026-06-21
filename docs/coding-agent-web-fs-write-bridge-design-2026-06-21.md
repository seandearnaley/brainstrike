# Web Assistant FS-Write Renderer↔Node Bridge — Design (2026-06-21)

> P2 of the coding-agent ledger. Resolves "web FS-Access write" — letting the WEB
> assistant write files. Produced by a judge-panel design workflow + verification
> against the branch. **Step 1 (the adapter primitive) is DONE (#PR, commit
> `8bf960fd7`); steps 2–9 below are the bridge build.**

## ⚠️ VERIFICATION CORRECTION (2026-06-21, before building step 2)

Building the bridge began with verifying the design's crux. The verification
**overturned the design workflow's core mechanism** — record this before any build:

1. **Tools CANNOT emit stream/data parts.** A Mastra tool's `execute` returns a
   result; there is no run-event/stream-writer in the tool context (grep found
   none). So the design's "the Node write tool emits a `fs-write-request` data
   part" is **impossible**. The ONLY way a tool gets the browser to act is to
   **SUSPEND** (`packages/agent/src/mastra/agent-runtime.ts:783` `makeApprovalRequiredChunks`).
2. **The suspend chunk already carries what the browser needs:** the
   `tool-approval-required` chunk includes `args` (→ the write request `{path,content}`)
   AND `resumeSchema` (agent-runtime.ts:824-825). So the browser CAN read the
   request from the suspend and perform the FSA write.
3. **But the RESUME currently carries NO result back.** `streamMastraToolApprovalAction`
   → `approveToolCall(options)` passes only `runId` + `toolCallId` + loop options
   (agent-runtime.ts:1400-1417) — **no `resumeData`**. brainstrike reads
   `resumeSchema` (to show the browser) but never PROVIDES `resumeData` on resume.

**Corrected mechanism (replaces "SSE-out + POST-back / pending-Map"):** the web
write tool is `'edit'`-risk → permission gate marks it `'ask'` → it SUSPENDS with
`args={path,content}` + a result `resumeSchema`. The browser reads the args from
the `tool-approval-required` chunk, arms readwrite permission (Approve = user
gesture), performs `WebFileSystemAdapter.writeFileByPath`, and resumes with
**`resumeData = {ok, bytesWritten, created, error}`**. The tool's `execute`, on
resume, reads `resumeData` and returns it (or throws on `!ok`). No separate
pending-Map, no `/api/fs-write` endpoint — it rides the existing approval-resume
channel. This makes step 1's `writeFileByPath` the renderer-side executor, exactly
as built.

**RESOLVED (Mastra docs, context7 `/mastra-ai/mastra`):** Mastra natively supports
the round-trip via a tool's own `suspendSchema`/`resumeSchema` — NOT via
`approveToolCall` (which is the separate approve/decline path). The canonical shape:

```ts
createTool({
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  suspendSchema: z.object({ path: z.string(), content: z.string(), byteLength: z.number() }),
  resumeSchema: z.object({ ok: z.boolean(), bytesWritten: z.number().optional(),
                           created: z.boolean().optional(), error: z.string().optional() }),
  execute: async (inputData, context) => {
    const { suspend, resumeData } = context?.agent ?? {};
    if (!resumeData) {              // first call: hand the write to the renderer
      // (byte-cap check here too — Node side)
      return suspend?.({ path: inputData.path, content: inputData.content, byteLength });
    }
    if (!resumeData.ok) throw new Error(resumeData.error ?? 'web fs write failed'); // no silent success
    return { ok: true, bytesWritten: resumeData.bytesWritten, created: resumeData.created };
  },
});
```

Resume is `agent.resume(runId, resumeData)` (the GENERAL resume, distinct from
`approveToolCall`). So the corrected build:
- The web write tool uses `suspendSchema`/`resumeSchema` (above), NOT `requireApproval`.
- The suspend chunk reaches the browser (same routing as the approval chunk —
  it carries `args`/suspend payload); the browser shows a **write-approval UI**
  whose Approve click is BOTH the FSA `readwrite` user-gesture AND the trigger to
  perform `writeFileByPath` + `agent.resume(runId, {ok,bytesWritten})`. Decline →
  `agent.resume(runId, {ok:false, error:'declined'})` → tool throws.
- A NEW web resume seam wraps `agent.resume(runId, resumeData)` (peer of
  `streamMastraToolApprovalAction`) so the browser's resume POST threads the
  write result as `resumeData`.

The mechanism is now fully verified; no Mastra-capability unknown remains.

### Build progress
- ✅ **Step 1** (`520efba86`): `WebFileSystemAdapter.writeFileByPath` — the renderer-side executor.
- ✅ **Step 2** (`19e02e909`): the **resume seam** — `streamMastraToolSuspendResume`
  wraps `agent.resumeStream(resumeData, {runId, toolCallId})`; PROVEN by a
  live-loop spec (`mastra-tool-suspend-resume.spec.ts`, real agent + real PGlite):
  a tool that `suspend()`s with the request resumes with the result and returns
  it; a `{ok:false}` resume makes it throw (tool.failed, no silent success). This
  was the riskiest part — the mechanism the design workflow got wrong, now
  verified working in our runtime.
- ✅ **Rebased onto the updated integration branch** (+`1986b62bb`): the branch now
  sits on top of #1295 (the `withRuntimeDerivedStreamOptions` resume-tools helper)
  + #1296 + main. The seam's `streamMastraToolSuspendResume` now also applies that
  helper, so the web write tool's `suspend()`-resume rebuilds the Agent WITH the
  native tools + selected model — the same empty-tool-map bug #1295 fixed for the
  approval-resume path is pre-empted here.

### Web-path verification (✅ done — design is viable on the CURRENT web path)
Verified against `apps/web/src/server/`:
- **Web HAS Mastra workflow storage.** `web-mastra-storage.ts` lazily builds ONE
  in-process PGlite store (vector + pg_trgm extensions; dev/preview, in-memory),
  and `buildWebAssistantStream` already routes the initial turn through
  `toAiSdkStyleStream({storage})` and the approval resume through
  `streamMastraToolApprovalAction({storage})`. So `Boolean(storage)` is true →
  `'ask'`/`suspend()` tools are NOT fail-safe-omitted on web. **No storage
  prerequisite — the suspend/resume mechanism works on web today.**
- **Web registers NO native tools yet.** `web-assistant-runtime.ts` resolves the
  runtime + permission policy but never sets `runtime.mastraTools`. So the ONLY
  thing missing is registering the web write tool — exactly P2's job.
- Route: `apps/web/src/app/api/assistant/route.ts` + `assistant-stream-helpers.ts`
  (served via the Vite middleware, NOT Next).

### Remaining (browser-facing + web wiring — the UI half)
- The web write **tool** (`suspendSchema`/`resumeSchema`, suspends with the
  request; the renderer does the write) + multi-registry plumbing + register it on
  `runtime.mastraTools` in `web-assistant-runtime.ts` (where mastraTools is
  currently unset).
- Make the `'tool-call-suspended'` dispatch (agent-runtime.ts:936) emit a
  RESUMABLE chunk (suspendPayload + resumeSchema + runId/toolCallId, NOT the
  current `resumeSupported:false`/failed shape) — co-design the chunk shape WITH
  the browser handler so it isn't built in isolation.
- A THIRD branch in `buildWebAssistantStream` (peer of the approval-resume branch)
  that handles a suspend-resume action → `streamMastraToolSuspendResume({storage})`.
- The browser **write-approval UI** handler: reads the suspend chunk → Approve
  click (the FSA readwrite gesture) → `writeFileByPath` → POST resume with
  `resumeData = {ok, bytesWritten}`. Decline → `{ok:false}`.
- Permission arming at the Approve gesture + tests (web-route integration +
  real-Chrome Playwright). This half is UI-involving and benefits from manual CDT
  verification per the standing directive.

---

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
