# Explicit native vector request plan

The pure `@brainstrike/embeddings/inference-plan` resolver validates an already
explicit worker plan before inference and supplies the native five-field profile.
It does not resolve omitted fields from legacy selected model preferences.

Wave0 verified fused MiniLM revision `aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f`
with WebGPU fp16 or WASM fp32, 384 dimensions and 256 input tokens including
special tokens. Xenova MiniLM revision `751bff37182d3f1213fa05d7196b954e230abad9`
was verified with WASM q8/fp32, 384 dimensions and 512 input tokens. The asset,
actual renderer worker and unsupported fused-q8 records are in
`fused-minilm-worker.md`.

The existing SimpleEmbeddingService derives a quantized boolean from dimensions
and model configuration; backend policy chooses WebGPU fp16 or WASM q4/fp32.
It neither pins a revision nor implies q8. Native text-store acquisition therefore
remains independent of embedding identity. A legacy selected ID/key/dimension
triple is an unresolved vector plan, not evidence for a default native profile.

Caller ownership includes forwarding the returned explicit worker plan to the
renderer producer. A profile passed only to main does not pin actual inference.
Resolver unit tests establish plan validation without executing inference; real
worker proof remains the separate Wave0 evidence, and full app acceptance remains
required at the composition boundary.
