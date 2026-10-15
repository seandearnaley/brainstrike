import { createOpenAI } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { type StandardSchemaWithJSON, standardSchemaToJSONSchema } from '@mastra/core/schema';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createMcpRuntimeClient } from '../mcp/mcp-runtime-client';
import { createTestHost, requireExecutableTool } from './fixtures/mcp-runtime';

describe('MCP optional input semantics', () => {
  it('preserves optional MCP filters instead of allowing provider strict-mode normalization', async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const { host } = createTestHost({
      linear: {
        callTool,
        close: vi.fn(),
        listTools: async () => ({
          tools: [
            {
              description: 'List issues. Priority is an optional filter; zero means no priority.',
              inputSchema: {
                additionalProperties: false,
                properties: {
                  limit: { type: 'integer' },
                  priority: { maximum: 4, minimum: 0, type: 'integer' },
                  team: { type: 'string' },
                },
                required: ['team'],
                type: 'object',
              },
              name: 'list_issues',
            },
          ],
        }),
      },
    });
    const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
    onTestFinished(async () => await runtimeClient?.disconnect());
    const discovered = await runtimeClient?.listToolsetsWithErrors();
    const tool = requireExecutableTool(discovered?.toolsets['linear']?.['list_issues']);
    expect(tool).toHaveProperty('strict', false);
    const schema = tool.inputSchema as StandardSchemaWithJSON;
    expect(standardSchemaToJSONSchema(schema, { io: 'input' })).toMatchObject({
      required: ['team'],
    });
    expect(schema['~standard'].validate({ limit: 5 })).toMatchObject({ issues: expect.any(Array) });
    expect(schema['~standard'].validate({ priority: -1, team: 'BST' })).toMatchObject({
      issues: expect.any(Array),
    });
    await tool.execute({ limit: 5, team: 'BST' });
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: { limit: 5, team: 'BST' } }),
      expect.anything()
    );
    const requests: unknown[] = [];
    const provider = createOpenAI({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({
          created_at: 0,
          id: 'resp-optional-inputs',
          model: 'gpt-5.6-terra',
          object: 'response',
          output:
            requests.length === 1
              ? [
                  {
                    arguments: JSON.stringify({ priority: -1, team: 'BST' }),
                    call_id: 'call-invalid',
                    id: 'fc-invalid',
                    name: 'linear_list_issues',
                    status: 'completed',
                    type: 'function_call',
                  },
                ]
              : [
                  {
                    content: [{ annotations: [], text: 'done', type: 'output_text' }],
                    id: 'msg-optional-inputs',
                    role: 'assistant',
                    status: 'completed',
                    type: 'message',
                  },
                ],
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const agent = new Agent({
      id: 'mcp-optional-inputs',
      instructions: 'Inspect tools.',
      model: provider.responses('gpt-5.6-terra'),
      name: 'MCP optional inputs',
      tools: { linear_list_issues: tool },
    });
    await agent.generate('List the latest five BST issues.');
    expect(requests).toHaveLength(2);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requests[1])).toMatch(/validation/i);
    expect(requests[0]).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: 'linear_list_issues',
          parameters: expect.objectContaining({ required: ['team'] }),
          strict: false,
        }),
      ]),
    });
  });
});
