#!/usr/bin/env node
/**
 * Manual-verification MCP client for the Agent Hub.
 * Connects two fake coding agents over Streamable HTTP, registers them,
 * exchanges chat messages, and prints a token-budgeted read.
 *
 * Usage: node scripts/agent-hub-verify-client.mjs <hub-url> [bearer-token]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] ?? 'http://127.0.0.1:4519/mcp';
const token = process.argv[3];

async function connect(name) {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined
  );
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ arguments: args, name });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

const red = await connect('claude-red');
const blue = await connect('codex-blue');

const redIdentity = await call(red, 'hub_register', {
  name: 'claude-red',
  program: 'claude-code',
  worktree: '/Users/sean/worktrees/feature-red',
});
console.log('[red] registered:', redIdentity.agent.name, redIdentity.agent.color);

const blueIdentity = await call(blue, 'hub_register', {
  name: 'codex-blue',
  program: 'codex',
  worktree: '/Users/sean/worktrees/feature-blue',
});
console.log('[blue] registered:', blueIdentity.agent.name, blueIdentity.agent.color);

await call(red, 'hub_send_message', {
  text: 'Hey team — starting on the auth refactor in feature-red. Anyone touching packages/auth?',
});
await call(blue, 'hub_send_message', {
  mentions: ['claude-red'],
  text: 'claude-red: not me, I am on the search indexer in feature-blue. Go ahead.',
});
await call(red, 'hub_send_message', {
  text: 'Great, claiming packages/auth for the next hour. Will post when done.',
});

const roster = await call(blue, 'hub_list_agents', {});
console.log(
  '[blue] roster:',
  roster.agents.map((a) => `${a.name}(${a.status},${a.color})`).join(', ')
);

const read = await call(blue, 'hub_read_messages', { maxTokens: 30 });
console.log(
  `[blue] budgeted read: ${read.messages.length} msgs, tokensUsed=${read.tokensUsed}, truncated=${read.truncated}`
);
for (const message of read.messages) {
  console.log(`  ${message.fromName}: ${message.text.slice(0, 60)}`);
}

const whoami = await call(red, 'hub_whoami', {});
console.log('[red] whoami tokensSent =', whoami.agent.tokensSent);

console.log('VERIFY_CLIENT_OK');
await red.close();
await blue.close();
