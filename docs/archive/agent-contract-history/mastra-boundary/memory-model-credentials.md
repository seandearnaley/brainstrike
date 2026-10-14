# Memory-model credential boundary — evidence

Supports `docs/agents/mastra-boundary.md` § "Memory-model credential boundary".
Read this before changing how an observational-memory model target is resolved.


Serialized memory settings may name an observational model target, but that
target is configuration only. `PgliteMastraMemoryOptions` requires a concrete
`LanguageModel` whenever observational memory is enabled and throws before
storage initialization when it is absent. It must never hand Mastra the bare
routing string from settings: doing so would let Mastra resolve credentials
from its own environment or gateway and bypass Brainstrike's env/keychain
contract.

Desktop resolves the provider credential first, then
`createLanguageModelProvider` materializes any model-router descriptor (including
OpenRouter) into a concrete model carrying that explicit credential. Request
state distinguishes `disabled`, `resolved`, and `needs_async_resolution`; only
the last state may consult the desktop credential resolver. An absent credential
after that lookup is a typed failure, never an implicit provider fallback.

