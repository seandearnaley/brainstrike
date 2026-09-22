# Persistent command session tools — evidence

Supports `docs/agents/assistant-providers.md` § "Programmatic orchestration decision". The two-tool risk split and the Terminal bridge paging bounds.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5570-5607); append rather than
rewrite.

---

Persistent commands use two deferred model tools, not six operation-specific
definitions: `inspectCommandSessions` owns read-risk list/read, while
`manageCommandSession` owns execute-risk start/write/stop/remove. Each schema is
a provider-compatible root object containing a nested discriminated `operation`
union. This prevents models from filling irrelevant action fields while keeping
the critical request unchanged; together the two deferred definitions add 809
tokens to the pre-session eager baseline. A single mixed-risk tool is forbidden
because it would either hide harmless inspection behind execute approval or expose
process control as read; top-level schema unions are forbidden because hosted
providers require a root object. Plan mode keeps inspection and omits
management. Inventory pages continue with `offset`, and PTY reads continue with
the exact returned `nextCursor`; both raw result shapes stay below a 5,500-byte
UTF-8 producer ceiling. Their canonical ids are also explicitly excluded from
durable artifact settlement so a hook envelope cannot create a seven-day copy.
Target-aware transcript transforms retain safe action, session, cursor, and
length metadata but redact command strings, cwd, stdin, input deltas, PTY
output, and guarded error messages/reasons before persistence. The built-in local
provider gets neither definition because it has no deferred-discovery path and
would otherwise pay both schemas eagerly.
Desktop registers the capability; Web has no desktop registry, uses the explicit
`WEB_NATIVE_TOOL_IDS` UI/request partition, and therefore exposes neither tool.

The desktop Terminal surface exposes those process-owned sessions through the
capability-gated `window.commandSessions` bridge. Its list/read/write/stop/remove
operations always include the durable workspace root id; the manager rejects a
session owned by another root with the same not-found error. Reads are paged at
32,768 UTF-16 code units with an advancing absolute cursor, explicit `hasMore`,
and the manager's gap/truncation signal. The manager applies that limit while
decoding retained blocks, before joining the page, and never splits a surrogate
pair. IPC retains a fail-loud 32,768-unit assertion; it never materializes and
then silently trims a larger manager result. The same manager-side page bound
applies to the model inspection tool. The renderer retains at most 128 KiB of
visible output. This bridge does not add a second process registry, persist the
command/cwd/environment/output, or exist on Web. Because the manager lives in
Electron main, the inventory reattaches after a renderer reload while normal
shutdown, factory reset, and root removal still reap it through the existing
lifecycle.

