## 2026-02-28 - Cryptographically Insecure Pseudo-Random Number Generation
**Vulnerability:** Weak fallback for UUID generation using `Math.random()`.
**Learning:** `Math.random()` generates predictable values, making any IDs derived from it susceptible to predictability or collision if they rely purely on the fallback (e.g., when `crypto.randomUUID` is unavailable). Even in fallbacks, developers must rely on `crypto.getRandomValues()` when possible.
**Prevention:** Standardize identifier generation across the codebase by using `generateUUID()` from `@brainstrike/utils`. Ensure the fallback implementation inside `generateUUID()` uses `crypto.getRandomValues()` before falling back completely to `Math.random()`.
## 2025-05-18 - Math.random Predictability for API Request IDs
**Vulnerability:** Weak, predictable fallback generation for UUIDs used as request IDs in API calls.
**Learning:** `Math.random()` generates predictable sequences. When used for IDs on active endpoints (like `mcp/sse-client.ts` passing `requestId`), this risks predictability and collisions.
**Prevention:** Standardize all ID generation across the codebase by importing and using the secure fallback function `generateUUID()` from `@brainstrike/utils`.

## 2025-01-22 - Prevent unauthorized window creation by background renderer hosts

**Vulnerability:** In apps/desktop, background renderer windows were instantiated without a configured `setWindowOpenHandler` restricting new window creation. This creates a risk where background processes could maliciously or erroneously open unauthorized windows.
**Learning:** This issue is specific to the repository and explicitly noted in our security constraints.
**Prevention:** In apps/desktop, prevent unauthorized window creation by background renderer hosts by explicitly setting `window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`.
## 2026-04-08 - Unhandled length constraints in timingSafeEqual
**Vulnerability:** Use of `crypto.timingSafeEqual` without checking buffer lengths can lead to a Denial of Service (DoS) or 500 Internal Server Error, as differing lengths throw an unhandled `TypeError`.
**Learning:** Even when comparing outputs of cryptographic hashes (like SHA-256 HMACs) which should logically be the same length, relying solely on the crypto algorithm's output size is an insecure pattern. Any future change to the algorithm or bug in the inputs could trigger a crash that leaks application state or causes a DoS.
**Prevention:** Always explicitly check the lengths of buffers before calling `timingSafeEqual` (e.g., `a.length !== b.length`), and handle the mismatch gracefully (e.g., return 401 Unauthorized).
## 2026-05-22 - Keep telemetry API key comparisons timing-safe
**Vulnerability:** API key validation compared SHA-256 HMAC digests with `timingSafeEqual`, which is the right primitive but throws on mismatched buffer lengths. In the current collector both `providedHmac` and `apiKeyHmac` are generated internally with SHA-256 `.digest()` output, so they are fixed 32-byte buffers under normal operation and the length-mismatch path is defense-in-depth rather than an active critical exploit.
**Learning:** Do not make raw secret string comparisons, and do not call `timingSafeEqual` on buffers whose lengths might diverge. For fixed-length HMAC digests, keep the comparison helper self-documenting so future algorithm or input changes cannot reintroduce an early-return or thrown-error path.
**Prevention:** Compare internally generated HMAC digests through a small helper that normalizes mismatched lengths to an expected-length buffer before calling `timingSafeEqual`, then rejects if the original lengths differed.
## 2026-06-13 - Desktop secrets must fail closed
**Vulnerability:** Desktop API keys were saved as base64 plaintext when Electron `safeStorage` encryption was unavailable, and decrypt failures silently fell back to base64 decoding.
**Learning:** The settings UI already had an `encryption_unavailable` path, but the storage service never threw it; the service fallback weakened stored provider keys instead of refusing the write.
**Prevention:** Desktop secret storage must require `safeStorage.isEncryptionAvailable()` before writes and must return no secret when encrypted payload decryption fails.
## 2026-07-09 - Desktop assistant CORS must stay renderer-bound
**Vulnerability:** The loopback desktop assistant server accepted any `http://localhost:*` Origin, allowing unrelated local web apps to reach provider-backed assistant endpoints.
**Learning:** Loopback binding is not an origin boundary for browser callers; the assistant server carries ambient desktop authority and stored-provider access.
**Prevention:** Keep packaged assistant CORS restricted to Electron's `Origin: null`; only unpackaged dev-server launches may allow the configured renderer origin from `DESKTOP_DEV_RENDERER_URL`.

