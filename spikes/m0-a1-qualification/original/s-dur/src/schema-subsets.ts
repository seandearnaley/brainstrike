// G1: validators for the provider-documented JSON Schema subsets (host code; used by the tool adapter and the tests).
//
// OpenAI Structured Outputs / strict function calling — https://developers.openai.com/api/docs/guides/structured-outputs
//   ("Supported schemas", accessed 2026-10-01; copy saved in research/docs/openai-structured-outputs.md:3576-3990):
//   types String/Number/Boolean/Integer/Object/Array/Enum/anyOf; string: pattern, format ∈ {date-time,time,date,duration,
//   email,hostname,ipv4,ipv6,uuid}; number: multipleOf, maximum, exclusiveMaximum, minimum, exclusiveMinimum; array:
//   minItems, maxItems; root must be an object and not anyOf; all fields required; additionalProperties:false in every
//   object; ≤5000 properties, ≤10 nesting levels, ≤1000 enum values; not supported: allOf, not, dependentRequired,
//   dependentSchemas, if/then/else; definitions ($defs/$ref) and recursion supported. `const` is implied by the
//   "const values" size limit. Anything else (e.g. default, propertyNames, oneOf, $schema, x-*) is treated as unsupported:
//   "call the API with an unsupported JSON Schema, you will receive an error".
//
// Gemini — https://ai.google.dev/api/generate-content (accessed 2026-10-01; copy in research/docs/gemini-generate-content.html):
//   (a) `Schema` = "a select subset of an OpenAPI 3.0 schema object": type (single Type: STRING|NUMBER|INTEGER|BOOLEAN|
//       ARRAY|OBJECT|NULL), format, title, description, nullable, enum ([string]), maxItems, minItems, properties, required,
//       minProperties, maxProperties, minLength, maxLength, pattern, example, anyOf, propertyOrdering, default, items,
//       minimum, maximum.
//   (b) the JSON-Schema form (`parametersJsonSchema` / `responseJsonSchema`; @ai-sdk/google 4.0.87 sends tools as
//       `parametersJsonSchema`): "only the following properties are supported": $id, $defs, $ref, $anchor, type, format,
//       title, description, enum (strings and numbers), items, prefixItems, minItems, maxItems, minimum, maximum, anyOf,
//       oneOf, properties, additionalProperties, required (+ non-standard propertyOrdering).
type S = Record<string, any>;
export interface Violation { path: string; rule: string }

const OPENAI_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);
const OPENAI_KEYWORDS = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'const', '$ref', '$defs', 'definitions',
  'pattern', 'format', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'minItems', 'maxItems']);
const OPENAI_TYPES = new Set(['string', 'number', 'boolean', 'integer', 'object', 'array', 'null']);

