# Failure debug bundle, the download helper, and the two save routes — evidence

Supports `docs/agents/platform-contracts.md` § "DIAGNOSTIC EVENTS (FLIGHT RECORDER P1)".
Read before adding an export surface, changing `downloadBlobFile`, or touching the bundle formatter, elision loop, or secret scrub. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
**Failure debug bundle**: `packages/app-shell/src/diagnostics/debug-bundle.ts`
(collector `collectThreadDebugBundleData` + pure formatter
`formatThreadDebugBundle`, convenience wrapper `buildThreadDebugBundle`),
consumed through the `DebugBundleProvider` seam
(`packages/assistant-ui/src/debug-bundle-context.tsx` +
`packages/app-shell/src/hooks/use-debug-bundle.ts`) by the
`CopyDebugBundleButton` (`packages/assistant-ui/src/copy-debug-bundle-button.tsx`)
on failed assistant messages. That footer offers two deliveries — **Copy**
(clipboard) and **Download** (a `.md` file on disk, BST-946) — each building
its OWN bundle: a second click re-runs `buildThreadDebugBundle` rather than
reusing the first result, so every delivery reflects the data at click time
and there is no cache to go stale. Download is the realistic transport at this
size: bundles run up to the 200 KB budget below, past what a chat box or issue
comment accepts.
Filename + save live in `packages/assistant-ui/src/debug-bundle-download.ts`
(`formatDebugBundleFilename` / `downloadDebugBundleFile`) rather than in the
component module, which is component-only by the Fast Refresh module-boundary
contract (`react-refresh/only-export-components` in `eslint.config.js`; the
split predates that gate and was originally attributed to react-doctor, whose
rule is live but warn-only and gates nothing — see the REACT DOCTOR section in
`docs/agents/ci-quality.md`). The filename is
`brainstrike-debug-bundle-<UTC ISO, colons→hyphens, no millis>[-run-<first 8
chars>].md` — timestamp first so a Downloads folder sorts chronologically,
and colon-free because Windows rejects `:` (an unmangled `toISOString()` in
`anchor.download` does not survive there).

**Agent diagnostics query**: desktop registers the read-risk
`brainstrike.queryDiagnostics` native tool
(`apps/desktop/src/assistant-server/query-diagnostics-tool.ts`) over
`DiagnosticEventsRepository`. `mode=events` returns bounded newest-first rows;
`mode=fingerprints` groups recurring fingerprints with count, first/last seen,
and the latest representative message/source/code/severity. Exact
severity/fingerprint/run/thread and inclusive ISO time filters are shared by
both modes. The schema and repository both hard-cap results at 200, and the
tool applies the native output-character budget after bounding individual
message/stack/context fields. A row/group cap or output-budget cut is visible
through `truncated` and `hint`. The hosted web assistant omits this capability
because its server cannot read browser-local PGlite; it never substitutes a
remote query. The bundle's Download action already satisfies the
save-to-file half of P5 (BST-946), so the native tool does not duplicate file
delivery.

**The diagnostics downloads — filename AND save — go through
`packages/utils/src/browser-download.ts`** (subpath
`@brainstrike/utils/browser-download`; pure-half tests
`packages/utils/src/__tests__/browser-download.test.ts`, DOM-half tests
`packages/assistant-ui/src/__tests__/debug-bundle-download.test.ts` because the utils
package's vitest environment is `node`; the desktop-bridge route is covered in
the node-env file since it needs no DOM). Five export surfaces today:
`formatDebugBundleFilename` / `downloadDebugBundleFile`, `log-viewer.tsx`'s
`brainstrike-logs-….json`, `logging-settings-section.tsx`'s
`brainstrike-errors-…[-recent<N>].ndjson`, the DB explorer's CSV/ZIP
exports (`packages/db-explorer/src/hooks/use-export-handlers.ts` /
`csv-export-utils.ts`), and the file-explorer preview context report
(`packages/hooks/src/use-report-manager.ts`,
`context[-<root>]-….txt`). All five call `downloadBlobFile` for the SAVE half;
a call site that hand-rolls an anchor save is a regression (all of them got a
half wrong, in different ways, before BST-946), and `file-saver` is gone from
the repo entirely — reintroducing it is the same regression. The FILENAME half
is consolidated for all but one surface; the DB explorer still builds names
via its own `generateCSVFilename` (`csv-export-core.ts`) — open work, and the
desktop route makes it matter: main hard-rejects filenames outside
`[a-zA-Z0-9._-]`, which `formatTimestampedDownloadFilename` guarantees but
ad-hoc builders do not.
`downloadBlobFile` resolves `{ path? }` — on the desktop route that is the
file ACTUALLY written (a collision retargets to a ` (n)`-countered name, never
overwrites), so callers that name the file to the user must use it; the anchor
route resolves `{}` because the browser owns the final name.

`formatTimestampedDownloadFilename` builds
`${name}-${UTC ISO, colons→hyphens, no millis}[-${suffix}].${extension}` and is
the single owner of the safe-timestamp rule — callers supply only their own
name/suffix/extension. `name`, `suffix` and `extension` are each sanitized to
`[a-zA-Z0-9._-]`, emptiness is judged AFTER sanitizing (so a suffix of stripped
characters cannot leave a dangling `-`), and a name/extension that sanitizes
away or an invalid `Date` THROWS rather than producing a nameless or
`Invalid Date` download. Do NOT put a raw `toISOString()` in `anchor.download`
in new code. `sanitizeFilenameSegment` is exported for the one caller that must
measure a segment before handing it over (the debug bundle truncates a run id
to 8 characters and wants 8 USABLE ones) — do not keep a private copy of that
charset; two copies that must agree would drift silently.

