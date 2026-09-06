# BST-1356 — OpenAI (ChatGPT) credential row

Captured from the **real Electron renderer** via `pnpm --filter @brainstrike/desktop dev:agent-debug`
(CDP on 127.0.0.1:9222), driving Settings → API Keys with dispatched mouse input.

## `01-connect-cta.png`

The disconnected state, rendered live. Shows the whole treatment:

- `Connect` (loopback/browser) plus the `Use a device code` alternative.
- The `Subscription sign-in` status badge.
- `Sign-in only — no environment variable` in the env-var column.
- The personal-use notice required by legal gate constraint 4, verbatim:
  *"Uses your own ChatGPT subscription for personal use. Commercial or
  multi-user serving requires platform API keys."*
- A `How sign-in works` link to OpenAI's Codex auth docs.
- **No** Set / Replace / Remove affordance — confirmed in the live DOM: every
  other provider row exposes a `credential-set-<id>` test id and this row does
  not.

## Why the other three states are not here

`window.providerAuth` is exposed through Electron's `contextBridge`, which makes
it **frozen and non-configurable**. Verified live:

```
Object.isFrozen(window.providerAuth)                      -> true
Object.getOwnPropertyDescriptor(window,'providerAuth').configurable -> false
mutate a method in place                                   -> silently no-ops
Object.defineProperty(window,'providerAuth',…)             -> throws
```

That is a genuine security property (a compromised renderer cannot swap the
auth bridge), and it means the renderer **cannot** be made to render a fake
`connected` / `reconnect_required` state. Those states are produced only by the
main-process engine holding a real credential, so capturing them requires a
real ChatGPT account:

| State | Capturable without an account? |
| --- | --- |
| `disconnected` (connect CTA) | Yes — captured here. |
| `awaiting_browser` | Yes, but `start()` really opens the system browser at OpenAI. |
| `awaiting_device_code` | Only by making a **real** device-authorization call to OpenAI. |
| `connected` | No — requires a real signed-in account. |
| `reconnect_required` | No — requires a real account with a dead refresh token. |

The device-code and browser flows are side-effectful external API calls, which
this repo's AGENTS.md requires explicit confirmation for, so they were not run
to produce screenshots. All five states are covered by the jsdom tests in
`packages/settings-ui/src/settings/secrets/__tests__/credential-inventory-oauth.test.tsx`,
and the live sign-in walkthrough is in the PR's User testing instructions.

## Defects this live pass caught (both fixed)

Neither was reachable from jsdom — this is why the live pass was worth running.

1. **Badge contrast, ~1.16:1.** The status badge omitted `variant`, so it got
   `Badge`'s default **solid primary** background while overriding only the text
   colour to `text-muted-foreground` — muted grey on solid blue. Measured live:
   `bg=rgb(52,104,178)` / `fg=rgb(124,113,106)`. Fixed by using
   `variant="outline"` (matching the sibling `KeySourceBadge` treatments), and
   re-measured live at **4.74:1**, above the WCAG AA 4.5:1 threshold.
2. **Provider name truncated.** `"OpenAI (ChatGPT)"` needs 118px in an 88px
   cell, rendering as `"OpenAI (Ch…"` — ambiguous with the plain `"OpenAI"` row
   immediately above. Added `title` so the full name is available on hover.
   The column width itself is shared table layout and was left alone.
