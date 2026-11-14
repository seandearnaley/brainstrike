import { NATIVE_TOOLS, type NativeToolId } from '@brainstrike/assistant-contract';
import { toToolInputJsonSchema } from '@brainstrike/assistant-contract/native-tool-schemas';
import { toStandardSchema } from '@mastra/core/schema';
import { asSchema, type JSONSchema7 } from 'ai';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { executableInputSchema } from '../src/executable-input-schema.ts';
import type { HostTool } from '../src/ports.ts';
import {
  type HostProviderModelIdentity,
  prepareHostProviderTools,
} from '../src/provider-schema-selection.ts';
import { type AbsentOptional, jsonSchemaArbitrary } from './fixtures/json-schema-arbitrary.ts';

// ADR-0009 rule 5: what the model is told it may send, the tool accepts. Each
// input below is generated from the JSON Schema a model is shown. The
// executable decoder must take it, and the MCP/Ajv adapter, an independent
// reading of the same JSON Schema, confirms the generator stayed inside it.

const RUNS = 40;
const UNKNOWN_KEY = 'brainstrikeUndeclaredKey';

/**
 * BST-2457: tools whose decoder refuses an input their advertised schema
 * allows. Each pins one such input. When a fix lands its pinned case fails;
 * remove the entry and the generated properties cover the tool again.
 */
const KNOWN_DISAGREEMENTS: Partial<Record<NativeToolId, Record<string, unknown>>> = {
  // `pattern` must compile when `isRegex` is set.
  'brainstrike.grepSearch': { isRegex: true, pattern: 'a[' },
  // Action-specific keys are a cross-field check the schema states only in prose.
  'brainstrike.manageCanvas': { action: 'create' },
  'brainstrike.manageWorktree': { action: 'create' },
  'brainstrike.memory': { command: 'view' },
  // Value rules the schema could state as a `pattern` but does not.
  'brainstrike.readToolOutputArtifact': { cursor: ' ' },
  // `path` or `cursor`, by the same kind of check.
  'brainstrike.readWorkspaceFile': {},
  'brainstrike.runPython': { allowedDomains: [' '], code: 'print(1)' },
  'brainstrike.runSkillScript': {
    cwd: '.',
    root: 'main',
    runtime: 'bash',
    scriptPath: 'run.sh',
    skillName: 'skill',
  },
};

/**
 * Advertised closed but stripping extras on purpose: Mastra executes these and
 * its prior inputs behaved that way (see `native-tools/definitions/skill.ts`).
 */
const STRIPS_UNDECLARED_KEYS: ReadonlySet<NativeToolId> = new Set([
  'skill',
  'skill_read',
  'skill_search',
]);

const TOOLS = NATIVE_TOOLS.map((tool) => [tool.id, tool] as const);
const AGREEING = TOOLS.filter(([id]) => !(id in KNOWN_DISAGREEMENTS));

interface Validator {
  validate(value: unknown): Promise<boolean>;
}

function validator(schema: Parameters<typeof asSchema>[0]): Validator {
  const sdk = asSchema(schema);
  return {
    async validate(value) {
      if (!sdk.validate) {
        throw new Error('Schema has no validator');
      }
      return (await sdk.validate(value)).success;
    },
  };
}

