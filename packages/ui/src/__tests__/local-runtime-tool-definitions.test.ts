import { describe, expect, it } from 'vitest';
import {
  buildLocalToolDefinitions,
  buildLocalToolUnavailableReason,
  type LocalRuntimeToolConfig,
} from '../../src/assistant-ui-panel/local-runtime-tool-definitions';

describe('local runtime tool definitions', () => {
  it('builds tool definitions only from enabled runnable tools with object schemas', () => {
    const tools: LocalRuntimeToolConfig[] = [
      {
        id: 'brainstrike.search_notes',
        description: 'Search notes',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query',
              enum: ['coverage', 'vitest'],
            },
            tags: {
              type: 'array',
              description: 'Filter tags',
              items: {
                type: 'string',
                description: 'Tag value',
              },
            },
            ignoredWithoutType: {
              description: 'Not a valid JSON schema property',
            },
          },
          required: ['query', 'tags'],
        },
        isLocalRuntimeRunnable: true,
      },
      {
        id: 'brainstrike.disabled',
        enabled: false,
        inputSchema: {
          type: 'object',
        },
        isLocalRuntimeRunnable: true,
      },
      {
        id: 'brainstrike.not_runnable',
        inputSchema: {
          type: 'object',
        },
        isLocalRuntimeRunnable: false,
      },
      {
        id: 'brainstrike.bad_schema',
        inputSchema: {
          type: 'string',
        },
        isLocalRuntimeRunnable: true,
      },
    ];

    expect(buildLocalToolDefinitions(tools, true)).toEqual([
      {
        type: 'function',
        function: {
          name: 'brainstrike.search_notes',
          description: 'Search notes',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
                enum: ['coverage', 'vitest'],
              },
              tags: {
                type: 'array',
                description: 'Filter tags',
                items: {
                  type: 'string',
                  description: 'Tag value',
                },
              },
            },
            required: ['query', 'tags'],
          },
        },
      },
    ]);
    expect(buildLocalToolDefinitions(tools, false)).toBeUndefined();
  });

  it.each([
    {
      expectedReason: 'window.tools.execute is not available in the renderer preload bridge',
      name: 'missing executor',
      tools: undefined,
      canExecuteTools: false,
    },
    {
      expectedReason: 'no tool menu was provided to the local runtime adapter',
      name: 'missing tool menu',
      tools: undefined,
      canExecuteTools: true,
    },
    {
      expectedReason: 'the tool menu is empty',
      name: 'empty tool menu',
      tools: [],
      canExecuteTools: true,
    },
    {
      expectedReason: 'all 1 configured tools are disabled',
      name: 'disabled tools',
      tools: [
        {
          id: 'brainstrike.disabled',
          enabled: false,
          inputSchema: {
            type: 'object',
          },
          isLocalRuntimeRunnable: true,
        },
      ],
      canExecuteTools: true,
    },
    {
      expectedReason:
        '1 enabled tools are present, but none are marked runnable by the local runtime',
      name: 'non-runnable tools',
      tools: [
        {
          id: 'brainstrike.not_runnable',
          inputSchema: {
            type: 'object',
          },
          isLocalRuntimeRunnable: false,
        },
      ],
      canExecuteTools: true,
    },
    {
      expectedReason: '1 runnable tools are present, but none have an object JSON schema',
      name: 'non-object schemas',
      tools: [
        {
          id: 'brainstrike.bad_schema',
          inputSchema: {
            type: 'string',
          },
          isLocalRuntimeRunnable: true,
        },
      ],
      canExecuteTools: true,
    },
  ] satisfies Array<{
    readonly canExecuteTools: boolean;
    readonly expectedReason: string;
    readonly name: string;
    readonly tools: readonly LocalRuntimeToolConfig[] | undefined;
  }>)('explains unavailable local tools for $name', ({
    canExecuteTools,
    expectedReason,
    tools,
  }) => {
    expect(buildLocalToolUnavailableReason(tools, canExecuteTools)).toBe(expectedReason);
  });
});
