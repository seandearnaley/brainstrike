# Unified Model & Embedding Provider Research (2025-10-19)

## 1. Current Brainstrike State
- **LLM provider store** – `packages/preferences/src/stores/assistant-preferences-store.ts` persists only four hard-coded providers (`openai`, `anthropic`, `google`, `openrouter`) and relies on `window.secrets.list()` to detect which keys exist at runtime.
- **Desktop key flow** – `apps/desktop/src/openai-api-key.ts` prefers environment variables (`BRAINSTRIKE_OPENAI_API_KEY`, `BS_OPENAI_API_KEY`, `OPENAI_API_KEY`) before falling back to the encrypted keychain via `window.secrets`.
- **UI shape** – `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` derives provider/model options from static lists in `@brainstrike/agent`, auto-selects the first detected provider, and disables the assistant when no model is configured.
- **Embedding policy** – We already standardized on 768-dimensional vectors (`brainstrike-4` epic) but current runtime components still assume provider-specific defaults instead of validating/enforcing 768 at selection time.

## 2. AI SDK Capabilities We Can Leverage
- **Rich provider catalog** – AI SDK 5 ships first-party adapters for OpenAI, Anthropic, Google, Bedrock, Groq, Cohere, etc., plus community packages like Ollama, Voyage, Mixedbread, and OpenRouter ([Providers overview](https://ai-sdk.dev/docs/foundations/providers-and-models)).
- **Provider registry & custom providers** – `createProviderRegistry` lets us register multiple language and embedding models under simple IDs, enforce per-provider defaults, and layer middleware ([Provider management](https://ai-sdk.dev/docs/ai-sdk-core/provider-management)).
- **AI Gateway** – The built-in `gateway` provider routes to dozens of hosted models from a single API key and even supports dynamic model discovery ([AI Gateway provider](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway)).
- **OpenAI-compatible adapter** – `@ai-sdk/openai-compatible` enables anything that speaks the OpenAI REST shape (e.g., LM Studio, custom gateways) with configurable headers/query params ([OpenAI compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers)).
- **Ollama provider** – Community package `ollama-ai-provider-v2` exposes both chat and embedding APIs for local models with overridable `baseURL` and headers ([Ollama provider](https://ai-sdk.dev/providers/community-providers/ollama)).
- **Embeddings helpers** – `embed` / `embedMany` include built-in batching, retries, parallelism and provider-specific options ([Embeddings guide](https://ai-sdk.dev/docs/ai-sdk-core/embeddings)).

## 3. Provider Landscape by Runtime

### 3.1 Hosted LLMs & Embeddings
- **OpenAI** – `text-embedding-3-large` and `text-embedding-3-small` accept a `dimensions` parameter, allowing us to request 768D outputs without manual truncation ([OpenAI embeddings](https://platform.openai.com/docs/guides/embeddings/what-are-embeddings)).
- **Google Vertex / Gemini** – `gemini-embedding-001` defaults to 3072D but supports `output_dimensionality` (e.g., 768). `text-embedding-005` already emits up to 768D ([Vertex text embeddings](https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings)).
- **Voyage AI** – New `voyage-3.5` family exposes flexible output dimensions (256/512/1024/2048) and supports domain-tuned variants ([Voyage embeddings](https://docs.voyageai.com/docs/embeddings)). Hitting 768D would require either down-projection or a post-processing compress step.
- **Mixedbread** – Offers 1024D and 384D options, with SaaS APIs optimized for latency ([Mixedbread embedding models](https://www.mixedbread.com/docs/models/embedding)).
- **Cohere / Amazon Bedrock / Mistral** – Available through AI SDK core adapters; dimensionalities range from 384 to 4096 ([AI SDK embeddings table](https://ai-sdk.dev/docs/ai-sdk-core/embeddings#embedding-providers--models)).

### 3.2 Aggregators & Gateways
- **OpenRouter** – Already partially integrated; we can expand model metadata as their catalog grows.
- **Vercel AI Gateway** – Single API surface with routing controls, credit tracking, and provider failover. Useful for browser-based deployments that cannot store multiple vendor secrets.
- **Custom registries** – With AI SDK’s registry we can mint canonical identifiers like `remote/openai:gpt-4o-mini` or `remote/google:gemini-2.5-flash`, enabling the UI to display provider + model pairings without duplicating logic.

### 3.3 Local / Edge Options
- **Ollama** – Local LLM + embedding runner with simple HTTP API. Embedding dimensionality depends on the loaded model (e.g., `nomic-embed-text` defaults to 768).
- **LM Studio / OpenAI-compatible servers** – Exposed via `@ai-sdk/openai-compatible`; we can let users point to a base URL + key (or disable auth for local-only use).
- **Transformers.js v3** – Runs ONNX models in-browser or in Electron via WebGPU with up to 120 architectures, including `mixedbread-ai/mxbai-embed-xsmall-v1` for embeddings ([Transformers.js v3 announcement](https://huggingface.co/blog/transformersjs-v3)). Strong candidate for “offline browser” mode if we package models.

## 4. Secrets & Configuration Strategy
- **Desktop parity** – Follow the `readOpenAIApiKey` precedence for every provider: check provider-specific env vars first, then fall back to the keychain via `window.secrets`. We should extend `window.secrets` IPC to accept provider identifiers beyond `openai`.
- **Web/runtime env vars** – For web builds we rely on `import.meta.env`; we should standardize naming (`VITE_PROVIDER_<ID>_API_KEY`, `VITE_PROVIDER_<ID>_ENABLED`) and sanitize them before passing into the provider registry.
- **Model catalog metadata** – Store provider capabilities (LLM, embeddings, dimension ranges, streaming support) in a shared config package so both UI and worker queues can validate selections.
- **Dimension compatibility** – Surface dimension metadata per model and ensure we resolve or create an `embedding_set` with the correct dimension before enqueueing work. Provide projection adapters only when a provider cannot emit a supported size.
- **Implementation note (2025-10-19)** – Desktop now resolves provider keys through `apps/desktop/src/provider-api-key.ts`, which consults registry env mappings (including legacy `BRAINSTRIKE_*` overrides) before falling back to the encrypted secrets store.

### Desktop Environment Variables (current)

Environment lookup order is defined per provider in `packages/agent/src/providers/registry.ts` (earlier entries win). The desktop runtime trims whitespace and ignores empty values.

| Provider   | Preferred environment variables (first → last)                            |
|------------|---------------------------------------------------------------------------|
| openai     | `BRAINSTRIKE_OPENAI_API_KEY`, `BS_OPENAI_API_KEY`, `OPENAI_API_KEY`, `AI_OPENAI_API_KEY`, `OPENAI_API_KEY_V1`, `OPENAI_API_KEY_V2` |
| anthropic  | `ANTHROPIC_API_KEY`, `AI_ANTHROPIC_API_KEY`                               |
| google     | `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`, `AI_GOOGLE_API_KEY`     |
| openrouter | `OPENROUTER_API_KEY`, `AI_OPENROUTER_API_KEY`                             |

### Web/Vite Environment Variables (proposed)

Frontend builds cannot access secure storage, so they will rely on statically injected Vite env vars. These names mirror the provider IDs in the registry and intentionally separate enablement from secret material.

| Provider ID | API key env var             | Enable flag env var            |
|-------------|-----------------------------|--------------------------------|
| openai      | `VITE_PROVIDER_OPENAI_API_KEY`      | `VITE_PROVIDER_OPENAI_ENABLED`      |
| anthropic   | `VITE_PROVIDER_ANTHROPIC_API_KEY`   | `VITE_PROVIDER_ANTHROPIC_ENABLED`   |
| google      | `VITE_PROVIDER_GOOGLE_API_KEY`      | `VITE_PROVIDER_GOOGLE_ENABLED`      |
| openrouter  | `VITE_PROVIDER_OPENROUTER_API_KEY`  | `VITE_PROVIDER_OPENROUTER_ENABLED`  |

### Embedding Queue Enforcement (current)

- Browser queue tasks now propagate `targetDimension` and `embeddingSetId` metadata so renderer-side imports and workers share the same contract for any supported size.
- The embedding worker resolves the authoritative dimension from `embedding_sets`, logs mismatches, and only rejects when the generated vectors fail to match the set’s declared dimension.


## 5. Suggested Deliverables (for ticket breakdown)
1. **Config foundation** – Introduce a shared provider registry describing every supported runtime, model list, and whether it can deliver 768D embeddings without post-processing.
2. **Secrets harmonization** – Expand desktop `secrets` IPC + key storage to support arbitrary provider IDs, and align environment-variable parsing in both desktop and web builds.
3. **UI enhancements** – Redesign provider/model picker to group providers by runtime (hosted, gateway, local, browser) and display capability badges (chat, embeddings, streaming, 768D-ready).
4. **Embedding pipeline upgrades** – Update worker queue to request concrete dimensions (OpenAI `dimensions`, Google `output_dimensionality`, Voyage `output_dimension`) and add validation hooks.
5. **Local/offline mode spike** – Prototype Transformers.js or Ollama-backed embeddings so browser/Electron experiences share a consistent checkbox-driven enablement flow.

**Status 2025-10-21:** Item 1 is now in progress with a shared registry at `packages/agent/src/providers/registry.ts`. It provides runtime/capability metadata, default model definitions, environment key precedence, and an explicit dimension metadata helper (`STANDARD_EMBEDDING_DIMENSION` remains the default fallback).

## 6. Open Questions
- Should we bundle curated local models (e.g., `mxbai-embed-xsmall`) or rely on user-supplied model downloads?
- When should we down-project higher-dimensional embeddings vs. storing multiple sets side-by-side?
- How much dynamic model discovery do we want (e.g., hitting AI Gateway metadata) vs. curated lists for deterministic QA?
- What telemetry/observability do we need when multiple providers are active (especially to trace embedding provenance)?

_Prepared by Codex on 2025-10-19. Updated 2025-10-21 with flexible dimension support notes._
