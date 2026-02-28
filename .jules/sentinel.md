## 2024-05-24 - Cryptographically Insecure Pseudo-Random Number Generation
**Vulnerability:** Weak fallback for UUID generation using `Math.random()`.
**Learning:** `Math.random()` generates predictable values, making any IDs derived from it susceptible to predictability or collision if they rely purely on the fallback (e.g., when `crypto.randomUUID` is unavailable). Even in fallbacks, developers must rely on `crypto.getRandomValues()` when possible.
**Prevention:** Standardize identifier generation across the codebase by using `generateUUID()` from `@brainstrike/utils`. Ensure the fallback implementation inside `generateUUID()` uses `crypto.getRandomValues()` before falling back completely to `Math.random()`.
