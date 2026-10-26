# @brainstrike/embeddings

Hosted embedding provider adapters (OpenAI, Google, Cohere, Voyage), their API
key resolution and vector validation.

## Use the right boundary

[`package.json`](package.json) owns the export map:

| Subpath | Responsibility |
| --- | --- |
| `/provider-core` | Provider adapters, provider/model metadata contracts and API key resolution |
| `/factory` | Cached provider factory |

App model metadata comes from the existing provider catalog and authorized model
choices. Consult installed metadata rather than copying model tables.

## Hosted embeddings

Each adapter sends its provider's documented request and validates the returned
dimensions before a vector is published. A missing API key, a rate limit or a
provider error is a typed result, never a silent fallback. Keys resolve through
the shared provider key boundary and stay outside request payloads and logs.

## Development

Use this package's `type-check` and `test` scripts. **CI is disabled due to cost;
validation must run locally.** Follow `pnpm check`.
