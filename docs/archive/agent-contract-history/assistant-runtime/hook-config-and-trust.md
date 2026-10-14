# Hook config loading and the trust spine — evidence

Supports `docs/agents/assistant-runtime.md` § "TOOL-LIFECYCLE HOOKS (Claude-Code-style)".
Read before changing config loading, the project-hook SHA-256 trust gate, stdin redaction, or the credential-isolated child environment.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 3961-4013), extracted verbatim.

**Malformed config = disable-with-visible-error (NOT throw-at-load).**
`loadHooksConfig` returns `{hooks, errors, sources}`; a malformed/untrusted file
contributes ZERO hooks (fail-CLOSED) AND records a `HookConfigError` surfaced on
THREE channels (`logger.error`, a `hook.notice(failed)` run event via
`reportConfigErrors`, the Hooks settings banner). Never throw at load — that
would brick every run over a config typo and hand a malicious repo a DoS. This is
loud + fail-closed, the opposite of a silent fallback.

**Security spine (trust gate).** Global hooks (`~/.brainstrike/hooks.json`, the
user's own machine) run without approval. **Project** hooks
(`<root>/.brainstrike/hooks.json`, per mounted desktop root) run ONLY after a
per-root approval **pinned to the file's SHA-256**. The trust store
(`packages/app-state/src/stores/hook-trust-store.ts`, persisted,
factory-reset-registered) records `{rootId → {approvedSha256, approvedAt}}`. The
store resolves its platform storage through a local deferred state-storage
proxy, preserving the `persist` API across optimized chunk cycles and retrying
resolution on a later hydration without defaulting trust open. The
renderer only ATTESTS approved hashes over the wire (`HookTrustRequest`); the
server independently RE-READS + RE-HASHES disk (`trust.ts` `resolveTrustedRoots`)
and runs a root's hooks only when `sha256(disk) === approvedSha256`. The trust
hash is over the RAW file BYTES (`sha256OfBuffer`), and the approve-time review
(`ipc-hooks-handlers.ts`) hashes those same bytes — never a utf8-decoded string,
which would diverge for BOM/non-utf8 bytes and silently void an approval. Trust
+ parse come from ONE read (`loadHooksConfig` reads the bytes once, hashes them,
and parses those same bytes only when trusted — no read-vs-hash TOCTOU window). A
changed file → untrusted (re-approve). A project config's descriptor is accepted
only after a nonblocking open proves it is a regular file of at most
`MAX_HOOKS_CONFIG_BYTES`; its initially observed bytes are the only bytes read.
The loader and approve-time review share this reader, so oversized/special files
produce a visible error before hashing. Keyed by durable `rootId`, never raw path.
Stdin payloads are secret-redacted before spawn (`executor.ts` `redactSecrets`,
mirrors the logger redact key set). The hook keeps ordinary parent shell/runtime
variables, but `createCredentialIsolatedChildEnvironment` removes every provider
and Tavily credential name derived from the same canonical registries used by
desktop environment-file loading before hooks and non-interactive command/skill
children spawn. This boundary is required even for SHA-256-approved project
hooks: approval authorizes the reviewed command, not ambient disclosure of
unrelated Brainstrike credentials. Scope: interactive terminal/command-session
PTYs and the LSP child still inherit the full parent environment; those
human-controlled/runtime-support processes are separate trust decisions.

**Config paths (D6):** global `~/.brainstrike/hooks.json` (new home-dotfile, for
discoverability); per-root `<root>/.brainstrike/hooks.json`. Merge order:
global-first, then roots in mounted order; each loaded hook is tagged with its
source `cwd`/`rootId` (global hooks' cwd = the MAIN root — client-declared
`activeRootIds[0]`, `created_at` fallback; see "WORKSPACE ROOT IDENTITY" in
`docs/agents/workspace-context.md`).

**Threading:** `RuntimeData.hookRunner` (trusted, agent-only, never serialized —
mirrors `localLlmHostClient`; preserved by `resolveRuntimeConfiguration`'s spread)
+ `RuntimeData.hookTrustRequest` (wire). The server STRIPS any client-supplied
`hookRunner` and injects the server-built one (closure over `HookManager`).

