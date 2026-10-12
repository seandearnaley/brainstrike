// PORTED from @mastra/schema-compat 1.3.13 (Apache-2.0, (c) Mastra; the version @mastra/core 1.73.0 depends on).
// Sources (recovered from the package's dist/index.js.map sourcesContent, saved under research/src/eng/schema-compat-1.3.13/):
//   schema-compatibility.ts:343-363  processToJSONSchema (zod ~standard.jsonSchema.input + json-schema-traverse pre/post)
//   schema-compatibility.ts:391-605  defaultObject/Array/String/Number/Union/AllOf handlers
//   schema-compatibility-v3.ts:351-360 mergeParameterDescription
//   standard-schema/standard-schema.ts jsonSchemaOverride + JSON_SCHEMA_LIBRARY_OPTIONS ({unrepresentable:'any'})
//   provider-compats/openai.ts:22-103,105-128,267-466,468-551  (OpenAI: shouldApply, pre/post hooks, value traverse)
//   provider-compats/openai-reasoning.ts:22-41 (o1/o3/o4: same JSON hooks as OpenAI, different shouldApply)
//   provider-compats/anthropic.ts:33-83,159-180 (root object-union merge, pre/post hooks)
//   provider-compats/google.ts:107-185,188-200,243-247,287-397,399-447 (inline $refs, pre/post hooks, value traverse)
// Only the JSON-Schema path is ported: Mastra 1.73 CoreToolBuilder.build() (dist/utils-D5sDE7tv.js:676-703) takes it for
// every schema implementing StandardSchemaWithJSON, which includes all zod>=4.2 schemas (Brainstrike's). The zod-type
// rewriting path (processZodType, zod v3 only), the claude-3.5-haiku string-length strip, patchRecordSchemas (a zod-v3
// single-arg z.record fix, a no-op for zod 4) and the DeepSeek/Meta layers are NOT ported.
import traverse from 'json-schema-traverse';
import type { z } from 'zod';

type S = Record<string, any>;
export interface ModelInformation { provider: string; modelId: string }
export type CompatTarget = 'openai' | 'openai-reasoning' | 'google' | 'anthropic' | 'none';

// ---------- base (schema-compatibility.ts) ----------
const mergeParameterDescription = (description: string | undefined, constraints: string[]) =>
  constraints.length > 0 ? (description ? description + '\n' : '') + `constraints: ${constraints.join(', ')}` : description;

/** standard-schema.ts jsonSchemaOverride (zod 4 branch) */
function jsonSchemaOverride(ctx: { zodSchema: any; jsonSchema: S }) {
  const zodSchema = ctx.zodSchema;
  if (ctx.jsonSchema.type === 'object' && ctx.jsonSchema.properties !== undefined && !ctx.jsonSchema.additionalProperties) ctx.jsonSchema.additionalProperties = false;
  if (zodSchema) {
    if (zodSchema?.type === 'date' || zodSchema?._def?.typeName === 'ZodDate') {
      if (zodSchema?.type === 'date') { ctx.jsonSchema.type = 'string'; ctx.jsonSchema.format = 'date-time'; }
      ctx.jsonSchema['x-date'] = !zodSchema._zod?.def?.coerce;
    } else if (zodSchema?.type === 'object' && zodSchema._zod?.def?.catchall?.type === 'unknown') ctx.jsonSchema.additionalProperties = true;
  }
}

/** standardSchemaToJSONSchema(toStandardSchema(zod4), { target: 'draft-07', io }) */
export function zodToDraft07(schema: z.ZodType, io: 'input' | 'output' = 'input'): S {
  const std = (schema as any)['~standard'];
  if (!std?.jsonSchema?.[io]) throw new Error('schema-compat: expected a zod>=4.2 schema with ~standard.jsonSchema');
  return JSON.parse(JSON.stringify(std.jsonSchema[io]({ target: 'draft-07', libraryOptions: { unrepresentable: 'any', override: jsonSchemaOverride } })));
}

