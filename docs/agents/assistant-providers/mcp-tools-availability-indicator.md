# Settings tools-availability indicator — evidence

Supports `docs/agents/assistant-providers.md` § "Settings tools-availability indicator". Why the indicator reports only a settled failure, and what widening it would require.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5037-5071); append rather than
rewrite.

---

`connected` is a TRANSPORT fact — the handshake succeeded, not that `tools/list`
returned. The Settings group indicator previously showed one green dot for both,
which is why the packaged E2E could not rely on the row either.

`resolveMcpToolsAvailability` (`packages/settings-ui/src/settings/tools/mcp-tools-availability.ts`)
derives the distinction from the host snapshot the row already has. It is pure
and snapshot-only, so it introduces no second source of truth for connection
state.

**It reports only what it can PROVE.** `tools-unavailable` requires
`catalog.errors.tools` — a positive, settled failure signal that cannot be
produced by a query still in flight. Everything else is `available`.

That narrowness is deliberate and must not be widened without first adding a
settled-vs-pending signal to the snapshot. `McpServerActor` publishes
`state: 'connected'` as soon as the handshake completes, carrying whatever
`client.catalog()` returns SYNCHRONOUSLY at that instant
(`apps/desktop/src/mcp/server-actor.ts:497`), then fills the catalog in later
through a `watchCatalog` subscription (`:481-491`). So "no catalog" and "tools
absent" are the NORMAL state of every healthy server between handshake and
enumeration, on every launch. Reporting them would flash a warning on servers
that are enumerating perfectly — and an indicator that cries wolf is worth less
than no indicator. A server advertising no tools capability at all
(`features.tools === false`) is likewise healthy and never flagged.

The degraded dot uses the semantic `warning` token, NOT the `yellow-500` that
already means connecting/authorizing: a user who cannot tell "still working,
wait" from "settled, and it will never contribute tools" has lost the only
actionable distinction. It carries an `aria-label` and a
`data-tools-availability` attribute, because colour alone is not a signal and a
fill-class assertion in E2E is as fragile as the row state it replaces.

Closing the absence gap — reporting a server whose catalog never arrives at all
— needs that pending/settled discriminator on the snapshot, and remains open on
BST-1632 (follow-up to BST-1603).
