# Tool-preference write precedence — evidence

Supports `docs/agents/assistant-providers.md` § "Write precedence: read → refuse → merge". The merge/replace intents, the pre-mutation read, and the version stamp rule.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5114-5145); append rather than
rewrite.

---

`applyToolPreferenceMutation` (`apps/desktop/src/mcp/tool-discovery.ts`) takes a
`ToolPreferenceWriteIntent`:

| Intent | Caller | Reads first | Refuses on `invalid`/`unreadable` | Preserves undiscovered ids |
| --- | --- | --- | --- | --- |
| `merge` | `mcp:tools:enable` / `disable` | yes | **yes** | **yes** |
| `replace` | `mcp:tools:reset` | no | no | no |

`merge` seeds from the stored file (`enabledTools` first, then `disabledTools`,
so an id in both lands disabled — the schema permits the overlap and
re-enabling a tool the user turned off is the harmful direction to guess in),
then overlays this run's registry. A `merge` into a file that could not be read
would degrade into exactly the whole-file replace BST-1623 fixes, so it throws
instead. That is NOT the latched session fault (below): the projection pass can
read the file cleanly and the file break afterwards, so the merge reads fresh.

**The save path retires nothing and has no notion of what "retired" means.** It
only declines to drop what it did not see. Retirement is the projection path's
job, keyed on a server's removal from the MCP config (BST-1621) — never on a
failed discovery, in either path. Do not add a second retirement rule to the
save path; the single authority is what keeps the two writers from drifting.

**The read happens BEFORE the mutation.** A refused write must not leave the
live registry changed: `filterEnabledServerTools` consults that registry for
assistant runs, so mutating it behind a rejected IPC is BST-1615's "the UI says
it worked" defect one layer up. This also keeps the registry snapshot
synchronous with the mutation — there is no `await` between them, so a
concurrent re-discovery cannot be folded into the write.

**The version stamp is a constant, not an echo.** The body serialised is always
the shape this build emits; echoing a newer file's stamp would mark v1-shaped
data as already migrated and no future migration could detect it.
