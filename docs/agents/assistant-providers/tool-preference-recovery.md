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
