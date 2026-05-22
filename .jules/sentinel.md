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
