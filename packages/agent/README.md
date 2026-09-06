# @brainstrike/agent

> Production-ready AI agent runtime with MCP support, streaming capabilities, and Assistant UI integration

[![Node Version](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./package.json)

## Overview

`@brainstrike/agent` is a modern AI agent runtime package that provides a unified interface for building conversational AI applications. It features first-class support for the Model Context Protocol (MCP), streaming responses, tool execution, and seamless integration with popular frameworks like Mastra and Assistant UI.

### Key Features

- **🤖 Multi-Provider Support**: OpenAI, Anthropic, Google, OpenRouter, plus a renderer-only local provider, all routed through Mastra
- **📚 Provider Registry**: Central metadata (`@brainstrike/assistant-contract/provider-registry`, re-exported as `packages/agent/src/providers/registry.ts`) for display names, runtime capabilities, and embedding dimension support
- **🔧 MCP Integration**: Native support for Model Context Protocol servers and tools
- **📡 Streaming First**: Efficient real-time streaming with backpressure handling
- **🛠️ Tool Orchestration**: Extensible tool system with progress tracking
- **💾 Memory Management**: Pluggable memory stores for conversation persistence
- **🎯 Type Safety**: Full TypeScript with strict mode and comprehensive type exports
- **🧪 Battle Tested**: Extensive test coverage with unit and integration tests

## Installation

This runtime is shipped as part of the Brainstrike workspace. Link it into the
consuming project instead of fetching it from npm.

```bash
# Add to a specific workspace (example: apps/desktop)
pnpm add @brainstrike/agent --filter @brainstrike/desktop

# Or declare it manually in the target package.json
"dependencies": {
  "@brainstrike/agent": "workspace:*"
}
```

### Peer Dependencies

Ensure you have the following peer dependencies installed:

```bash
pnpm add zod @ai-sdk/openai @mastra/core --filter <workspace>
```

## Quick Start

### Basic Usage

```typescript
import {
  streamMastraAgent,
  convertAssistantUiMessages,
  type AgentMessage
} from '@brainstrike/agent';

// Convert UI messages to agent format
const messages = convertAssistantUiMessages([
  { role: 'user', text: 'Hello, how can you help me?' }
]);

// Stream agent responses
const stream = await streamMastraAgent(messages, {
  model: 'gpt-5.2',
  runtime: {
    apiKey: process.env.OPENAI_API_KEY,
    provider: 'openai'
  }
});

// Process streaming chunks
for await (const chunk of stream) {
  switch (chunk.type) {
    case 'text-delta':
      console.log('Text:', chunk.value);
      break;
    case 'tool-event':
      console.log('Tool:', chunk.name, chunk.status);
      break;
    case 'finish':
      console.log('Tokens used:', chunk.usage);
      break;
  }
}
```

### With MCP Support

```typescript
import { streamMastraAgent, parseMcpConfig } from '@brainstrike/agent';

// Configure MCP servers
const mcpConfig = parseMcpConfig(JSON.stringify({
  servers: [
    {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/files']
    },
    {
      name: 'remote-api',
      transport: 'streamable-http',
      url: 'https://your-host.example.com/mcp'
    }
  ]
}));

// Use MCP-enabled agent
const stream = await streamMastraAgent(messages, {
  mcpConfig,
  runtime: {
    mcpEnabled: true,
    apiKey: process.env.OPENAI_API_KEY
  }
});
```

### Custom Tools

```typescript
import { streamMastraAgent, webTools } from '@brainstrike/agent';
import { z } from 'zod';

// Define custom tool
const customTool = {
  name: 'calculate',
  description: 'Perform calculations',
  inputSchema: z.object({
    expression: z.string()
  }),
  execute: async ({ expression }) => {
    // Tool implementation
    return { result: eval(expression) }; // Example only - use safe evaluation
  }
};

// Combine with built-in web tools
const tools = {
  ...webTools,
  calculate: customTool
};

const stream = await streamMastraAgent(messages, {
  tools,
  runtime: { apiKey: process.env.OPENAI_API_KEY }
});
```

### AI SDK Data Stream Protocol

`@brainstrike/agent` emits the documented
[AI SDK Data Stream Protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol). The session
adapter returns newline-delimited `code:JSON` records (e.g. `0:"hello"`, `b:{...}`) with the
`x-vercel-ai-data-stream: v1` header. The renderer consumes it through assistant-stream's
`DataStreamDecoder` behind a bespoke `ChatModelAdapter` on `useLocalRuntime`
(`packages/assistant-ui/src/data-stream-runtime.ts`) — not through
`@assistant-ui/react-data-stream`, whose runtime owns the chat-model slot and does not support
human-in-the-loop tools.

```ts
import {
  assistantDataStreamSessions,
  resolveDataStreamSession,
  toAiSdkStyleStream,
  type StreamChunk,
} from '@brainstrike/agent';

const lastEventId = request.headers.get('last-event-id');
const existing = resolveDataStreamSession(lastEventId);
if (existing) {
  return existing.createResponse(lastEventId ? { resumeFromEventId: lastEventId } : undefined);
}

const agentStream: AsyncIterable<StreamChunk> = await toAiSdkStyleStream(messages, runtime);
const session = assistantDataStreamSessions.create(agentStream);
return session.createResponse();
```

- Codes map to text deltas (`0`), tool streaming (`b`, `c`, `9`, `a`), step boundaries (`f`, `e`), message completion (`d`),
  and structured errors (`3`)—matching the reference protocol emitted by `assistant-stream`.
- Each chunk is tracked with an internal `<sessionId>:<sequence>` identifier. If a client reconnects, it can provide the
  last observed ID via `Last-Event-ID` and the session will replay only the missing records.
- Set `BRAINSTRIKE_DEBUG_STREAM=1` locally to mirror every emitted part in the server logs when you need to debug the
  streaming contract.

## API Reference

### Core Types

#### `AgentMessage`

The primary message format for agent interactions:

```typescript
interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: AgentMessagePart[];
}
```

#### `StreamChunk`

Streaming response types:

```typescript
type StreamChunk =
  | StreamChunkText      // Text deltas
  | StreamChunkTool      // Tool execution events
  | StreamChunkFinish    // Stream completion with usage stats
```

### Main Functions

#### `streamMastraAgent(messages, options)`

The primary streaming agent runtime.

**Parameters:**
- `messages: AgentMessage[]` - Conversation history
- `options: MastraAgentRuntimeOptions` - Configuration options

**Returns:** `AsyncIterable<StreamChunk>`

#### `convertAssistantUiMessages(messages)`

Converts Assistant UI format messages to agent format.

**Parameters:**
- `messages: AssistantUiMessage[]` - UI framework messages

**Returns:** `AgentMessage[]`

#### `createMastraAgentRuntime(options)`

Creates a reusable agent runtime instance.

**Parameters:**
- `options: MastraAgentRuntimeOptions` - Runtime configuration

**Returns:** `MastraAgentRuntime`

### Tool Management

#### `createToolRegistry()`

Creates a tool execution registry for tracking tool calls.

```typescript
const registry = createToolRegistry();
const controller = startToolCall(registry, 'tool-name');
recordToolProgress(controller, { status: 'processing' });
completeToolCall(controller, { result: 'success' });
```

### Memory Stores

#### `InMemoryMemoryStore`

Built-in memory store for development:

```typescript
import { InMemoryMemoryStore } from '@brainstrike/agent';

const memory = new InMemoryMemoryStore();
await memory.saveMessages('thread-1', messages);
const retrieved = await memory.getMessages('thread-1');
```

## Advanced Usage

### Progress Tracking

```typescript
import { streamMastraAgent } from '@brainstrike/agent';

const stream = await streamMastraAgent(messages, {
  runtime: {
    callTool: async (name, params, { onProgress } = {}) => {
      // Report progress during tool execution
      onProgress?.({ stage: 'fetching' });
      const result = await fetchData(params);
      onProgress?.({ stage: 'complete' });
      return result;
    }
  }
});
```

### Custom Providers

```typescript
import { createMastraAgentRuntime } from '@brainstrike/agent';

const runtime = createMastraAgentRuntime({
  provider: 'custom-provider',
  model: 'custom-model',
  runtime: {
    apiKey: process.env.CUSTOM_API_KEY,
    // Additional provider-specific config
  }
});
```

### Error Handling

```typescript
try {
  const stream = await streamMastraAgent(messages, options);

  for await (const chunk of stream) {
    if (chunk.type === 'tool-event' && chunk.status === 'error') {
      console.error('Tool error:', chunk.payload);
      // Handle tool errors gracefully
    }
  }
} catch (error) {
  // Handle stream initialization errors
  console.error('Agent error:', error);
}
```

## Configuration

### Environment Variables

```bash
# API Keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Custom endpoints
OPENAI_BASE_URL=https://api.openai.com/v1
```

### TypeScript Configuration

Ensure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    "strict": true,
    "esModuleInterop": true,
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "target": "ES2022"
  }
}
```

## Architecture

### Package Structure

```
@brainstrike/agent/
├── src/
│   ├── mastra/           # Mastra framework integration
│   ├── mcp/              # Model Context Protocol support
│   ├── memory/           # Memory store implementations
│   ├── providers/        # AI provider integrations
│   ├── stream/           # Streaming utilities
│   ├── tools/            # Tool schemas and adapters
│   └── __tests__/        # Comprehensive test suite
├── dist/                 # Built outputs (ESM, CJS, types)
└── package.json
```

### Design Principles

1. **Stream-First Architecture**: All operations designed for efficient streaming
2. **Type Safety**: Comprehensive TypeScript types with strict mode
3. **Extensibility**: Plugin-based architecture for tools, memory, and providers
4. **Zero Side Effects**: Pure functional core with explicit side effect boundaries
5. **Platform Agnostic**: Works in Node.js, browsers, and edge environments

## Development

### Building

```bash
# Clean and build
pnpm build

