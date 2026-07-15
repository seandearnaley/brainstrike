# Ollama and LM Studio local model servers

Brainstrike Desktop can use models served by Ollama or LM Studio without a
hosted-provider API key. Both integrations use the servers' OpenAI-compatible
`/v1/chat/completions` endpoint through Mastra's OpenAI-compatible model
configuration, so the normal Brainstrike agent loop, tools, persistence, and
run events remain active.

The desktop app is the recommended surface for local servers. Its main process
performs discovery without browser CORS restrictions. The web app can work only
when the server explicitly permits the web app's origin; a `Blocked by browser`
status is a server networking policy problem, not an unavailable model.

## Ollama

1. Install and start Ollama. On macOS, opening Ollama starts the local daemon.
   The CLI equivalent is `ollama serve`.
2. Pull at least one chat or tool-capable model, for example:

   ```bash
   ollama pull qwen3
   ```

3. Verify the server and catalog before opening Brainstrike:

   ```bash
   curl http://127.0.0.1:11434/api/version
   curl http://127.0.0.1:11434/v1/models
   ```

   Ollama's model list includes image generators as well as chat models.
   Brainstrike checks each model with `POST /api/show` and only offers models
   whose reported capabilities include `completion`. You can inspect one
   yourself with:

   ```bash
   curl http://127.0.0.1:11434/api/show \
     -d '{"model":"qwen3"}'
   ```

4. In Brainstrike, open **Settings → Local Runtimes → Ollama**.
5. Leave **Activation** on **Auto** and the base URL empty to use
   `http://127.0.0.1:11434`. For another machine, enter its origin, such as
   `http://gpu-box.local:11434`. Brainstrike accepts a trailing `/v1` and
   normalizes the endpoint internally.
6. Select **Probe now**. The card must show **Available**. Open the Assistant's
   model picker and select an Ollama model from the discovered catalog.

Ollama's local server ignores bearer credentials. If a remote Ollama-compatible
server requires a token, store it in the card's optional token field; Brainstrike
keeps it in the desktop secrets store. Never put a token in the base URL.

Official references: [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility),
[show model information](https://docs.ollama.com/api-reference/show-model-details),
[thinking](https://docs.ollama.com/capabilities/thinking), and
[tool calling](https://docs.ollama.com/capabilities/tool-calling).

## LM Studio

1. Install and open LM Studio, then download at least one chat model.
2. Open LM Studio's **Developer** tab and start the API server. The app being
   open is not sufficient: the Developer page must show **Status: Running** and
   **Reachable at `http://127.0.0.1:1234`**. The CLI equivalent is:

   ```bash
   lms server start
   ```

3. Verify the server and catalog:

   ```bash
   curl http://127.0.0.1:1234/api/v1/models
   curl http://127.0.0.1:1234/v1/models
   ```

   LM Studio loads a selected model automatically when an API request arrives.
   If Just-In-Time loading is disabled in LM Studio, load the model first in the
   Developer tab or with `lms load`.

4. In Brainstrike, open **Settings → Local Runtimes → LM Studio**.
5. Leave **Activation** on **Auto** and the base URL empty to use
   `http://127.0.0.1:1234`, then select **Probe now**.
6. After the card shows **Available**, select an LM Studio model in the
   Assistant's model picker.

LM Studio does not require authentication by default. If you enable
**Require Authentication** in its server settings, create an LM Studio API
token and save that token in Brainstrike's LM Studio card. A missing or rejected
token is surfaced as **Auth required**; Brainstrike does not retry anonymously.

Prefer a model that LM Studio marks as trained for tool use. Other models may
use LM Studio's default tool-call prompt, but their tool selection and argument
quality vary by model.

Official references: [LM Studio local server](https://lmstudio.ai/docs/developer/core/server),
[API quickstart and authentication](https://lmstudio.ai/docs/developer/rest/quickstart),
and [tool use](https://lmstudio.ai/docs/developer/openai-compat/tools).

## Troubleshooting

- **Unavailable**: run the matching `curl` commands above. Connection refusal
  means the server is stopped, bound to another address/port, or blocked by a
  firewall.
- **Incompatible**: the configured address responded, but not with an Ollama or
  LM Studio model API. Check that the base URL is the server origin, not a chat
  endpoint such as `/v1/chat/completions`.
- **Auth required**: save the server's token in the matching Brainstrike card.
  Do not substitute an OpenAI key.
- **Available, but the model is absent**: confirm the model appears in the
  runtime's catalog command above, then select **Probe now** again. Ollama models
  must be pulled and report the `completion` capability; image-only Ollama
  models are deliberately excluded. LM Studio models must be downloaded and
  report native type `llm` or `vlm`.
- **The stream stalls without producing output**: first test the selected model
  directly through the same compatible endpoint Brainstrike uses:

  ```bash
  curl -N http://127.0.0.1:11434/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"qwen3","messages":[{"role":"user","content":"Reply OK"}],"stream":true}'
  ```

  For Ollama, `ollama ps` shows active runners. If the direct request also emits
  no bytes, the runner/server is stalled rather than Brainstrike's transport;
  stop only the affected model with `ollama stop MODEL`, then retry. For LM
  Studio, inspect the Developer server logs and verify Just-In-Time loading can
  load the selected model. Brainstrike does not unload models, restart either
  server, or silently switch models on your behalf.
- **The run finishes at the output limit with reasoning but no answer**:
  reasoning-enabled local models can consume a very small custom max-output
  limit before emitting final text. Clear the custom limit or raise it; this is
  distinct from a stream stall because the run finishes with reason `length`.
- **Model replies but tools are unreliable**: choose a model advertised as
  tool-capable by the runtime. Server reachability and model tool proficiency
  are separate capabilities.
- **Assistant stream initialization fails before the server receives a
  request**: observational memory uses its own explicit model. Configure that
  model and its credentials under **Settings → Models & Providers → Assistant
  Memory**, or turn off observations. Brainstrike does not silently replace
  the chosen memory model with the active chat model.

Brainstrike intentionally does not fall back to a hosted provider, another
local runtime, or a different model when a selected local server fails. The
runtime error remains visible so configuration and model failures can be fixed
at their source.

Mastra reference: [local OpenAI-compatible models and the LM Studio example](https://mastra.ai/models#use-local-models-with-mastra).
