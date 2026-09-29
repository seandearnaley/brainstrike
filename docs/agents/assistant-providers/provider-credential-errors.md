# Provider credential read failures — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". How a stored-key read failure propagates without becoming `missing_api_key`.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 306-318); append rather than
rewrite.

---

    Chat and model-metadata environment credentials remain authoritative when
    present. A stored-key `SecretReadError` must otherwise propagate as the typed
    `api_key_unreadable` chat/model-metadata failure (or the original typed
    embedding failure); it must never be coerced into `missing_api_key`.
    Embeddings may continue with a valid environment credential after a stored
    read failure, but must rethrow that failure when no environment key exists.
    `SecretReadErrorCode` and its runtime guard live in the shared assistant
    contract; desktop producers and renderer status parsing must use that single
    definition. Malformed provider-error payloads fail the status probe visibly
    rather than being dropped, so a protocol violation can never masquerade as
    healthy provider availability. Saving, replacing, or deleting a provider
    secret must re-probe assistant status so an unreadable-key error cannot
    remain latched after the credential is repaired.
