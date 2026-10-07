import { createRequire } from 'node:module';
import {
  type CanonicalProviderSchemaLayer,
  prepareProviderToolInputSchema,
} from '@brainstrike/agent/provider-request';
import { providerCompatibleInputSchema } from '@brainstrike/assistant-contract/native-tool-schemas';
import type { StandardSchemaWithJSON } from '@mastra/core/schema';
import { asSchema, jsonSchema, TypeValidationError } from 'ai';
import { z } from 'zod';
import { executableInputSchema } from './executable-input-schema.js';
import { jsonValue } from './json-value.js';
import type { HostTool } from './ports.js';

/** Supply the concrete resolved SDK model, never a configured routing alias. */
export interface HostProviderModelIdentity {
  readonly modelId: string;
  readonly provider: string;
  readonly supportsStructuredOutputs?: boolean;
}

type LayerConstructor = new (identity: {
  modelId: string;
  provider: string;
  supportsStructuredOutputs: boolean;
}) => CanonicalProviderSchemaLayer;

type InstalledCompatibility = Record<
  | 'AnthropicSchemaCompatLayer'
  | 'DeepSeekSchemaCompatLayer'
  | 'GoogleSchemaCompatLayer'
  | 'MetaSchemaCompatLayer'
  | 'OpenAIReasoningSchemaCompatLayer'
  | 'OpenAISchemaCompatLayer',
  LayerConstructor
>;

// Borrow Mastra's installed public compatibility entry point. This package
// already depends on @mastra/core; no second version or converter is installed.
const require = createRequire(import.meta.url);
const mastraRequire = createRequire(require.resolve('@mastra/core'));
const compatibility = (await import(
  mastraRequire.resolve('@mastra/schema-compat')
)) as InstalledCompatibility;

/** Only the model-facing schema changes; every authored tool binding survives. */
export async function prepareHostProviderTools(
  model: HostProviderModelIdentity,
  tools: Readonly<Record<string, HostTool>>
): Promise<Readonly<Record<string, HostTool>>> {
  const identity = {
    modelId: model.modelId,
    provider: model.provider,
    supportsStructuredOutputs: model.supportsStructuredOutputs ?? false,
  };
  // Same first-applicable order as the shipped Mastra tool converter.
  const layer = [
    compatibility.OpenAIReasoningSchemaCompatLayer,
    compatibility.OpenAISchemaCompatLayer,
    compatibility.GoogleSchemaCompatLayer,
    compatibility.AnthropicSchemaCompatLayer,
    compatibility.DeepSeekSchemaCompatLayer,
    compatibility.MetaSchemaCompatLayer,
  ]
    .map((Layer) => new Layer(identity))
    .find((candidate) => candidate.shouldApply());
  if (!layer) {
    return tools;
  }
  return Object.fromEntries(
    await Promise.all(
      Object.entries(tools).map(async ([name, tool]): Promise<[string, HostTool]> => {
        // Server-owned MCP schemas explicitly omit provider conversion.
        if (tool.strict === false) {
          return [name, tool];
        }
        if (tool.inputSchema instanceof z.ZodType) {
          const prepared = prepareProviderToolInputSchema(tool.inputSchema, layer);
          // Use the canonical native omission preprocessor on the raw input.
          // The vendor's null-to-undefined validator would create an own
          // undefined property, changing JSON approval/restart runtime meaning.
          const authored = asSchema(providerCompatibleInputSchema(tool.inputSchema));
          if (!authored.validate) {
            throw new Error('Host tool has no authored input validator');
          }
          return [
            name,
            {
              ...tool,
              inputSchema: jsonSchema(prepared.jsonSchema, { validate: authored.validate }),
            },
          ];
        }
        // Remote Standard Schema validators stay at their existing authority.
        // Expose an immutable JSON view to the vendor, not a lossy JSON-to-Zod
        // reconstruction or a new validator for the authored input.
        const authored = asSchema(executableInputSchema(tool.inputSchema));
        const schema = await authored.jsonSchema;
        const standard: StandardSchemaWithJSON = {
          '~standard': {
            jsonSchema: {
              input: () => ({ ...structuredClone(schema) }),
              output: () => ({ ...structuredClone(schema) }),
            },
            validate: async (value) => {
              if (!authored.validate) {
                throw new Error('Host tool has no authored input validator');
              }
              // Remote authority accepts JSON. The shipped layer's optional
              // null-to-undefined transform must cross that existing JSON seam
              // as omission, not as an unrepresentable own undefined property.
              const result = await authored.validate(jsonValue(value));
              return result.success
                ? { value: result.value }
                : { issues: [{ message: result.error.message }] };
            },
            vendor: 'brainstrike',
            version: 1,
          },
        };
        const compatible = layer.processToCompatSchema(standard)['~standard'];
        return [
          name,
          {
            ...tool,
            inputSchema: jsonSchema(compatible.jsonSchema.input({ target: 'draft-07' }), {
              validate: async (value) => {
                const result = await compatible.validate(structuredClone(value));
                return result.issues
                  ? {
                      error: new TypeValidationError({ cause: result.issues, value }),
                      success: false,
                    }
                  : { success: true, value: result.value };
              },
            }),
          },
        ];
      })
    )
  );
}
