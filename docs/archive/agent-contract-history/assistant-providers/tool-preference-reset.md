# Tool-preference reset — evidence

Supports `docs/agents/assistant-providers.md` § "Reset is the remediation, so it is never gated". Why reset is ungated and why it discards undiscovered ids.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5149-5163); append rather than
rewrite.

---

`mcp:tools:reset` uses `replace`: it preserves nothing by definition, so it does
not read the file and is not blocked by the latched fault. This is deliberate.
Reset is the ONLY in-app recovery for a corrupt preferences file — gating it
would leave that user with every remediation blocked and nothing but "edit JSON
in `userData` by hand". A successful reset also CLEARS `toolPreferencesFault`,
because it has just written a readable file; leaving it latched would make the
recovery useless (the file is fine and every later toggle still throws until
restart). BST-1620 owns the *other* recovery case — the user repairs the file
out-of-band and wants the session to notice without a restart.

Reset discards every stored id, including undiscovered servers'. An earlier
revision preserved them by symmetry with the toggle; that was wrong. Reset is an
explicit, labelled discard, not the incidental loss BST-1621 protects against,
and a half-reset that silently leaves entries behind is both surprising and an
unreliable remediation.

## BST-1620 recovery added, 2026-09-30

Reset is no longer the only in-app recovery: explicit Reload tool preferences reads
a repaired or removed file without altering it. Reset remains ungated, deliberate
discard recovery. See `tool-preference-recovery.md` for the new ordering proof.
