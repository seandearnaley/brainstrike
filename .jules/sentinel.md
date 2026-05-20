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
## 2025-02-14 - Fix API Key Timing Attack Vulnerability
**Vulnerability:** The queue telemetry collector used `timingSafeEqual` for API key validation but returned early when the provided HMAC length did not match the expected length.
**Learning:** Returning early before `timingSafeEqual` based on a length check reintroduces a timing leak, allowing an attacker to determine the length of the expected hash/secret. Furthermore, `timingSafeEqual` will throw an unhandled `TypeError` if lengths differ, leading to a potential DoS.
**Prevention:** When lengths differ, execute a dummy constant-time comparison (e.g., `timingSafeEqual(expected, expected)`) to ensure the function executes in constant time before returning the failure, avoiding both the DoS and the timing leak.
