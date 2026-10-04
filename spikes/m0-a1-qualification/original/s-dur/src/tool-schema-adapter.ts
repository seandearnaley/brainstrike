// G1: the host's tool adapter. Per provider target, rewrite a tool's Zod input schema with the ported Mastra
// schema-compat layer, finalize it to the provider's DOCUMENTED subset, and keep validation on the ORIGINAL Zod schema.
//
//   wire schema   = finalize(target, mastraLayer.processToJSONSchema(zod))   -> sent to the provider
//   validation    = zod.safeParse(mastraLayer.transformValue(modelInput))    -> e.g. OpenAI: null -> undefined for
//                                                                                fields that were optional originally
//
// Host finalization (NOT in Mastra; Mastra never sends strict:true, so its leftovers never mattered):
//   all targets : drop the `x-optional` / `x-date` annotations from the wire copy (kept on the validation copy)
//   openai      : drop `$schema`; move `default` into the description (not in the documented strict subset)
//   google      : move `default` into the description; express `nullable:true` as anyOf[..., {type:'null'}] so the
//                 schema is inside BOTH documented Gemini subsets (the OpenAPI `Schema` one and the JSON-Schema one that
//                 @ai-sdk/google 4.0.87 actually uses: it sends `parametersJsonSchema`)
// strict:true is set for OpenAI targets only when validateOpenAIStrict() finds zero violations; otherwise the tool is
// sent non-strict and the violations are reported (never silently): `report[]` carries them.
import { jsonSchema, type Tool, type ToolSet } from 'ai';
import type { z } from 'zod';
import { providerCompatibleInputSchema } from './ported/provider-compatible-input.js';
import { selectLayer, type CompatTarget, type ModelInformation } from './ported/schema-compat.js';
import { validateGeminiJsonSchemaSubset, validateGeminiOpenAPISubset, validateOpenAIStrict, type Violation } from './schema-subsets.js';

type S = Record<string, any>;
export interface SchemaAdaptation { tool: string; target: CompatTarget; strict: boolean; violations: Violation[]; mastra: S; wire: S }

const isZod4 = (s: unknown): s is z.ZodType => typeof s === 'object' && s !== null && '_zod' in s && typeof (s as any)['~standard']?.jsonSchema?.input === 'function';

function walk(s: unknown, fn: (n: S) => void) {
  if (typeof s !== 'object' || s === null) return;
  if (Array.isArray(s)) { for (const x of s) walk(x, fn); return; }
  fn(s as S);
  for (const v of Object.values(s)) walk(v, fn);
}
const withDefaultInDescription = (n: S) => {
  if (!('default' in n)) return;
  n.description = `${n.description ? `${n.description}\n` : ''}default: ${JSON.stringify(n.default)}`;
  delete n.default;
};

export function finalizeWire(target: CompatTarget, mastra: S): S {
  const wire = structuredClone(mastra);
  walk(wire, (n) => { for (const k of Object.keys(n)) if (k.startsWith('x-')) delete n[k]; });
  if (target === 'openai' || target === 'openai-reasoning') {
    delete wire.$schema;
    walk(wire, (n) => { if (typeof n.type === 'string' || Array.isArray(n.type) || n.anyOf) withDefaultInDescription(n); });
    // Mastra's OpenAI layer leaves a discriminated union's `oneOf` in place (wrapped as anyOf[{oneOf}, null] by its
    // typeless-node rule); strict mode supports anyOf only -> oneOf becomes anyOf, and a branch that is only an anyOf is
    // flattened into its parent.
    walk(wire, (n) => { if (Array.isArray(n.oneOf)) { n.anyOf = [...(n.anyOf ?? []), ...n.oneOf]; delete n.oneOf; } });
    walk(wire, (n) => { if (Array.isArray(n.anyOf)) n.anyOf = n.anyOf.flatMap((b: S) => (b && typeof b === 'object' && Object.keys(b).length === 1 && Array.isArray(b.anyOf) ? b.anyOf : [b])); });
  }
  if (target === 'google') {
    walk(wire, (n) => {
      if (typeof n.type === 'string' || Array.isArray(n.type) || n.anyOf || n.enum) withDefaultInDescription(n);
      if (n.nullable !== true) return;
      delete n.nullable;
      if (Array.isArray(n.anyOf) && n.type === undefined) { n.anyOf.push({ type: 'null' }); return; }
      const { description, ...rest } = n;
      for (const k of Object.keys(n)) delete n[k];
      Object.assign(n, { anyOf: [rest, { type: 'null' }] }, description !== undefined ? { description } : {});
    });
  }
  return wire;
}

/** Adapt one tool for one model identity. Tools without a zod-4 input schema are returned unchanged. */
export function adaptTool(name: string, t: Tool, model: ModelInformation): { tool: Tool; report?: SchemaAdaptation } {
  const original = (t as { inputSchema?: unknown }).inputSchema;
  if (!isZod4(original) || (t as { type?: string }).type === 'provider' || (t as any)[Symbol.for('vercel.ai.toolSearch')] === true) return { tool: t };
  const layer = selectLayer(model);
  if (!layer) return { tool: t };
  const mastra = layer.processToJSONSchema(original, 'input');
  const wire = finalizeWire(layer.target, mastra);
  const violations = layer.target === 'google' ? [...validateGeminiOpenAPISubset(wire), ...validateGeminiJsonSchemaSubset(wire)]
    : layer.target === 'anthropic' ? [] : validateOpenAIStrict(wire);
  const strict = (layer.target === 'openai' || layer.target === 'openai-reasoning') && violations.length === 0;
  // Validation stays on the ORIGINAL schema. Provider nulls for originally-optional fields are omission: Mastra's value
  // transform first, then Brainstrike's own providerCompatibleInputSchema normalizer (ported verbatim), which also
  // reaches optional fields inside discriminated-union branches that Mastra's #resolveAnyOf misses (oneOf nested in anyOf).
  const validator = providerCompatibleInputSchema(original);
  const inputSchema = jsonSchema(wire as never, {
    validate: (value: unknown) => {
      const r = validator.safeParse(layer.transformValue(structuredClone(value), mastra));
      return r.success ? { success: true, value: r.data } : { success: false, error: r.error };
    },
  });
  return { tool: { ...t, inputSchema, ...(strict ? { strict: true } : {}) } as Tool, report: { tool: name, target: layer.target, strict, violations, mastra, wire } };
}

export function adaptTools(tools: ToolSet, model: ModelInformation, report: SchemaAdaptation[]): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([n, t]) => { const a = adaptTool(n, t, model); if (a.report) report.push(a.report); return [n, a.tool]; })) as ToolSet;
}
