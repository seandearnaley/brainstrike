# Read-only in-session tool-preference recovery

Supports `docs/agents/assistant-providers.md` § "Reset is the remediation, so it is never gated" and § "Both writers take one lock".

## BST-1620, 2026-09-30

An invalid or unreadable preferences file disables the registry and latches a fault.
Repairing that file did not clear the fault until restart or rediscovery. Merely
rereading in the write guard is unsafe: the all-disabled registry would overwrite
the repaired choices when the next toggle merges it back to disk.

Settings now offers explicit **Reload tool preferences** through visible-UI-only
`mcp:tools:reloadPreferences`. It calls `loadToolPreferences` directly through the
read-only recovery helper; it does not reuse the discovery projection's retirement
writer. The recovered bytes, unknown/undiscovered ids, version and timestamp remain
unchanged. Removing the file restores configuration defaults without recreating it.

Recovery retains the most recent complete discovery/config snapshot because the
faulted registry's enablement is not default authority. Rebuilding that discovery
restores wildcard/exclusion defaults before overlaying saved choices. An id in both
lists stays disabled. Invalid/unreadable rereads fail closed and leave writes blocked;
zero-tool catalogs still reread the file. Explicit reset remains the separate discard.

Recovery runs on the non-reentrant config-operation queue, then takes the shared
file lock. It validates the lifecycle and projected authority epoch before reading
and again before any registry change. A config replacement, factory reset or shutdown
retiring the read rejects visibly. The discovery projection now holds the same lock
through rebuilding and notifying, so an earlier read cannot publish after recovery.
Config changes still retire only under their existing configured-server policy;
recovery itself has no retirement authority. Failed factory reset restores the retained
discovery snapshot together with the original fault and tool state.

The paired recovery suite uses the real registry and preference parser/writer with an
in-memory filesystem. It asserts exact byte retention, configured defaults, preserved
unknown ids on the first later write, invalid/unreadable failures, zero tools, overlap
precedence, notification timing, reset/toggle ordering and config/factory-reset races.
The existing persistence and write suites guard the independent BST-1621/BST-1623 fixes.

## Scope boundary

The pre-existing ordinary config projection applies disabled ids before enabled ids,
so a malformed-in-intent but schema-valid overlap ends enabled on that separate path.
Recovery deliberately chooses disabled on overlap; changing normal rediscovery precedence
is a separate decision. This slice does not claim to fix that existing discrepancy.

Settings exposes the reload action by bridge capability, including an empty tool
catalog. Its pending state covers both IPC and the subsequent catalog/stat refresh.
Preference fault text is separate from config, load and operation failures: successful
recovery clears only its own feedback, and request generations reject older UI reads.
The renderer operation test and `unified-tools-settings.test.tsx` cover the bridge,
visibility, failure, pending state and stale-response ordering.

A rejected toggle can duplicate the same latched fault in operation feedback.
Successful recovery clears that exact duplicate as well as the preference banner.
Desktop removes only the exact current channel's Electron invoke wrapper; shared
Settings knows no Electron channel syntax. The action captures its known fault
before awaiting, so a late refusal cannot resurrect a fault already recovered.
Different error messages, including ones merely containing the fault text, stay
visible. Superseded catalog reads join the latest read, keeping recovery pending
until that read settles and clearing stale retry feedback only after success.
Renderer adapter and Settings tests pin these races and the near-match refusal.


## Initial review follow-up, 2026-09-30

PR #3446's initial review identified an unnecessary retry when preference reload was
queued behind a config operation: its authority epoch was captured before that earlier
operation completed. Recovery now captures after joining the queue; concurrent watch
changes or lifecycle cleanup still retire a recovery before it can publish. Tests retain
the in-flight config/reset fences and cover reload queued behind successful config work.

Invalid config loads preserve the previous projection without bumping authority. Failed
discovery commits an empty projection. Both remain recoverable and have explicit tests.
A rejected authority replacement is different: host runtime can commit new servers and
then reject OAuth cleanup. Recovery must not trust the old discovery snapshot in that
case. The projection fence remains closed, with specific advice: "Save a valid MCP
configuration or re-select its file in Settings before reloading tool preferences."
The editor's read-only Reload and server Refresh buttons do not reapply authority. Paired tests cover rejection before and after an empty config commit,
prove preferences are not read or rewritten while unsynchronized, and retry successfully
after a complete projection. No unsafe rollback of the authority epoch was added.

Factory-reset snapshot cloning is retained. Discovery copies only description and schema
from wire tool metadata, not executable tool definitions. `server-actor.ts` and
`core-server-features.ts` call `parseMcpHostOperationResult`, which first recursively
rejects non-JSON values (functions, nonplain prototypes, accessors and cycles), then
parses the SDK `ListToolsResultSchema`. Resolved server config is schema-parsed and
cloned before host replacement. Registry registration creates metadata records;
toggles change only their enabled field. A nested JSON-schema reset/restore/recovery
regression passes. Retaining a mutable discovery reference would weaken snapshot
isolation without resolving a reachable new cloneability failure.

The same review separates successful reload IPC from its follow-up view refresh:
old reload failures clear when IPC succeeds, while a failed stats/catalog refresh
stays visible as a load error. Pending state and onToolsChanged still wait for the
current refresh. When live-query owns catalog rows, that refresh reads only stats
rather than a second unused tool list. Tests cover live-query notification races,
failed refresh after successful retry, and the retained single-error precedence:
a config failure reappears after the higher-priority action recovers. The exact
fault comparison comment now names its main-process/adapter provenance.