export function validateOpenAIStrict(root: S): Violation[] {
  const v: Violation[] = [];
  let props = 0; let enums = 0;
  if (root.type !== 'object' || root.anyOf) v.push({ path: '#', rule: 'root must be an object and not anyOf' });
  const walk = (s: S, path: string, depth: number) => {
    if (typeof s !== 'object' || s === null) return;
    for (const k of Object.keys(s)) if (!OPENAI_KEYWORDS.has(k)) v.push({ path, rule: `unsupported keyword "${k}"` });
    const types = Array.isArray(s.type) ? s.type : s.type !== undefined ? [s.type] : [];
    for (const t of types) if (!OPENAI_TYPES.has(t)) v.push({ path, rule: `unsupported type "${t}"` });
    if (s.type === undefined && !s.anyOf && !s.$ref && !s.enum && !('const' in s)) v.push({ path, rule: 'node has no type/anyOf/$ref/enum/const' });
    if (s.format !== undefined && !OPENAI_FORMATS.has(s.format)) v.push({ path, rule: `unsupported string format "${s.format}"` });
    if (Array.isArray(s.enum)) enums += s.enum.length;
    const isObj = types.includes('object') || s.properties !== undefined;
    if (isObj) {
      if (depth > 10) v.push({ path, rule: 'more than 10 levels of object nesting' });
      if (s.additionalProperties !== false) v.push({ path, rule: 'object without additionalProperties:false' });
      const keys = Object.keys(s.properties ?? {});
      props += keys.length;
      const req: string[] = Array.isArray(s.required) ? s.required : [];
      for (const key of keys) if (!req.includes(key)) v.push({ path: `${path}/properties/${key}`, rule: 'property not in required' });
      for (const key of keys) walk(s.properties[key], `${path}/properties/${key}`, depth + 1);
    }
    if (s.items !== undefined) { if (Array.isArray(s.items)) v.push({ path, rule: 'tuple items' }); else walk(s.items, `${path}/items`, depth); }
    if (Array.isArray(s.anyOf)) s.anyOf.forEach((b: S, i: number) => walk(b, `${path}/anyOf/${i}`, depth));
    for (const d of ['$defs', 'definitions']) if (s[d]) for (const [n, b] of Object.entries(s[d] as S)) walk(b as S, `${path}/${d}/${n}`, depth);
  };
  walk(root, '#', 1);
  if (props > 5000) v.push({ path: '#', rule: 'more than 5000 properties' });
  if (enums > 1000) v.push({ path: '#', rule: 'more than 1000 enum values' });
  return v;
}

const GEMINI_OPENAPI_KEYWORDS = new Set(['type', 'format', 'title', 'description', 'nullable', 'enum', 'maxItems', 'minItems', 'properties', 'required', 'minProperties', 'maxProperties',
  'minLength', 'maxLength', 'pattern', 'example', 'anyOf', 'propertyOrdering', 'default', 'items', 'minimum', 'maximum']);
const GEMINI_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);
const GEMINI_JSON_KEYWORDS = new Set(['$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum',
  'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required', 'propertyOrdering']);

function walkKeywords(root: S, allowed: Set<string>, extra: (s: S, path: string, v: Violation[]) => void): Violation[] {
  const v: Violation[] = [];
  const walk = (s: S, path: string) => {
    if (typeof s !== 'object' || s === null) return;
    for (const k of Object.keys(s)) if (!allowed.has(k)) v.push({ path, rule: `unsupported keyword "${k}"` });
    extra(s, path, v);
    for (const [key, p] of Object.entries((s.properties ?? {}) as S)) walk(p, `${path}/properties/${key}`);
    if (s.items && !Array.isArray(s.items)) walk(s.items, `${path}/items`);
    for (const c of ['anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(s[c])) s[c].forEach((b: S, i: number) => walk(b, `${path}/${c}/${i}`));
    if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, `${path}/additionalProperties`);
    if (s.$defs) for (const [n, b] of Object.entries(s.$defs as S)) walk(b as S, `${path}/$defs/${n}`);
  };
  walk(root, '#');
  return v;
}
/** Gemini `Schema` (OpenAPI 3.0 subset) */
export function validateGeminiOpenAPISubset(root: S): Violation[] {
  return walkKeywords(root, GEMINI_OPENAPI_KEYWORDS, (s, path, v) => {
    if (s.type !== undefined && (typeof s.type !== 'string' || !GEMINI_TYPES.has(s.type))) v.push({ path, rule: `type must be one Type enum value, got ${JSON.stringify(s.type)}` });
    if (Array.isArray(s.enum) && s.enum.some((e: unknown) => typeof e !== 'string')) v.push({ path, rule: 'enum values must be strings' });
  });
}
/** Gemini JSON-Schema form (`parametersJsonSchema`) */
export function validateGeminiJsonSchemaSubset(root: S): Violation[] {
  return walkKeywords(root, GEMINI_JSON_KEYWORDS, (s, path, v) => {
    if (Array.isArray(s.enum) && s.enum.some((e: unknown) => typeof e !== 'string' && typeof e !== 'number')) v.push({ path, rule: 'enum values must be strings or numbers' });
  });
}