# Development mode with watch
pnpm dev

# Type checking
pnpm type-check
```

### Testing

```bash
# Run tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage report
pnpm test:coverage
```

### Linting

```bash
# Lint with auto-fix
pnpm lint

# Type checking
pnpm type-check
```

## Integration Examples

### With Next.js App Router

```typescript
// app/api/chat/route.ts
import { streamMastraAgent } from '@brainstrike/agent';
import { StreamingTextResponse } from 'ai';

export async function POST(request: Request) {
  const { messages } = await request.json();

  const stream = await streamMastraAgent(messages, {
    model: 'gpt-5.2',
    runtime: { apiKey: process.env.OPENAI_API_KEY }
  });

  // Convert to Vercel AI SDK response
  return new StreamingTextResponse(
    new ReadableStream({
      async pull(controller) {
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') {
            controller.enqueue(chunk.value);
          }
        }
        controller.close();
      }
    })
  );
}
```

### With Electron IPC

```typescript
// main/agent-handler.ts
import { streamMastraAgent } from '@brainstrike/agent';
import { ipcMain } from 'electron';

ipcMain.handle('agent:stream', async (event, messages, options) => {
  const stream = await streamMastraAgent(messages, options);

  for await (const chunk of stream) {
    event.sender.send('agent:chunk', chunk);
  }

  event.sender.send('agent:complete');
});
```

## Performance

### Benchmarks

- **First Token Latency**: <500ms (GPT-5.2 Chat (Latest))
- **Throughput**: 100+ tokens/second streaming
- **Memory Usage**: <50MB baseline, scales linearly with conversation
- **Bundle Size**: 42KB minified + gzipped (core only)

### Optimization Tips

1. Use streaming for real-time responsiveness
2. Implement tool result caching for expensive operations
3. Configure appropriate token limits for your use case
4. Use memory stores for conversation persistence
5. Enable MCP server pooling for high-concurrency scenarios

## Troubleshooting

### Common Issues

#### MCP Server Connection Failed
```typescript
// Ensure MCP server is installed and accessible
const mcpConfig = {
  servers: [
    {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { NODE_ENV: 'production' } // Add environment variables if needed
    },
    {
      name: 'legacy-remote-api',
      transport: 'sse', // Use only for legacy HTTP+SSE servers
      url: 'https://your-host.example.com/mcp/sse'
    }
  ]
};
```

#### Type Errors with Assistant UI
```typescript
// Use strict message types for better type inference
import type { AssistantUiMessageStrict } from '@brainstrike/agent';

const messages: AssistantUiMessageStrict[] = [
  { role: 'user', text: 'Hello' }
];
```

## Contributing

Follow the repository's [coding-agent and contribution policy](../../AGENTS.md)
and open a pull request with the relevant package checks passing.

### Development Setup

1. Clone the repository
2. Install dependencies: `pnpm install`
3. Run tests: `pnpm test`
4. Make your changes
5. Submit a pull request

## License

MIT © BrainStrike Team

## Support

- [GitHub Issues](https://github.com/seandearnaley/brainstrike/issues)
## Related Packages

- [`@brainstrike/ui`](../ui) - React components for agent interfaces
- [`@brainstrike/storage`](../storage) - Persistent storage adapters
- [`@brainstrike/utils`](../utils) - Shared utility functions
- [`@brainstrike/types`](../types) - Common TypeScript definitions

---

Built with ❤️ by the BrainStrike team