## 2026-07-11 - Workspace command discovery must not follow directory symlinks
**Vulnerability:** The desktop slash-command filesystem adapter enumerated a symlinked `.brainstrike/commands` directory, allowing project command discovery to traverse outside the mounted workspace root.
**Learning:** Skipping symlink entries during recursive traversal does not protect the scan root itself because `readdirSync` follows a symlink passed as the directory path.
**Prevention:** Pin each scan source as an OS directory handle and traverse every descendant component relative to it with no-follow semantics (`openat` on POSIX; `NtCreateFile` + `RootDirectory`/`OBJ_DONT_REPARSE` on Windows). Path validation followed by path opening is not a security boundary, even with a later device/inode comparison.

## 2026-07-11 - Native enumeration must own the traversal bound
**Vulnerability:** Slash-command traversal applied its entry cap only after the native addon had synchronously materialized an entire untrusted directory in Electron main.
**Learning:** A JavaScript traversal budget cannot bound work already performed across a native boundary; skipped symlinks and unsupported entries must also consume the native enumeration allowance.
**Prevention:** Pass the remaining budget into native directory APIs, stop enumeration at that limit, and return both the raw inspected count and an explicit truncation signal for caller accounting and visible warnings.

## 2026-07-13 - Log listeners must redact before buffering
**Vulnerability:** Structured log arguments and bindings could bypass Pino's top-level serializers and enter desktop diagnostic buffers with nested or operator-configured secrets intact.
**Learning:** Brainstrike's transports and main/renderer log viewers consume different record paths, so redaction at only one sink creates a bypass.
**Prevention:** Redact structured values before transport and listener fan-out, honor configured paths at that shared boundary, and regression-test the listener payload.

## 2026-07-15 - Hook-triggering Git commands must disable both hook systems
**Vulnerability:** Git workbench mutations, status, and working-tree diffs could execute repository-controlled hooks with the desktop user's privileges.
**Learning:** `core.hooksPath` blocks traditional hook files, but Git 2.54 config-managed hooks and executable `core.fsmonitor` bypass it; nominally read-only status and diffs can invoke them while inspecting the index.
**Prevention:** Disable `core.fsmonitor` for status and, before hook-triggering Git commands, also enumerate and disable configured hooks, redirect the traditional hook directory, and regression-test every execution surface that consults the index.

## 2026-07-18 - Bound project hook configs before trust checks
**Vulnerability:** The desktop hook loader read project-controlled hooks files fully into Electron main before checking their approval hash, allowing oversized or special files to exhaust or pin the main process even though their hooks were rejected.
**Learning:** A post-read trust gate protects execution but cannot bound work already performed while acquiring the untrusted bytes, and every approval/load consumer must enforce the same bound.
**Prevention:** Share one nonblocking, descriptor-owned reader across review and load paths; require a regular file within the byte cap and read only its initially observed size before hashing or parsing.

## 2026-07-21 - Memory-only command sessions must stay out of durable tool history
**Vulnerability:** Model-callable command-session tools inherited Mastra transcript and oversized-artifact persistence, so command strings, interactive stdin, cwd values, and PTY output could outlive the memory-only session.
**Learning:** Keeping a process registry in memory is not sufficient when its tool inputs and results cross a framework-owned transcript or artifact seam.
**Prevention:** Give sensitive session tools allowlisted transcript transforms, redact streamed input deltas, page raw results with source-owned continuation cursors, and explicitly exclude their canonical ids from durable artifact settlement.
