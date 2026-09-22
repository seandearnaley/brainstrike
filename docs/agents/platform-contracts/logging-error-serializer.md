# Logging: the error gate, the redaction boundary, host payloads — evidence

Supports `docs/agents/platform-contracts.md` § "LOGGING (PINO V10)".
Read before touching `log-serializers.ts`, the `err`/`error` gate, the `logInternal` redaction pass, or any adapter that logs an unrecognized host frame. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
Error binding keys (`err` and `error`):
- Both keys share one serializer. `error` is the key the overwhelming majority
  of call sites use; leaving it unbound made the two diverge.
- **`logInternal` redacts before Pino.** Every argument passes through
  `redactSensitiveLogValue` first, which copies an Error's non-enumerable
  `message`/`stack` onto a *plain object*. That redacted object — not a live
  `Error` — is what reaches the serializer from every call site. An
  `instanceof Error` gate therefore skips Pino's std handling entirely and
  silently drops `type` plus the flattened cause text from `message`/`stack`.
  Do not narrow the gate to `instanceof` (regressed once; see PR #3025).
- The gate accepts real Errors, cross-realm Errors (`[object Error]`, which
  `instanceof` misses across `node:vm`/worker boundaries), and the redacted
  representation (string `message` **and** string `stack`). It deliberately
  stays narrower than Pino's own `isErrorLike` (`typeof value.message ===
  'string'`): structured failures that merely carry a message — JSON-RPC
  rejections such as `{ code: -32000, message: '...' }` — must reach the
  transport byte-identical.
- **Two gates, one shared core.** `isErrorObject` (`instanceof Error ||
  [object Error]`) is exported from `log-serializers.ts` and used by BOTH
  `redactSensitiveLogValue` and the serializer, so the two can never disagree
  about what an Error object is.
- The `[object Error]` half **must stay inside a try/catch.**
  `Object.prototype.toString` performs `Get(O, @@toStringTag)` and therefore
  runs user code; a throwing getter or a rejecting Proxy would throw from
  `redactSensitiveLogValue`, which runs on every logged argument *outside* the
  try/catch in `logInternal` — so it would escape the log call and mask the
  failure being reported. The tag is also **forgeable**
  (`{ [Symbol.toStringTag]: 'Error' }`); the cost is only empty
  `message`/`name`/`stack` keys, which is an acceptable price for the only
  cross-realm brand check available in a browser-safe package. The serializer then composes a *wider* gate on
  top of it, adding the flattened `message`+`stack` shape. This asymmetry is
  deliberate and load-bearing in both directions:
  - The redactor must not be narrower, or it strips a cross-realm Error's
    diagnostics before the serializer can act — nothing downstream can recover
    non-enumerable fields once dropped.
  - The redactor must not be wider, or a caller's ordinary
    `{ message, stack }` payload gets a spurious `name` bolted on; before
    flattening, those fields are already enumerable and the normal walk copies
    them.
- `pino.stdSerializers.err` **mutates its input**, tagging it with
  `Symbol(circular-ref-tag)` before walking, so a frozen input throws
  `TypeError`. Non-extensible values are serialized via a descriptor-faithful
  copy. A logger that throws while logging an error masks the original failure.
- For anything error-shaped, output must stay byte-identical to bare
  `pino.stdSerializers.err`; `error-serializer.test.ts` pins this against a real
  Pino instance writing to a capture stream.
- **`logInternal` is the only redaction-safe entry point** (ruling, BST-1663).
  The error serializer hoists an error's own enumerable properties into the
  record, but the `token`/`secret`/`password`/`apiKey` serializers are keyed at
  the **top level** only, so a sensitive property hanging off an Error lands at
  `error.token` and they never match it. The only thing that redacts it is
  `redactSensitiveLogValue`, which `logInternal` runs on every argument.
- Do **not** add a second redaction pass inside the serializer. Two redaction
  implementations that can disagree is a worse failure mode than one plus a
  guarded boundary — the leak would then depend on which path a caller took.
- The boundary is enforced, not just documented. `error-serializer.test.ts`
  scans the package **entry point** (`index.ts`, not just `logger.ts`) for any
  exported Pino logger, and drives a real `createLogger(...).error(...)` with a
  token-bearing Error to prove the call actually routes through `logInternal`
  and comes back `[REDACTED]` — a wrapper's *shape* proves nothing about where
  its methods write. Both guards are mutation-checked. The suite also pins the
  un-redacted direct-to-Pino behavior so the hazard stays visible rather than
  theoretical; if a change ever makes direct Pino access redaction-safe, flip
  that test and update this ruling with it.

Sensitive data:
- Auto-redacts: apiKey, password, token, secret, authorization, cookie
- Structured arguments and listener bindings are recursively redacted before transport,
  buffering, or display; transport serializers alone are not a sufficient boundary.
- Add more via redactPaths.
- **Host payloads are never logged, only their shape.** Background-host traffic
  carries user data — the parser host relays source text and ASTs — so a message
  that fails its type guard is described, never dumped:
  `parser-host-manager.ts`'s `summarizeMalformedMessage` logs `messageType` plus
  `keyCount`/`keys`/`type` for an object and `length` for an array (an array's
  keys would be as unbounded as the payload), and nothing else. Every field is
  bounded, because the *shape* is content-controlled too: a mis-serialized frame
  can carry source text in a key or in `type`. Counts are exact; the strings
  behind them are truncated (20 keys, 64 characters). This is a real-fault path,
  not normal traffic: `parser-host-entry` posts `ParserHostParseResponse` frames
  only. Any new host adapter that logs an unrecognized frame follows the same
  rule. Paired tests in `apps/desktop/src/__tests__/main/parser-host-manager.test.ts`:
  "logs a malformed host message at warn as a shape summary, never the payload",
  "bounds the shape summary when the shape itself carries the payload", and
  "summarizes a null, primitive and array frame by shape alone".
