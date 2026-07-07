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
        description: 'Search notes',
        id: 'brainstrike.search_notes',
        inputSchema: {
          properties: {
            ignoredWithoutType: {
              description: 'Not a valid JSON schema property',
            },
            query: {
              description: 'Search query',
              enum: ['coverage', 'vitest'],
              type: 'string',
            },
            tags: {
              description: 'Filter tags',
              items: {
                description: 'Tag value',
                type: 'string',
              },
              type: 'array',
            },
          },
          required: ['query', 'tags'],
          type: 'object',
        },
        isLocalRuntimeRunnable: true,
      },
      {
        enabled: false,
        id: 'brainstrike.disabled',
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
        function: {
          description: 'Search notes',
          name: 'brainstrike.search_notes',
          parameters: {
            properties: {
              query: {
                description: 'Search query',
                enum: ['coverage', 'vitest'],
                type: 'string',
              },
              tags: {
                description: 'Filter tags',
                items: {
                  description: 'Tag value',
                  type: 'string',
                },
                type: 'array',
              },
            },
            required: ['query', 'tags'],
            type: 'object',
          },
        },
        type: 'function',
      },
    ]);
    expect(buildLocalToolDefinitions(tools, false)).toBeUndefined();
  });

  it.each([
    {
      canExecuteTools: false,
      expectedReason: 'window.tools.execute is not available in the renderer preload bridge',
      name: 'missing executor',
      tools: undefined,
    },
    {
      canExecuteTools: true,
      expectedReason: 'no tool menu was provided to the local runtime adapter',
      name: 'missing tool menu',
      tools: undefined,
    },
    {
      canExecuteTools: true,
      expectedReason: 'the tool menu is empty',
      name: 'empty tool menu',
      tools: [],
    },
    {
      canExecuteTools: true,
      expectedReason: 'all 1 configured tools are disabled',
      name: 'disabled tools',
      tools: [
        {
          enabled: false,
          id: 'brainstrike.disabled',
          inputSchema: {
            type: 'object',
          },
          isLocalRuntimeRunnable: true,
        },
      ],
    },
    {
      canExecuteTools: true,
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
    },
    {
      canExecuteTools: true,
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
