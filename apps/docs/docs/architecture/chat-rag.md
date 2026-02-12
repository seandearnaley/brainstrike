---
title: Chat and RAG Flow
sidebar_position: 5
---

# Chat & RAG Path (Assistant)

```mermaid
sequenceDiagram
  actor User
  participant UI as Client UI (Web/Desktop)
  participant A as Assistant API / IPC
  participant AR as Agent Runtime (MAStra)
  participant DB as Vector DB (pgvector?)
  participant LLM as Model Provider

  User->>UI: Ask question
  UI->>A: POST /api/assistant (stream)
  A->>AR: startSession()
  AR->>DB: similaritySearch(query embedding)
  DB-->>AR: top-k chunks
  AR->>LLM: generate(stream, {query, context})
  loop tokens
    LLM-->>AR: delta
    AR-->>A: delta
    A-->>UI: SSE/WS delta
  end
  AR-->>A: done + citations
  A-->>UI: end
```

**Blocking points**
- DB vector search latency (tune HNSW/IVFFlat or pgvector parameters if used).
- Provider request rate limits → use retry/backoff and cost-aware batching.
- Streaming stability — ensure *exactly-once* stream termination and client abort handling (see `docs/abort-signal-flow.md` if present).
