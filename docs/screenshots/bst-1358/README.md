# BST-1358 — Provider Hub

Captured live over CDP against the running Electron app
(`pnpm --filter @brainstrike/desktop dev:agent-debug`, DevTools on 9222), from a
profile with **no stored credentials and no provider env vars** — the genuine
first-run state. No mocks or fixtures.

| File | State shown |
| --- | --- |
| `01-empty-state-recommendations.png` | First run: "Connect your first provider" offering the top three registry-priority providers, above cards grouped Hosted / Gateway / Local / Browser. The nav shows **Providers** + **Model Catalog** and no **API Keys**. |
| `02-api-key-card-expanded-disconnected.png` | An `api_key` card expanded while disconnected: the per-provider credential row, the docs link, and **Test connection disabled** — there is nothing to probe yet. |
| `03-bedrock-card-region-and-auth-mode.png` | The `aws` card's editor, composed from the Credential Inventory: **API key / AWS profile** modes, bearer-key field, and the `us-east-1` region field. |
| `05-api-key-card-invalid-verdict.png` | A key was saved and the probe fired **without clicking Test connection** — the auto-probe half of the chaining flow. The card reads Stored + Connected with a `…last4` fingerprint, and the verdict is **Invalid key · HTTP 401** (a deliberately bogus key, so the real API answered 401). The model section is visible because the card was already expanded to type the key — NOT because of chaining: an `invalid` verdict does not open models, which `providers-settings.test.tsx` pins. |
| `06-model-expansion-recommended-first.png` | Provider-scoped model toggles, recommended ordered first. |
| `07-disconnected-clears-verification.png` | After **Remove**: back to "Not connected", the verdict is gone rather than left vouching for a deleted credential, Test connection is disabled again, and the first-run panel returns. |
| `08-subscription-card-sign-in.png` | The `oauth_subscription` card (`openai-codex`, BST-1356): a **Subscription sign-in** badge instead of a key source, a row reading "Sign-in only — no environment variable" with **Connect** / **Use a device code**, the personal-use notice, and its models. No key field anywhere, and it is absent from the "add a key" shortlist. |

## Not captured, and why

`verified` and `verified_limited` need a real working credential (and, for
`verified_limited`, a permission-scoped or rate-limited one). Rather than stage a
fake, those are covered by assertion:
`provider-verification-presentation.test.ts` pins each wire status to its own
tone and wording, and `providers-settings.test.tsx` renders all four probe
outcomes. `unreachable` likewise needs the network down — step 7 of the PR's user
testing instructions walks through it.

## Defect this verification caught

The first pass of `02`/`03` showed the registry's `keyNotes` and `keyFormatHint`
**twice** — once from the composed credential editor and once from the card
above it, most visibly on Bedrock. The card now surfaces only `docsUrl`;
entry-time guidance belongs to the editor, where the user is actually typing.
The committed images are post-fix, confirmed by counting occurrences in the live
DOM (each string appears exactly once).
