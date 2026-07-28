## Secure UUID generation fails closed
**Vulnerability:** A predictable UUID fallback can expose identifiers to guessing and collisions when secure runtime entropy is unavailable.
**Learning:** `packages/utils/src/crypto-utils.ts` uses `crypto.randomUUID()`, then `crypto.getRandomValues()`, and throws when neither exists; the legacy MCP SSE adapter no longer owns request ID generation.
**Prevention:** Keep callers on `generateUUID()` from `@brainstrike/utils` and never restore a `Math.random()` fallback.

## Prevent unauthorized window creation by background renderer hosts

**Vulnerability:** In apps/desktop, background renderer windows were instantiated without a configured `setWindowOpenHandler` restricting new window creation. This creates a risk where background processes could maliciously or erroneously open unauthorized windows.
**Learning:** This issue is specific to the repository and explicitly noted in our security constraints.
**Prevention:** In apps/desktop, prevent unauthorized window creation by background renderer hosts by explicitly setting `window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`.
## Assistant auth bounds timing-safe comparisons
**Vulnerability:** `crypto.timingSafeEqual` throws when buffer lengths differ, so passing unvalidated request data can turn authentication failure into an exception path.
**Learning:** `apps/desktop/src/assistant-server/auth.ts` rejects non-string, empty, and length-mismatched header values before calling `timingSafeEqual` against the fixed-length per-boot token.
**Prevention:** Keep explicit length validation immediately before timing-safe comparisons and never replace the final secret comparison with ordinary string equality.
## Desktop secrets must fail closed
**Vulnerability:** Desktop API keys were saved as base64 plaintext when Electron `safeStorage` encryption was unavailable, and decrypt failures silently fell back to base64 decoding.
**Learning:** The settings UI already had an `encryption_unavailable` path, but the storage service never threw it; the service fallback weakened stored provider keys instead of refusing the write.
**Prevention:** Desktop secret storage must require `safeStorage.isEncryptionAvailable()` before writes and must return no secret when encrypted payload decryption fails.
## Desktop assistant CORS must stay renderer-bound
**Vulnerability:** The loopback desktop assistant server accepted any `http://localhost:*` Origin, allowing unrelated local web apps to reach provider-backed assistant endpoints.
**Learning:** Loopback binding is not an origin boundary for browser callers; the assistant server carries ambient desktop authority and stored-provider access.
**Prevention:** Keep packaged assistant CORS restricted to Electron's `Origin: null`; only unpackaged dev-server launches may allow the configured renderer origin from `DESKTOP_DEV_RENDERER_URL`.

## Workspace command discovery must not follow directory symlinks
**Vulnerability:** The desktop slash-command filesystem adapter enumerated a symlinked `.brainstrike/commands` directory, allowing project command discovery to traverse outside the mounted workspace root.
**Learning:** Skipping symlink entries during recursive traversal does not protect the scan root itself because `readdirSync` follows a symlink passed as the directory path.
**Prevention:** Pin each scan source as an OS directory handle and traverse every descendant component relative to it with no-follow semantics (`openat` on POSIX; `NtCreateFile` + `RootDirectory`/`OBJ_DONT_REPARSE` on Windows). Path validation followed by path opening is not a security boundary, even with a later device/inode comparison.

## Native enumeration must own the traversal bound
**Vulnerability:** Slash-command traversal applied its entry cap only after the native addon had synchronously materialized an entire untrusted directory in Electron main.
**Learning:** A JavaScript traversal budget cannot bound work already performed across a native boundary; skipped symlinks and unsupported entries must also consume the native enumeration allowance.
**Prevention:** Pass the remaining budget into native directory APIs, stop enumeration at that limit, and return both the raw inspected count and an explicit truncation signal for caller accounting and visible warnings.

## Log listeners must redact before buffering
**Vulnerability:** Structured log arguments and bindings could bypass Pino's top-level serializers and enter desktop diagnostic buffers with nested or operator-configured secrets intact.
**Learning:** Brainstrike's transports and main/renderer log viewers consume different record paths, so redaction at only one sink creates a bypass.
**Prevention:** Redact structured values before transport and listener fan-out, honor configured paths at that shared boundary, and regression-test the listener payload.

## Hook-triggering Git commands must disable both hook systems
**Vulnerability:** Git workbench mutations, status, and working-tree diffs could execute repository-controlled hooks with the desktop user's privileges.
**Learning:** `core.hooksPath` blocks traditional hook files, but Git 2.54 config-managed hooks and executable `core.fsmonitor` bypass it; nominally read-only status and diffs can invoke them while inspecting the index.
**Prevention:** Disable `core.fsmonitor` for status and, before hook-triggering Git commands, also enumerate and disable configured hooks, redirect the traditional hook directory, and regression-test every execution surface that consults the index.

## Bound project hook configs before trust checks
**Vulnerability:** The desktop hook loader read project-controlled hooks files fully into Electron main before checking their approval hash, allowing oversized or special files to exhaust or pin the main process even though their hooks were rejected.
**Learning:** A post-read trust gate protects execution but cannot bound work already performed while acquiring the untrusted bytes, and every approval/load consumer must enforce the same bound.
**Prevention:** Share one nonblocking, descriptor-owned reader across review and load paths; require a regular file within the byte cap and read only its initially observed size before hashing or parsing.

## Memory-only command sessions must stay out of durable tool history
**Vulnerability:** Model-callable command-session tools inherited Mastra transcript and oversized-artifact persistence, so command strings, interactive stdin, cwd values, and PTY output could outlive the memory-only session.
**Learning:** Keeping a process registry in memory is not sufficient when its tool inputs and results cross a framework-owned transcript or artifact seam.
**Prevention:** Give sensitive session tools allowlisted transcript transforms, redact streamed input and guarded error details, page raw results with source-owned continuation cursors, and explicitly exclude their canonical ids from durable artifact settlement.

## Shared IPC resources must bound logical fan-out
**Vulnerability:** File watcher de-duplication bounded native subscriptions but retained unlimited same-renderer logical watch registrations, multiplying MAIN-process state and every event push.
**Learning:** A native-resource cap does not bound the routes, listeners, or identifiers multiplexed over that resource.
**Prevention:** Apply a separate per-owner cap to logical registrations in the same synchronous section that resolves sharing and native capacity.

## Repository-controlled child processes must not inherit provider credentials
**Vulnerability:** Approved project hooks inherited the Desktop main process's complete environment, including provider and Tavily credentials loaded from supported environment files.
**Learning:** Hash approval authorizes the reviewed hook command but does not isolate unrelated ambient authority; stdin redaction cannot protect child-process environment variables.
**Prevention:** Derive the credential deny-set from the canonical provider registry plus Tavily keys, remove those names before spawning repository hooks, and prove ordinary shell variables and the hook event marker remain available.