const hasType = (s: S, t: string) => s.type === t || (Array.isArray(s.type) && s.type.includes(t));
const isObjectSchema = (s: S) => hasType(s, 'object') || s.properties !== undefined;
const isArraySchema = (s: S) => hasType(s, 'array') || s.items !== undefined;
const isStringSchema = (s: S) => hasType(s, 'string');
const isNumberSchema = (s: S) => hasType(s, 'number') || hasType(s, 'integer');
const isUnionSchema = (s: S) => (Array.isArray(s.anyOf) && s.anyOf.length > 0) || (Array.isArray(s.oneOf) && s.oneOf.length > 0) || Array.isArray(s.type);
const isAllOfSchema = (s: S) => Array.isArray(s.allOf) && s.allOf.length > 0;

function defaultObjectHandler(s: S) {
  if (s.properties && s.additionalProperties === undefined) s.additionalProperties = false;
  if (!Object.keys(s.properties ?? {}).length) s.required = [];
}
function defaultArrayHandler(s: S) {
  let constraints: string[] = [];
  const { minItems, maxItems } = s;
  if (minItems !== undefined && maxItems !== undefined && minItems === maxItems) { constraints = [`exact length ${minItems}`]; delete s.minItems; delete s.maxItems; }
  else {
    if (minItems !== undefined) { constraints.push(`minimum length ${minItems}`); delete s.minItems; }
    if (maxItems !== undefined) { constraints.push(`maximum length ${maxItems}`); delete s.maxItems; }
  }
  if (constraints.length) s.description = mergeParameterDescription(s.description, constraints);
}
function defaultStringHandler(s: S) {
  const constraints: string[] = [];
  if (s.minLength !== undefined) { constraints.push(`minimum length ${s.minLength}`); delete s.minLength; }
  if (s.maxLength !== undefined) { constraints.push(`maximum length ${s.maxLength}`); delete s.maxLength; }
  switch (s.format) {
    case 'email': case 'emoji': case 'uri': case 'uuid': case 'date-time': case 'date': case 'time':
      constraints.push(`a valid ${s.format}`); delete s.pattern; delete s.format; break;
  }
  if (constraints.length === 0 && s.pattern !== undefined) { constraints.push(`input must match this regex ${s.pattern}`); delete s.pattern; }
  if (constraints.length) s.description = mergeParameterDescription(s.description, constraints);
}
function defaultNumberHandler(s: S) {
  const constraints: string[] = [];
  if (s.minimum !== undefined) { if (s.minimum !== Number.MIN_SAFE_INTEGER) constraints.push(`greater than or equal to ${s.minimum}`); delete s.minimum; }
  if (s.maximum !== undefined) { if (s.maximum !== Number.MAX_SAFE_INTEGER) constraints.push(`lower than or equal to ${s.maximum}`); delete s.maximum; }
  if (s.exclusiveMinimum !== undefined) { constraints.push(`greater than ${s.exclusiveMinimum}`); delete s.exclusiveMinimum; }
  if (s.exclusiveMaximum !== undefined) { constraints.push(`lower than ${s.exclusiveMaximum}`); delete s.exclusiveMaximum; }
  if (s.multipleOf !== undefined) { constraints.push(`multiple of ${s.multipleOf}`); delete s.multipleOf; }
  if (constraints.length) s.description = mergeParameterDescription(s.description, constraints);
}
function defaultAllOfHandler(s: S) {
  if (!Array.isArray(s.allOf)) return;
  const mergedProperties: S = {}; const mergedRequired: string[] = [];
  for (const sub of s.allOf as S[]) { if (sub.properties) Object.assign(mergedProperties, sub.properties); if (Array.isArray(sub.required)) mergedRequired.push(...sub.required); }
  delete s.allOf; s.type = 'object'; s.properties = mergedProperties;
  if (mergedRequired.length > 0) s.required = [...new Set(mergedRequired)];
  s.additionalProperties = false;
}