`downloadBlobFile` is async and has TWO routes, selected by capability (never
`isElectron()`). Desktop: the Electron preload exposes `window.fileExports`
(`file-exports:save-to-downloads` → `apps/desktop/src/ipc-file-exports-handlers.ts`),
and MAIN writes the bytes into the OS Downloads folder with `fs` — no object
URL and no Chromium download item at all, because live CDP probing
(2026-08-03) showed a blob download whose URL is revoked mid-flight can wedge
as a permanently in-progress download item, and wedged items then jam later
downloads for the whole session. Main re-validates the renderer-supplied
filename against the same `[a-zA-Z0-9._-]` charset (no separators, so no
escape from Downloads), and the write is exclusive-create (`O_EXCL`) with a
Chromium-style ` (n)` counter — it NEVER overwrites. A `{ ok: false }` result
becomes a throw at the call site, and a PRESENT-but-malformed bridge throws
rather than falling back to the anchor route — falling back would silently
reintroduce the wedge-prone pipeline (NO SILENT FALLBACKS).
Web (bridge absent): the Blob → object URL → anchor → revoke save, where the
helper owns the object URL's whole lifetime: the revoke is DEFERRED
`DOWNLOAD_BLOB_REVOKE_DELAY_MS` (60 s — the download manager resolves the blob
URL asynchronously in the browser process, and a revoke that wins that race
kills the download after the caller already reported success; the constant's
doc comment records why the old one-macrotask deferral was not a real bound)
on the success path and IMMEDIATE when the click threw — the immediate revoke
on the throwing path is what stops a user retrying a failing export from
pinning one full payload per attempt. Tests of the anchor route must NOT wait
for the revoke on real timers (it is a minute out): either assert the revoke
has not landed in the click's wake scoped to THIS export's URL (the
settings-ui export tests), or use fake timers and drain with
`advanceTimersByTime(DOWNLOAD_BLOB_REVOKE_DELAY_MS)` before restoring a
mocked `URL.revokeObjectURL` (the debug-bundle test). With neither bridge nor
DOM it THROWS rather than no-opping.
The button's phase machine tags every non-idle phase with its action
(`copy` | `download`) so one action's spinner/result/error never appears on
the other's button, and both failure paths render inline (`Copy failed: …` /
`Download failed: …`) in an `aria-live` region. A destination picker (File
System Access `showSaveFilePicker`) was deliberately NOT added — exports go to
the Downloads folder on both routes without prompting. (**CORRECTION
(2026-09-21):** `DEBUG_BUNDLE_FORMAT_VERSION` is **2** today
(`packages/app-shell/src/diagnostics/debug-bundle.ts`), and the golden snapshot
renders `bundle_format: 2`. The mechanism below is unchanged.)
`DEBUG_BUNDLE_FORMAT_VERSION = 1` is stamped in
the rendered header (`bundle_format: 1`) so future format changes are
detectable by consumers. Bounded to `DEBUG_BUNDLE_DEFAULT_MAX_BYTES` (200,000
bytes measured via `TextEncoder`, byte length not char length); when over
budget the formatter elides deterministically in three stages (oldest
non-protected transcript messages, then tool-result bodies down to a 200-char
preview, then run-event metadata) and always appends a visible `## Elision
log` footer naming what was cut — it never throws and never elides silently.
Redaction is key-name-based (`redactSensitiveLogValue`, matching
`isSensitiveLogKey`) applied twice: once at capture time
(`logRecordToDiagnosticEvent`'s context) and again over the whole bundle data
object at format time as a belt-and-braces pass — a secret value under an
innocuous key (e.g. `{ note: 'password is sk-live-123' }`) was a known gap in
both passes since neither is value-based. That gap is now partly closed: after
the key-name pass and the elision loop, `formatThreadDebugBundle` runs
`scrubLikelySecretValues` (`packages/app-shell/src/diagnostics/secret-scrub.ts`)
over the final rendered Markdown string — a value-SHAPE scan (API key/token
prefixes, JWTs, Bearer headers, PEM private keys, DB connection-string
credentials) independent of key names. This is the single choke point every
`formatThreadDebugBundle` return path flows through (including the
over-budget/elision-exhausted path), so it covers `buildThreadDebugBundle`
too. Each match is replaced with `[redacted-secret:<kind>]`; when anything was
redacted a final `_Secret scan: <N> value(s) redacted (<kinds>)._` line is
appended. High-precision patterns only — this is a belt-and-braces net for a
specific set of secret shapes, not a general-purpose scanner.

**Paired tests**: `packages/utils/src/__tests__/diagnostic-events.test.ts`,
`packages/utils/src/__tests__/diagnostic-event-writer.test.ts`,
`packages/db/__tests__/migration-073-diagnostic-events.test.ts`,
`packages/db/__tests__/diagnostic-events-repository.test.ts`,
`packages/app-shell/src/__tests__/diagnostic-sink-bridge.test.tsx`,
`apps/desktop/src/__tests__/logging-durable-record.test.ts` (durable-record
push channel), `apps/desktop/src/__tests__/renderer/main.test.tsx`
(hidden-renderer transport normalization), `packages/ui/src/__tests__/error-boundary.test.tsx`,
`packages/app-shell/src/__tests__/debug-bundle.test.ts` (includes a golden
snapshot), `packages/app-shell/src/__tests__/secret-scrub.test.ts`,
`packages/assistant-ui/src/__tests__/copy-debug-bundle-button.test.tsx`,
`packages/assistant-ui/src/__tests__/debug-bundle-download.test.ts`,
`packages/app-shell/src/__tests__/use-debug-bundle.test.ts`.