function wire(schema: Record<string, unknown>): Validator {
  return validator(toStandardSchema(schema as JSONSchema7));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe.each(['draft-07', 'draft-2020-12'] as const)(
  'the %s schema a tool advertises',
  (target) => {
    test.each(AGREEING)('%s decodes every input it describes', async (_id, tool) => {
      const advertised = toToolInputJsonSchema(tool.inputSchema, target);
      const ajv = wire(advertised);
      const executable = validator(executableInputSchema<unknown>(tool.inputSchema));
      await fc.assert(
        fc.asyncProperty(jsonSchemaArbitrary(advertised), async (input) => {
          expect(await ajv.validate(input)).toBe(true);
          expect(await executable.validate(input)).toBe(true);
        }),
        { numRuns: RUNS }
      );
    });

    test.each(Object.entries(KNOWN_DISAGREEMENTS))(
      '%s still refuses an input it advertises (BST-2457)',
      async (id, input) => {
        const tool = NATIVE_TOOLS.find((entry) => entry.id === id);
        if (!tool) {
          throw new Error(`${id} is no longer a native tool`);
        }
        expect(await wire(toToolInputJsonSchema(tool.inputSchema, target)).validate(input)).toBe(
          true
        );
        expect(
          await validator(executableInputSchema<unknown>(tool.inputSchema)).validate(input)
        ).toBe(false);
      }
    );

    test.each(TOOLS)(
      '%s refuses an undeclared key and a missing required one',
      async (id, tool) => {
        const advertised = toToolInputJsonSchema(tool.inputSchema, target);
        const ajv = wire(advertised);
        const executable = validator(executableInputSchema<unknown>(tool.inputSchema));
        await fc.assert(
          fc.asyncProperty(jsonSchemaArbitrary(advertised), async (input) => {
            if (!isRecord(input)) {
              throw new Error('A tool input is a JSON object');
            }
            // Union branches may tolerate keys another branch declares (rule 5),
            // but a key no branch declares fails on both sides.
            const undeclared = { ...input, [UNKNOWN_KEY]: 'not in the schema' };
            expect(await ajv.validate(undeclared)).toBe(false);
            expect(await executable.validate(undeclared)).toBe(STRIPS_UNDECLARED_KEYS.has(id));
            // A required key the advertised schema refuses to lose, the decoder
            // refuses to lose too: it never invents a value the model did not send.
            for (const key of Object.keys(input)) {
              const { [key]: _dropped, ...missing } = input;
              if (!(await ajv.validate(missing))) {
                expect(await executable.validate(missing)).toBe(false);
              }
            }
          }),
          { numRuns: RUNS }
        );
      }
    );
  }
);

const PROVIDERS: readonly HostProviderModelIdentity[] = [
  { modelId: 'gpt-5.1', provider: 'openai', supportsStructuredOutputs: true },
  { modelId: 'o3', provider: 'openai', supportsStructuredOutputs: true },
  { modelId: 'claude-sonnet-4-5', provider: 'anthropic' },
  { modelId: 'gemini-2.5-pro', provider: 'google' },
  { modelId: 'deepseek-chat', provider: 'deepseek' },
  { modelId: 'meta-llama/llama-4-maverick', provider: 'openrouter' },
];

function hostTools(): Record<string, HostTool> {
  return Object.fromEntries(
    NATIVE_TOOLS.map((tool): [string, HostTool] => [
      tool.id,
      {
        description: tool.description,
        execute: () => Promise.reject(new Error('Schema agreement never executes a tool')),
        identity: tool.id,
        inputSchema: tool.inputSchema,
        risk: 'read',
      },
    ])
  );
}

/** Strict mode lists every property as required, so an unused optional is sent as null. */
function absentOptionalFor(schema: Record<string, unknown>): AbsentOptional {
  const properties = isRecord(schema['properties']) ? Object.keys(schema['properties']) : [];
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  return properties.length > 0 && properties.every((key) => required.includes(key))
    ? 'null'
    : 'omit';
}

describe.each(PROVIDERS)('the schema $provider $modelId is sent', (provider) => {
  const tools = prepareHostProviderTools(provider, hostTools());
  test.each(AGREEING)('%s accepts every input the model may send', async (id, tool) => {
    const prepared = (await tools)[id];
    if (!prepared) {
      throw new Error(`Provider preparation dropped ${id}`);
    }
    const sent = (await asSchema(prepared.inputSchema).jsonSchema) as Record<string, unknown>;
    const ajv = wire(sent);
    const accepts = validator(prepared.inputSchema);
    // Provider layers move some constraints (patterns, bounds) into the
    // description, so inputs come from the advertised schema, which still
    // states them, written in the form the provider's schema asks for.
    const advertised = toToolInputJsonSchema(tool.inputSchema, 'draft-07');
    await fc.assert(
      fc.asyncProperty(jsonSchemaArbitrary(advertised, absentOptionalFor(sent)), async (input) => {
        expect(await ajv.validate(input)).toBe(true);
        expect(await accepts.validate(input)).toBe(true);
      }),
      { numRuns: RUNS }
    );
  });
});