abstract class Layer {
  constructor(readonly model: ModelInformation) {}
  abstract shouldApply(): boolean;
  abstract readonly target: CompatTarget;
  preProcessJSONNode(_s: S) {}
  postProcessJSONNode(_s: S) {}
  /** defaultUnionHandler: re-runs the hooks on each anyOf branch (as Mastra does); a 1-branch collapse only rebinds a local */
  protected defaultUnionHandler(s: S) {
    if (Array.isArray(s.anyOf)) s.anyOf = s.anyOf.map((sub: unknown) => { if (typeof sub !== 'object' || sub === null) return false; this.preProcessJSONNode(sub as S); this.postProcessJSONNode(sub as S); return sub; }).filter(Boolean);
  }
  processToJSONSchema(schema: z.ZodType, io: 'input' | 'output' = 'input'): S {
    const json = zodToDraft07(schema, io);
    traverse(json, { cb: { pre: (n: S) => this.preProcessJSONNode(n), post: (n: S) => this.postProcessJSONNode(n) } } as never);
    return json;
  }
  /** value-side transform applied before validating against the ORIGINAL schema */
  transformValue(value: unknown, _json: S): unknown { return value; }
}

// ---------- OpenAI (provider-compats/openai.ts) ----------
const allowedStringFormats = ['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid'];
function unorderedArraysEqual(l: unknown[], r: unknown[], eq: (a: unknown, b: unknown) => boolean) {
  if (l.length !== r.length) return false;
  const matched = new Set<number>();
  return l.every((li) => { const i = r.findIndex((ri, idx) => !matched.has(idx) && eq(li, ri)); if (i === -1) return false; matched.add(i); return true; });
}
function jsonValuesEqual(l: unknown, r: unknown): boolean {
  if (Object.is(l, r)) return true;
  if (Array.isArray(l) || Array.isArray(r)) return Array.isArray(l) && Array.isArray(r) && l.length === r.length && l.every((v, i) => jsonValuesEqual(v, r[i]));
  if (!l || !r || typeof l !== 'object' || typeof r !== 'object') return false;
  const le = Object.entries(l); const rr = r as S;
  return le.length === Object.keys(rr).length && le.every(([k, v]) => Object.prototype.hasOwnProperty.call(rr, k) && jsonValuesEqual(v, rr[k]));
}
function schemaValuesEqual(l: unknown, r: unknown, keyword?: string): boolean {
  if (keyword === 'const' || keyword === 'default' || keyword === 'example' || keyword === 'examples') return jsonValuesEqual(l, r);
  if (Object.is(l, r)) return true;
  if (Array.isArray(l) || Array.isArray(r)) {
    if (!Array.isArray(l) || !Array.isArray(r)) return false;
    if (keyword === 'required' || keyword === 'type') return unorderedArraysEqual(l, r, Object.is);
    if (keyword === 'enum') return unorderedArraysEqual(l, r, jsonValuesEqual);
    if (keyword === 'allOf' || keyword === 'anyOf' || keyword === 'oneOf') return unorderedArraysEqual(l, r, (a, b) => schemaValuesEqual(a, b));
    return l.length === r.length && l.every((v, i) => schemaValuesEqual(v, r[i]));
  }
  if (!l || !r || typeof l !== 'object' || typeof r !== 'object') return false;
  const le = Object.entries(l); const rr = r as S;
  return le.length === Object.keys(rr).length && le.every(([k, v]) => Object.prototype.hasOwnProperty.call(rr, k) && schemaValuesEqual(v, rr[k], k));
}
const isReasoningModelId = (id: string) => id.includes('o3') || id.includes('o4') || id.includes('o1');

