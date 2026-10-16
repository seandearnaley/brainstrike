# ADR-0007: Local inference never runs on a thread that serves the UI, log or protocol

- **Status:** Accepted; its local-LLM half is spent (2026-10-15)
- **Date:** 2026-10-02
- **Ticket:** BST-1914 (rule wording from BST-1943)

> **2026-10-15.** The built-in local CHAT model (Gemma 4 E2B through
> transformers.js), its engine and the `llm-host` renderer role that hosted it
> are gone; the `local` provider declares `capabilities.llm: false` and serves
> embeddings only. The rule below is unchanged and still binding — it now binds
> the EMBEDDING path alone, which is what the Consequences section already
> anticipated ("this rule mainly binds the embedding path"). Nothing here needs
> re-deciding; the chat placement it also covered has no subject left.

## Context

Transformers.js needs Web Workers. In Electron main or plain Node it falls back to
synchronous WASM and freezes whatever that thread serves, and the local Gemma
runtime also depends on renderer-only WebGPU surfaces. Desktop therefore runs
embeddings and the local LLM in hidden renderer hosts, and main owns only their
lifecycle and IPC (`docs/archive/agent-contract-history/local-inference/hidden-host-manifest.md`). The
CLI-first host (ADR-0017) adds an Electron-free Node process, so "never in Electron
main" no longer names every thread that has to stay free.

## Decision

Embedding and local-LLM inference never run in Electron main, or on any thread that
serves the UI, the run log or the client protocol. Desktop runs them in hidden
renderer hosts. Web runs embeddings in browser workers. A Node process that needs an
embedder runs it in a `worker_threads` Worker, never on its main thread.

## Consequences

- Main keeps host-window lifecycle, IPC, DB init and power lifecycle, and starts no
  embedding worker.
- BST-1943 makes `ensureLocalRuntime` throw on the agent host's main thread and
  removes the `EMBED_ALLOW_LOCAL_IN_MAIN` escape hatch from the host.
- An optional CLI query embedder on `onnxruntime-node` (BST-1946) runs in a Worker,
  because its `session.run` is synchronous.
- The reset cuts local LLM chat, including today's in-page Gemma chat on web. Local
  embeddings stay, so this rule mainly binds the embedding path.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `AGENTS.md:37`, the cross-cutting invariant "runs ONLY in hidden renderer hosts —
  never in Electron main".
- `docs/agents/local-inference.md:4` (header rule) and `:287` (local Gemma placement).
