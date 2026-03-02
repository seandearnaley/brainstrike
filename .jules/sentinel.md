## 2026-02-28 - Cryptographically Insecure Pseudo-Random Number Generation
**Vulnerability:** Weak fallback for UUID generation using `Math.random()`.
**Learning:** `Math.random()` generates predictable values, making any IDs derived from it susceptible to predictability or collision if they rely purely on the fallback (e.g., when `crypto.randomUUID` is unavailable). Even in fallbacks, developers must rely on `crypto.getRandomValues()` when possible.
**Prevention:** Standardize identifier generation across the codebase by using `generateUUID()` from `@brainstrike/utils`. Ensure the fallback implementation inside `generateUUID()` uses `crypto.getRandomValues()` before falling back completely to `Math.random()`.
## 2025-05-18 - Math.random Predictability for API Request IDs
**Vulnerability:** Weak, predictable fallback generation for UUIDs used as request IDs in API calls.
**Learning:** `Math.random()` generates predictable sequences. When used for IDs on active endpoints (like `mcp/sse-client.ts` passing `requestId`), this risks predictability and collisions.
**Prevention:** Standardize all ID generation across the codebase by importing and using the secure fallback function `generateUUID()` from `@brainstrike/utils`.