export class OpenAILayer extends Layer {
  readonly target: CompatTarget = 'openai';
  shouldApply() { const m = this.model; return !isReasoningModelId(m.modelId ?? '') && (m.provider.includes('openai') || m.modelId?.includes('openai') || m.provider.includes('groq')); }
  override preProcessJSONNode(s: S) {
    if (isAllOfSchema(s)) defaultAllOfHandler(s);
    if (isObjectSchema(s)) defaultObjectHandler(s);
    else if (isArraySchema(s)) defaultArrayHandler(s);
    else if (isNumberSchema(s)) defaultNumberHandler(s);
    else if (isStringSchema(s)) {
      if (s.format && !allowedStringFormats.includes(s.format)) { delete s.format; delete s.pattern; }
      defaultStringHandler(s);
    }
  }
  override postProcessJSONNode(schema: S) {
    if (isUnionSchema(schema)) this.defaultUnionHandler(schema);
    if (schema.type === undefined && !schema.anyOf) {
      const sub: S = {};
      for (const k of Object.keys(schema)) { sub[k] = schema[k]; delete schema[k]; }
      schema.anyOf = [sub, { type: 'null' }];
    }
    if (!isObjectSchema(schema)) return;
    schema.additionalProperties = false;
    delete schema.propertyNames;
    if (!schema.properties) return;
    for (const key of Object.keys(schema.properties)) {
      const prop = schema.properties[key] as S;
      if (!schema.required) schema.required = [];
      if (schema.required.includes(key)) continue;
      schema['x-optional'] = [...(schema['x-optional'] || []), key];
      schema.required.push(key);
      const objectKeywords = ['properties', 'required', 'additionalProperties', 'x-optional'];
      const arrayKeywords = ['items'];
      const numericKeywords = ['format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
      const isNumericType = (t: unknown) => t === 'integer' || t === 'number';
      const genericConstraintKeywords = ['const', 'enum', 'oneOf', 'not', 'if', 'then', 'else'];
      const branchConstraintKeywords = ['anyOf', 'oneOf', 'not', 'if', 'then', 'else'];
      const typeSpecificKeywords = (t: unknown) => (t === 'object' ? objectKeywords : t === 'array' ? arrayKeywords : []);
      const isRedundantNullableUnion = (t: unknown) => {
        if (!prop.anyOf || prop.anyOf.length !== 2) return false;
        const nulls = prop.anyOf.filter((b: any) => typeof b !== 'boolean' && b.type === 'null');
        const vals = prop.anyOf.filter((b: any) => typeof b !== 'boolean' && b.type !== 'null');
        if (nulls.length !== 1 || vals.length !== 1) return false;
        const vb = vals[0] as S;
        if (vb.type !== t) return false;
        return Object.entries(vb).every(([kw, v]) => kw === 'type' || (kw in prop && schemaValuesEqual(prop[kw], v, kw)));
      };
      if (Array.isArray(prop.type)) {
        const types = [...prop.type]; if (!types.includes('null')) types.push('null');
        const branchConstraints: S = {};
        for (const kw of branchConstraintKeywords) if (kw in prop) { branchConstraints[kw] = prop[kw]; delete prop[kw]; }
        delete prop.type;
        if ('const' in prop) { const c = prop.const; const ok = !prop.enum || prop.enum.some((v: unknown) => jsonValuesEqual(v, c)); prop.enum = ok ? [c, null] : [null]; delete prop.const; }
        else if (prop.enum && !prop.enum.includes(null)) prop.enum = [...prop.enum, null];
        prop.anyOf = types.map((type: string) => {
          if (type === 'null') return { type: 'null' };
          const branch: S = { type };
          const numericFormat = typeof prop.format === 'string' && ['int32', 'int64', 'float', 'double'].includes(prop.format);
          const formatOwner = types.includes('string') && !numericFormat ? type === 'string' : isNumericType(type);
          for (const kw of [...typeSpecificKeywords(type), ...(isNumericType(type) ? numericKeywords.filter((k) => k !== 'format') : []), ...(formatOwner ? ['format'] : [])]) if (kw in prop) branch[kw] = prop[kw];
          return Object.assign(branch, branchConstraints);
        });
        const numericBranchExists = types.some(isNumericType);
        for (const kw of [...objectKeywords, ...arrayKeywords, ...(numericBranchExists ? numericKeywords : [])]) delete prop[kw];
      } else if (prop.type && prop.type !== 'null') {
        const originalType = prop.type;
        const keywords = typeSpecificKeywords(originalType);
        if (keywords.length > 0) {
          const branch: S = { type: originalType };
          const preserveAnyOf = prop.anyOf && !isRedundantNullableUnion(originalType) ? prop.anyOf : undefined;
          for (const kw of [...keywords, ...genericConstraintKeywords]) if (kw in prop) { branch[kw] = prop[kw]; delete prop[kw]; }
          if (preserveAnyOf) branch.anyOf = preserveAnyOf;
          delete prop.type;
          prop.anyOf = [branch, { type: 'null' }];
        } else {
          const propSchema: S = { ...prop, type: originalType };
          if (isRedundantNullableUnion(originalType)) delete propSchema.anyOf;
          for (const kw of [...genericConstraintKeywords, 'anyOf']) delete prop[kw];
          if (isNumericType(originalType)) for (const kw of numericKeywords) delete prop[kw];
          delete prop.type;
          prop.anyOf = [propSchema, { type: 'null' }];
        }
      }
    }
  }
  /** openai.ts #traverse: null -> undefined for x-optional keys, date strings -> Date, recursing through anyOf variants */
  override transformValue(value: unknown, schema: S): unknown {
    const resolved = openaiResolveAnyOf(schema, value);
    if ((resolved.format === 'date-time' || resolved.format === 'date' || resolved['x-date'] === true) && typeof value === 'string') return new Date(value);
    const isArr = resolved.type === 'array' || (Array.isArray(resolved.type) && resolved.type.includes('array'));
    if (isArr) return Array.isArray(value) ? value.map((v) => this.transformValue(v, resolved.items as S)) : value;
    const isObj = resolved.type === 'object' || (Array.isArray(resolved.type) && resolved.type.includes('object'));
    if (!isObj) return value;
    const properties = resolved.properties as Record<string, S> | undefined;
    if (!properties || !value) return value;
    const obj = value as S;
    const optional = (resolved['x-optional'] ?? []) as string[];
    for (const key in obj) {
      if (optional.includes(key) && obj[key] === null) obj[key] = undefined;
      else if (properties[key]) obj[key] = this.transformValue(obj[key], properties[key]);
    }
    return obj;
  }
}
function openaiResolveAnyOf(schema: S, value?: unknown): S {
  if (!Array.isArray(schema.anyOf)) return schema;
  const nonNull = (schema.anyOf as S[]).filter((s) => s && s.type !== 'null');
  const vt = Array.isArray(value) ? 'array' : value !== null && typeof value === 'object' ? 'object' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value === 'string' || typeof value === 'boolean' ? typeof value : undefined;
  if (vt) {
    const has = (v: S, t: string) => (Array.isArray(v.type) ? v.type : [v.type]).includes(t);
    const exact = nonNull.find((v) => has(v, vt)); if (exact) return { ...schema, ...exact };
    if (vt === 'integer') { const n = nonNull.find((v) => has(v, 'number')); if (n) return { ...schema, ...n }; }
  }
  return nonNull[0] ? { ...schema, ...nonNull[0] } : schema;
}
export class OpenAIReasoningLayer extends OpenAILayer {
  override readonly target: CompatTarget = 'openai-reasoning';
  override shouldApply() { const m = this.model; return isReasoningModelId(m.modelId ?? '') && (m.provider.includes('openai') || m.modelId?.includes('openai')); }
}

// ---------- Anthropic (provider-compats/anthropic.ts) ----------
export class AnthropicLayer extends Layer {
  readonly target: CompatTarget = 'anthropic';
  shouldApply() { return this.model.modelId.includes('claude'); }
  override processToJSONSchema(schema: z.ZodType, io: 'input' | 'output' = 'input'): S {
    const json = super.processToJSONSchema(schema, io);
    const union = json.anyOf ?? json.oneOf;
    if (io !== 'input' || !Array.isArray(union)) return json;
    const objs = union.filter((s: any) => typeof s === 'object' && s !== null && s.type === 'object') as S[];
    if (objs.length === 0 || objs.length !== union.length) return json;
    delete json.anyOf; delete json.oneOf; json.type = 'object';
    const merged: Record<string, unknown[]> = {};
    for (const sub of objs) for (const [k, p] of Object.entries(sub.properties ?? {})) { const vs = (merged[k] ??= []); if (!vs.some((e) => JSON.stringify(e) === JSON.stringify(p))) vs.push(p); }
    json.properties = Object.fromEntries(Object.entries(merged).map(([k, vs]) => [k, vs.length === 1 ? vs[0] : { anyOf: vs }]));
    json.required = objs.map((s) => (s.required ?? []) as string[]).reduce((req, br) => req.filter((k) => br.includes(k)));
    json.additionalProperties = false;
    return json;
  }
  override preProcessJSONNode(s: S) {
    if (isAllOfSchema(s)) defaultAllOfHandler(s);
    if (isObjectSchema(s)) defaultObjectHandler(s);
    else if (isArraySchema(s)) defaultArrayHandler(s);
    else if (isNumberSchema(s)) defaultNumberHandler(s);
    else if (isStringSchema(s)) defaultStringHandler(s);
  }
  override postProcessJSONNode(s: S) { if (isUnionSchema(s)) this.defaultUnionHandler(s); }
  override transformValue(value: unknown, schema: S) { return dateTraverse(value, schema, (s, v) => anthropicResolve(s, v)); }
}
/** anthropic.ts #resolveSchemaForValue (structural match of the value against anyOf branches) — simplified: first branch whose type matches */
function anthropicResolve(schema: S, value: unknown): S {
  const branches = (schema.anyOf ?? schema.oneOf) as S[] | undefined;
  if (!Array.isArray(branches)) return schema;
  const vt = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value === 'object' ? 'object' : typeof value;
  return branches.find((b) => b && (b.type === vt || (vt === 'number' && b.type === 'integer'))) ?? schema;
}
/** google.ts / anthropic.ts #traverse: only x-date strings -> Date */
function dateTraverse(value: unknown, schema: S, resolve: (s: S, v: unknown) => S): unknown {
  const r = resolve(schema, value);
  if (r['x-date'] === true && typeof value === 'string') return new Date(value);
  if (r.type === 'array' || (Array.isArray(r.type) && r.type.includes('array'))) return Array.isArray(value) ? value.map((v) => dateTraverse(v, r.items as S, resolve)) : value;
  if (!(r.type === 'object' || (Array.isArray(r.type) && r.type.includes('object')))) return value;
  const props = r.properties as Record<string, S> | undefined;
  if (!props || !value) return value;
  const obj = value as S;
  for (const k in obj) if (props[k]) obj[k] = dateTraverse(obj[k], props[k], resolve);
  return obj;
}

// ---------- Google (provider-compats/google.ts) ----------
function inlineRefsAndDropDefinitions(schema: S): void {
  const json = JSON.stringify(schema);
  if (!json.includes('"$ref"')) return;
  const defs = (schema.definitions ?? schema.$defs) as Record<string, S> | undefined;
  const snapshot = JSON.parse(json) as S;
  const snapshotDefs = (snapshot.definitions ?? snapshot.$defs) as Record<string, S> | undefined;
  resolveRefs(schema, snapshot, snapshotDefs ?? defs ?? {}, new Set());
  delete schema.definitions; delete schema.$defs;
}
function resolveRefs(node: S, root: S, defs: Record<string, S>, visiting: Set<string>): void {
  if (typeof node !== 'object' || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      const resolved = value === '#' ? root : (() => { const m = value.match(/^#\/(?:definitions|\$defs)\/(.+)$/); return m ? defs[m[1]!] : undefined; })();
      if (!resolved || visiting.has(value)) { delete node.$ref; node.type = 'object'; }
      else { delete node.$ref; visiting.add(value); const clone = JSON.parse(JSON.stringify(resolved)) as S; resolveRefs(clone, root, defs, visiting); visiting.delete(value); Object.assign(node, clone); }
    } else if (Array.isArray(value)) { for (const item of value) if (typeof item === 'object' && item !== null) resolveRefs(item, root, defs, visiting); }
    else if (typeof value === 'object' && value !== null) resolveRefs(value as S, root, defs, visiting);
  }
}
export class GoogleLayer extends Layer {
  readonly target: CompatTarget = 'google';
  shouldApply() { const m = this.model; if (m.modelId.includes('claude')) return false; return m.provider.includes('google') || m.modelId.includes('gemini-') || m.modelId.includes('google'); }
  override processToJSONSchema(schema: z.ZodType, io?: 'input' | 'output'): S { const r = super.processToJSONSchema(schema, io); inlineRefsAndDropDefinitions(r); return r; }
  override preProcessJSONNode(s: S) {
    if (isAllOfSchema(s)) defaultAllOfHandler(s);
    if (isObjectSchema(s)) defaultObjectHandler(s);
    else if (isNumberSchema(s)) defaultNumberHandler(s);
    else if (isArraySchema(s)) defaultArrayHandler(s);
    else if (isStringSchema(s)) defaultStringHandler(s);
  }
  override postProcessJSONNode(s: S) {
    if (isUnionSchema(s)) this.defaultUnionHandler(s);
    delete s.$schema; delete s.additionalProperties; delete s.propertyNames;
    if (Array.isArray(s.type)) {
      const types = s.type as string[]; const nonNull = types.filter((t) => t !== 'null'); const hasNull = types.includes('null');
      if (nonNull.length === 1) { s.type = nonNull[0]; if (hasNull) s.nullable = true; }
      else if (nonNull.length === 0 && hasNull) { s.type = 'object'; s.nullable = true; }
      else { delete s.type; s.anyOf = nonNull.map((t) => ({ type: t })); if (hasNull) s.nullable = true; }
    }
    if (Array.isArray(s.oneOf)) { s.anyOf = s.oneOf; delete s.oneOf; }
    if ('const' in s) { s.enum = [s.const]; delete s.const; }
    if (Array.isArray(s.items)) { s.items = { anyOf: s.items }; delete s.minItems; delete s.maxItems; }
    if (Array.isArray(s.anyOf)) {
      const variants = s.anyOf as S[];
      const nonNull = variants.filter((v) => v && typeof v === 'object' && v.type !== 'null');
      const hasNull = variants.some((v) => v && typeof v === 'object' && v.type === 'null');
      if (hasNull && nonNull.length === 1) { const base = nonNull[0]!; delete s.anyOf; Object.assign(s, base); s.nullable = true; }
      else if (hasNull && nonNull.length > 1) { s.anyOf = nonNull; s.nullable = true; }
    }
    if (!s.type && !s.anyOf && !s.oneOf && !s.allOf && !s.$ref && !s.enum && !s.const && !s.properties && !s.items) {
      const prims = ['string', 'number', 'integer', 'boolean', 'object'];
      s.anyOf = [...prims.map((t) => ({ type: t })), { type: 'array', items: { anyOf: prims.map((t) => ({ type: t })) } }];
      s.nullable = true;
    }
  }
  override transformValue(value: unknown, schema: S) { return dateTraverse(value, schema, (s) => (Array.isArray(s.anyOf) ? ((s.anyOf as S[]).find((x) => x.type !== 'null') ?? s) : s)); }
}

/** Mastra's layer order (CoreToolBuilder.build): the FIRST layer whose shouldApply() is true wins. DeepSeek/Meta not ported. */
export function selectLayer(model: ModelInformation): Layer | undefined {
  return [new OpenAIReasoningLayer(model), new OpenAILayer(model), new GoogleLayer(model), new AnthropicLayer(model)].find((l) => l.shouldApply());
}
export type { Layer };
