# 4) Agent Runtime & MCP

```mermaid
flowchart LR
  subgraph AgentPkg[packages/agent]
    AR[mastra/agent-runtime.ts]
    PF[providers/provider-factory.ts]
    TR[mcp/tool-registry.ts]
    TL[mcp/mcp-tool-loader.ts]
    DS[stream/data-stream.ts]
    TS[mastra/tool-sanitizer.ts]
  end

  subgraph Client
    WAPI[Web Assistant API routes]
    DIPC[Desktop IPC: ipc-agent.ts, assistant-server.ts]
  end

  subgraph Tools[External Tools via MCP]
    T1[Filesystem, Web, etc.]
  end

  Client --> AR
  AR --> PF
  AR --> DS
  AR --> TR
  TR --> TL
  TL --> Tools
```

**Notes**
- MAStra runtime mediates between client surfaces and provider-specific capabilities.
- MCP tool loading is centralized, enabling consistent tool availability across web & desktop.
- `assistant-stream-helpers.ts` (web) participates in streaming UX.
