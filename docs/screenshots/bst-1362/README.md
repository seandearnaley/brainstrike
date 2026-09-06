# BST-1362 Credential Inventory — live CDT verification

Captured 2026-08-18 from the desktop app running under
`pnpm --filter @brainstrike/desktop dev:agent-debug` (CDP port 9222), driven
over CDP with Playwright. Fresh agent-devtools profile per session; secrets
stored through the real UI flows against the real typed `saveCredential`
bridge.

| File | State |
| --- | --- |
| `01-empty-inventory.png` | Nothing configured: every slot visible at once (six keyed providers + Tavily), canonical vendor env names, muted `Not set` badges, `Set` actions. No dropdown. |
| `02-inline-editor-openai.png` | Inline row editor expanded on OpenAI: autofocused password input, registry `keyFormatHint` hint, copyable `docsUrl` line, Save/Cancel. |
| `03-mixed-stored-env-notset.png` | Mixed states in one frame, sorted Stored → Env → Not set: Google `Stored` with the `…4821 · Saved 8/18/2026` fingerprint and Replace/Remove; Anthropic locked read-only `Env (ANTHROPIC_API_KEY)` (launched with that variable injected); the OpenAI row's amber BST-1361 rename warning (`OPENAI_API_KEY_V2` was injected) — deprecated names never authenticate, so the row stays `Not set`. |
| `05a-delete-flow-stored.png` | Delete flow, before: Tavily key stored through the inline editor (`…93k2` fingerprint), Remove available. |
| `05b-delete-flow-removed.png` | Delete flow, after: the same row back to muted `Not set` with a `Set` action; fingerprint gone. |
